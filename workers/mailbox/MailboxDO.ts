import { DurableObject } from "cloudflare:workers";
import { asc } from "drizzle-orm";
import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { runMigrations } from "../lib/migrate";
import { labels, MAILBOX_MIGRATIONS } from "./schema";

/**
 * One instance per mailbox, addressed by the registry's mailbox ID.
 * Holds every message, thread and label for that mailbox in its own SQLite
 * database. Receiving, listing and actions arrive in later phases.
 */
export class MailboxDO extends DurableObject<Env> {
	private db: DrizzleSqliteDODatabase;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.db = drizzle(ctx.storage);
		ctx.blockConcurrencyWhile(async () => runMigrations(ctx.storage, MAILBOX_MIGRATIONS));
	}

	async listLabels() {
		return this.db.select().from(labels).orderBy(asc(labels.type), asc(labels.name)).all();
	}
}

export function getMailbox(env: Env, mailboxId: string): DurableObjectStub<MailboxDO> {
	const ns = env.MAILBOX as DurableObjectNamespace<MailboxDO>;
	return ns.get(ns.idFromName(mailboxId));
}
