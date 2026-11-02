import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Migration } from "../lib/migrate";

export const domains = sqliteTable("domains", {
	domain: text("domain").primaryKey(),
	createdAt: integer("created_at").notNull(),
});

export const mailboxes = sqliteTable("mailboxes", {
	// Stable ID, also used to address the mailbox's Durable Object, so the
	// address or display name can change without moving any data.
	id: text("id").primaryKey(),
	address: text("address").notNull().unique(),
	domain: text("domain")
		.notNull()
		.references(() => domains.domain),
	displayName: text("display_name").notNull(),
	createdAt: integer("created_at").notNull(),
});

export const mailboxMembers = sqliteTable(
	"mailbox_members",
	{
		mailboxId: text("mailbox_id")
			.notNull()
			.references(() => mailboxes.id, { onDelete: "cascade" }),
		userEmail: text("user_email").notNull(),
		role: text("role", { enum: ["owner", "member"] }).notNull(),
		createdAt: integer("created_at").notNull(),
	},
	(t) => [primaryKey({ columns: [t.mailboxId, t.userEmail] }), index("idx_members_user").on(t.userEmail)],
);

/** Each user's settings for each extension. `secret` is ciphertext (see lib/crypto.ts). */
export const userExtensions = sqliteTable(
	"user_extensions",
	{
		userEmail: text("user_email").notNull(),
		extensionId: text("extension_id").notNull(),
		enabled: integer("enabled", { mode: "boolean" }).notNull(),
		/** JSON. */
		settings: text("settings").notNull(),
		secret: text("secret"),
		updatedAt: integer("updated_at").notNull(),
	},
	(t) => [primaryKey({ columns: [t.userEmail, t.extensionId] })],
);

/** A browser that asked for new-mail notifications (Web Push), and for which mailboxes. */
export const pushSubscriptions = sqliteTable(
	"push_subscriptions",
	{
		endpoint: text("endpoint").primaryKey(),
		userEmail: text("user_email").notNull(),
		p256dh: text("p256dh").notNull(),
		auth: text("auth").notNull(),
		/** JSON array of mailbox IDs. Access is checked again before every notification. */
		mailboxIds: text("mailbox_ids").notNull(),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(t) => [index("idx_push_user").on(t.userEmail)],
);

/** Keys this install generates for itself (the VAPID key pair). */
export const serverKeys = sqliteTable("server_keys", {
	name: text("name").primaryKey(),
	/** JSON. */
	value: text("value").notNull(),
	createdAt: integer("created_at").notNull(),
});

export const REGISTRY_MIGRATIONS: readonly Migration[] = [
	{
		version: 1,
		name: "init",
		sql: `
			CREATE TABLE domains (
				domain TEXT PRIMARY KEY,
				created_at INTEGER NOT NULL
			);
			CREATE TABLE mailboxes (
				id TEXT PRIMARY KEY,
				address TEXT NOT NULL UNIQUE,
				domain TEXT NOT NULL REFERENCES domains(domain),
				display_name TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE INDEX idx_mailboxes_domain ON mailboxes(domain);
			CREATE TABLE mailbox_members (
				mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
				user_email TEXT NOT NULL,
				role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
				created_at INTEGER NOT NULL,
				PRIMARY KEY (mailbox_id, user_email)
			);
			CREATE INDEX idx_members_user ON mailbox_members(user_email);
		`,
	},
	{
		version: 2,
		name: "user extensions",
		sql: `
			CREATE TABLE user_extensions (
				user_email TEXT NOT NULL,
				extension_id TEXT NOT NULL,
				enabled INTEGER NOT NULL,
				settings TEXT NOT NULL,
				secret TEXT,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY (user_email, extension_id)
			) WITHOUT ROWID;
		`,
	},
	{
		version: 3,
		name: "push notifications",
		sql: `
			CREATE TABLE push_subscriptions (
				endpoint TEXT PRIMARY KEY,
				user_email TEXT NOT NULL,
				p256dh TEXT NOT NULL,
				auth TEXT NOT NULL,
				mailbox_ids TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE INDEX idx_push_user ON push_subscriptions(user_email);
			CREATE TABLE server_keys (
				name TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
		`,
	},
];
