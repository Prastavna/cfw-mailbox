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
];
