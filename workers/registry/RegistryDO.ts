import { DurableObject } from "cloudflare:workers";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import type { Domain, Mailbox, MailboxAccess, MailboxRole, Member } from "../../shared/api";
import { domainOf, normalizeAddress, normalizeDomain } from "../../shared/address";
import { runMigrations } from "../lib/migrate";
import { ok, type Result } from "../lib/result";
import { generateVapidKeys, type PushSubscriptionKeys, type VapidKeys } from "../push/webpush";
import { domains, mailboxes, mailboxMembers, pushSubscriptions, REGISTRY_MIGRATIONS, serverKeys, userExtensions } from "./schema";

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

	// ---- Extensions ------------------------------------------------------

	async listUserExtensions(rawEmail: string): Promise<Record<string, UserExtension>> {
		const rows = this.db.select().from(userExtensions).where(eq(userExtensions.userEmail, normalizeAddress(rawEmail))).all();
		return Object.fromEntries(rows.map((r) => [r.extensionId, { enabled: r.enabled, settings: r.settings, secret: r.secret }]));
	}

	async getUserExtension(rawEmail: string, extensionId: string): Promise<UserExtension | null> {
		const row = this.db
			.select()
			.from(userExtensions)
			.where(and(eq(userExtensions.userEmail, normalizeAddress(rawEmail)), eq(userExtensions.extensionId, extensionId)))
			.get();
		return row ? { enabled: row.enabled, settings: row.settings, secret: row.secret } : null;
	}

	async saveUserExtension(rawEmail: string, extensionId: string, value: UserExtension): Promise<void> {
		const row = { userEmail: normalizeAddress(rawEmail), extensionId, ...value, updatedAt: Date.now() };
		this.db
			.insert(userExtensions)
			.values(row)
			.onConflictDoUpdate({
				target: [userExtensions.userEmail, userExtensions.extensionId],
				set: { enabled: row.enabled, settings: row.settings, secret: row.secret, updatedAt: row.updatedAt },
			})
			.run();
	}

	// ---- Push notifications ------------------------------------------------

	private vapid: Promise<VapidKeys> | null = null;

	/** This install's VAPID key pair, made the first time anyone asks. */
	async vapidKeys(): Promise<VapidKeys> {
		this.vapid ??= (async () => {
			const row = this.db.select().from(serverKeys).where(eq(serverKeys.name, "vapid")).get();
			if (row) return JSON.parse(row.value) as VapidKeys;
			const keys = await generateVapidKeys();
			// Two first requests can race through the await above; keep whichever was stored first.
			this.db.insert(serverKeys).values({ name: "vapid", value: JSON.stringify(keys), createdAt: Date.now() }).onConflictDoNothing().run();
			return JSON.parse(this.db.select().from(serverKeys).where(eq(serverKeys.name, "vapid")).get()!.value) as VapidKeys;
		})();
		return this.vapid;
	}

	/**
	 * Saves a browser's subscription for `mailboxIds` (already checked against the user's
	 * access). A browser belongs to whoever subscribed it last.
	 */
	async savePushSubscription(rawEmail: string, sub: PushSubscriptionKeys, mailboxIds: string[], replaces?: string): Promise<void> {
		const now = Date.now();
		const userEmail = normalizeAddress(rawEmail);
		this.ctx.storage.transactionSync(() => {
			if (replaces && replaces !== sub.endpoint) {
				this.db
					.delete(pushSubscriptions)
					.where(and(eq(pushSubscriptions.endpoint, replaces), eq(pushSubscriptions.userEmail, userEmail)))
					.run();
			}
			if (!mailboxIds.length) {
				this.db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, sub.endpoint)).run();
				return;
			}
			const row = { ...sub, userEmail, mailboxIds: JSON.stringify(mailboxIds), createdAt: now, updatedAt: now };
			this.db
				.insert(pushSubscriptions)
				.values(row)
				.onConflictDoUpdate({
					target: pushSubscriptions.endpoint,
					set: { userEmail, p256dh: sub.p256dh, auth: sub.auth, mailboxIds: row.mailboxIds, updatedAt: now },
				})
				.run();
		});
	}

	/** This user's subscription for a browser, if it is theirs. */
	async getPushSubscription(rawEmail: string, endpoint: string): Promise<(PushSubscriptionKeys & { mailboxIds: string[] }) | null> {
		const row = this.db
			.select()
			.from(pushSubscriptions)
			.where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userEmail, normalizeAddress(rawEmail))))
			.get();
		return row ? { endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth, mailboxIds: JSON.parse(row.mailboxIds) } : null;
	}

	/** Forgets a browser: one the user turned off, or one its push service says is gone. */
	async removePushSubscription(endpoint: string, rawEmail?: string): Promise<void> {
		this.db
			.delete(pushSubscriptions)
			.where(
				rawEmail === undefined
					? eq(pushSubscriptions.endpoint, endpoint)
					: and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userEmail, normalizeAddress(rawEmail))),
			)
			.run();
	}

	/** Browsers to notify about new mail in a mailbox: subscribed to it, and still allowed to open it. */
	async pushTargets(mailboxId: string, admins: string[]): Promise<(PushSubscriptionKeys & { userEmail: string })[]> {
		const rows = this.db
			.select()
			.from(pushSubscriptions)
			.where(sql`EXISTS (SELECT 1 FROM json_each(${pushSubscriptions.mailboxIds}) WHERE value = ${mailboxId})`)
			.all();
		if (!rows.length) return [];
		const members = new Set(
			this.db
				.select({ email: mailboxMembers.userEmail })
				.from(mailboxMembers)
				.where(and(eq(mailboxMembers.mailboxId, mailboxId), inArray(mailboxMembers.userEmail, [...new Set(rows.map((r) => r.userEmail))])))
				.all()
				.map((r) => r.email),
		);
		const adminSet = new Set(admins.map(normalizeAddress));
		const exists = adminSet.size > 0 && !!(await this.getMailbox(mailboxId));
		return rows
			.filter((r) => members.has(r.userEmail) || (exists && adminSet.has(r.userEmail)))
			.map((r) => ({ endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth, userEmail: r.userEmail }));
	}
}

export interface UserExtension {
	enabled: boolean;
	/** JSON, owned by the extension. */
	settings: string;
	/** Ciphertext, opened in the Worker; the directory never sees plaintext. */
	secret: string | null;
}

export type { Result };

export function getRegistry(env: Env): DurableObjectStub<RegistryDO> {
	const ns = env.REGISTRY as DurableObjectNamespace<RegistryDO>;
	return ns.get(ns.idFromName("global"));
}
