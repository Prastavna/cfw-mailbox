import { DurableObject } from "cloudflare:workers";
import { and, asc, eq } from "drizzle-orm";
import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import type { Domain, Mailbox, MailboxAccess, MailboxRole, Member } from "../../shared/api";
import { domainOf, normalizeAddress, normalizeDomain } from "../../shared/address";
import { runMigrations } from "../lib/migrate";
import { domains, mailboxes, mailboxMembers, REGISTRY_MIGRATIONS } from "./schema";

/**
 * Errors that cross the RPC boundary arrive as plain `Error`s, so expected
 * failures are returned as values instead of thrown.
 */
export type Result<T> = { ok: true; value: T } | { ok: false; code: "conflict" | "not_found" | "invalid"; message: string };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });

/**
 * The single, global directory: which domains this install serves, which
 * mailboxes exist, and who may open each one. Always addressed by the name
 * "global" (see `getRegistry`).
 *
 * Expects already-validated input; validation lives in the API layer.
 */
export class RegistryDO extends DurableObject<Env> {
	private db: DrizzleSqliteDODatabase;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.db = drizzle(ctx.storage);
		ctx.blockConcurrencyWhile(async () => runMigrations(ctx.storage, REGISTRY_MIGRATIONS));
	}

	// ---- Domains ---------------------------------------------------------

	async listDomains(): Promise<Domain[]> {
		return this.db.select().from(domains).orderBy(asc(domains.domain)).all();
	}

	async addDomain(rawDomain: string): Promise<Result<Domain>> {
		const domain = normalizeDomain(rawDomain);
		const row = this.db.insert(domains).values({ domain, createdAt: Date.now() }).onConflictDoNothing().returning().get();
		return row ? ok(row) : { ok: false, code: "conflict", message: `Domain ${domain} already exists` };
	}

	async removeDomain(rawDomain: string): Promise<Result<null>> {
		const domain = normalizeDomain(rawDomain);
		const inUse = this.db.select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.domain, domain)).limit(1).get();
		if (inUse) return { ok: false, code: "conflict", message: `Domain ${domain} still has mailboxes` };
		const deleted = this.db.delete(domains).where(eq(domains.domain, domain)).returning().get();
		return deleted ? ok(null) : { ok: false, code: "not_found", message: `Domain ${domain} not found` };
	}

	// ---- Mailboxes -------------------------------------------------------

	async listMailboxes(): Promise<Mailbox[]> {
		return this.db.select().from(mailboxes).orderBy(asc(mailboxes.domain), asc(mailboxes.address)).all();
	}

	async getMailbox(id: string): Promise<Mailbox | null> {
		return this.db.select().from(mailboxes).where(eq(mailboxes.id, id)).get() ?? null;
	}

	/** Which mailbox receives mail sent to this address, if any. */
	async resolveAddress(rawAddress: string): Promise<Mailbox | null> {
		return this.db.select().from(mailboxes).where(eq(mailboxes.address, normalizeAddress(rawAddress))).get() ?? null;
	}

	async createMailbox(input: { address: string; displayName: string; ownerEmail?: string }): Promise<Result<Mailbox>> {
		const address = normalizeAddress(input.address);
		const domain = domainOf(address);
		if (!this.db.select().from(domains).where(eq(domains.domain, domain)).get()) {
			return { ok: false, code: "invalid", message: `Add the domain ${domain} before creating mailboxes on it` };
		}

		const now = Date.now();
		const row = { id: crypto.randomUUID(), address, domain, displayName: input.displayName.trim(), createdAt: now };
		const created = this.ctx.storage.transactionSync(() => {
			const inserted = this.db.insert(mailboxes).values(row).onConflictDoNothing().returning().get();
			if (inserted && input.ownerEmail) {
				this.db
					.insert(mailboxMembers)
					.values({ mailboxId: row.id, userEmail: normalizeAddress(input.ownerEmail), role: "owner", createdAt: now })
					.run();
			}
			return inserted;
		});
		return created ? ok(created) : { ok: false, code: "conflict", message: `Mailbox ${address} already exists` };
	}

	async deleteMailbox(id: string): Promise<Result<null>> {
		const deleted = this.db.delete(mailboxes).where(eq(mailboxes.id, id)).returning().get();
		return deleted ? ok(null) : { ok: false, code: "not_found", message: "Mailbox not found" };
	}

	// ---- Membership ------------------------------------------------------

	async listMembers(mailboxId: string): Promise<Member[]> {
		return this.db
			.select()
			.from(mailboxMembers)
			.where(eq(mailboxMembers.mailboxId, mailboxId))
			.orderBy(asc(mailboxMembers.userEmail))
			.all();
	}

	async setMember(mailboxId: string, rawEmail: string, role: MailboxRole): Promise<Result<Member>> {
		if (!(await this.getMailbox(mailboxId))) return { ok: false, code: "not_found", message: "Mailbox not found" };
		const row = { mailboxId, userEmail: normalizeAddress(rawEmail), role, createdAt: Date.now() };
		const saved = this.db
			.insert(mailboxMembers)
			.values(row)
			.onConflictDoUpdate({ target: [mailboxMembers.mailboxId, mailboxMembers.userEmail], set: { role } })
			.returning()
			.get();
		return ok(saved!);
	}

	async removeMember(mailboxId: string, rawEmail: string): Promise<Result<null>> {
		const deleted = this.db
			.delete(mailboxMembers)
			.where(and(eq(mailboxMembers.mailboxId, mailboxId), eq(mailboxMembers.userEmail, normalizeAddress(rawEmail))))
			.returning()
			.get();
		return deleted ? ok(null) : { ok: false, code: "not_found", message: "Member not found" };
	}

	/** Mailboxes a user may open. Admins see every mailbox, as owner. */
	async mailboxesFor(rawEmail: string, isAdmin: boolean): Promise<MailboxAccess[]> {
		if (isAdmin) {
			return (await this.listMailboxes()).map((m) => ({ ...m, role: "owner" as const }));
		}
		return this.db
			.select({
				id: mailboxes.id,
				address: mailboxes.address,
				domain: mailboxes.domain,
				displayName: mailboxes.displayName,
				createdAt: mailboxes.createdAt,
				role: mailboxMembers.role,
			})
			.from(mailboxMembers)
			.innerJoin(mailboxes, eq(mailboxes.id, mailboxMembers.mailboxId))
			.where(eq(mailboxMembers.userEmail, normalizeAddress(rawEmail)))
			.orderBy(asc(mailboxes.domain), asc(mailboxes.address))
			.all();
	}

	/** The user's role on a mailbox, or null if they have no access. Admins are always owners. */
	async roleFor(mailboxId: string, rawEmail: string, isAdmin: boolean): Promise<MailboxRole | null> {
		if (isAdmin) return (await this.getMailbox(mailboxId)) ? "owner" : null;
		const row = this.db
			.select({ role: mailboxMembers.role })
			.from(mailboxMembers)
			.where(and(eq(mailboxMembers.mailboxId, mailboxId), eq(mailboxMembers.userEmail, normalizeAddress(rawEmail))))
			.get();
		return row?.role ?? null;
	}
}

export function getRegistry(env: Env): DurableObjectStub<RegistryDO> {
	const ns = env.REGISTRY as DurableObjectNamespace<RegistryDO>;
	return ns.get(ns.idFromName("global"));
}
