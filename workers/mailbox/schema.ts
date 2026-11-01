import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Migration } from "../lib/migrate";

/**
 * Gmail-style data model: everything is a label (INBOX, SENT, STARRED,
 * UNREAD, …). "Archive" means removing INBOX. A thread carries the union of
 * its messages' labels, kept denormalised in `thread_labels` so listing a
 * label is a single index scan.
 */

export const SystemLabel = {
	INBOX: "INBOX",
	SENT: "SENT",
	DRAFT: "DRAFT",
	SPAM: "SPAM",
	TRASH: "TRASH",
	STARRED: "STARRED",
	IMPORTANT: "IMPORTANT",
	UNREAD: "UNREAD",
} as const;
export type SystemLabelId = (typeof SystemLabel)[keyof typeof SystemLabel];

export const labels = sqliteTable("labels", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	type: text("type", { enum: ["system", "user"] }).notNull(),
	color: text("color"),
	createdAt: integer("created_at").notNull(),
});

export const threads = sqliteTable(
	"threads",
	{
		id: text("id").primaryKey(),
		subject: text("subject").notNull(),
		snippet: text("snippet").notNull(),
		/** JSON array of { name, address } for the thread-list "From" column. */
		participants: text("participants").notNull(),
		messageCount: integer("message_count").notNull(),
		hasAttachments: integer("has_attachments", { mode: "boolean" }).notNull(),
		lastMessageAt: integer("last_message_at").notNull(),
	},
	(t) => [index("idx_threads_last").on(t.lastMessageAt)],
);

export const threadLabels = sqliteTable(
	"thread_labels",
	{
		threadId: text("thread_id")
			.notNull()
			.references(() => threads.id, { onDelete: "cascade" }),
		labelId: text("label_id")
			.notNull()
			.references(() => labels.id, { onDelete: "cascade" }),
		/** Copy of threads.last_message_at so a label listing needs only this index. */
		lastMessageAt: integer("last_message_at").notNull(),
	},
	(t) => [primaryKey({ columns: [t.threadId, t.labelId] }), index("idx_thread_labels_list").on(t.labelId, t.lastMessageAt)],
);

export const messages = sqliteTable(
	"messages",
	{
		id: text("id").primaryKey(),
		threadId: text("thread_id")
			.notNull()
			.references(() => threads.id, { onDelete: "cascade" }),
		/** RFC 5322 Message-ID header, without angle brackets. */
		messageId: text("message_id"),
		inReplyTo: text("in_reply_to"),
		/** JSON array of Message-IDs from the References header. */
		references: text("references"),
		fromAddress: text("from_address").notNull(),
		fromName: text("from_name"),
		/** JSON arrays of { name, address }. */
		to: text("to").notNull(),
		cc: text("cc").notNull(),
		bcc: text("bcc").notNull(),
		replyTo: text("reply_to").notNull(),
		subject: text("subject").notNull(),
		snippet: text("snippet").notNull(),
		/** Plain-text body (also what search indexes). */
		textBody: text("text_body"),
		/** HTML body when small enough to keep inline; otherwise in R2 at html_key. */
		htmlBody: text("html_body"),
		htmlKey: text("html_key"),
		/** Original message in R2. */
		rawKey: text("raw_key"),
		size: integer("size").notNull(),
		hasAttachments: integer("has_attachments", { mode: "boolean" }).notNull(),
		/** JSON: SPF/DKIM/DMARC results recorded on receipt. */
		authResults: text("auth_results"),
		/** Date header, falling back to receipt time. */
		sentAt: integer("sent_at").notNull(),
		receivedAt: integer("received_at").notNull(),
	},
	(t) => [
		index("idx_messages_thread").on(t.threadId, t.sentAt),
		index("idx_messages_message_id").on(t.messageId),
	],
);

export const messageLabels = sqliteTable(
	"message_labels",
	{
		messageId: text("message_id")
			.notNull()
			.references(() => messages.id, { onDelete: "cascade" }),
		labelId: text("label_id")
			.notNull()
			.references(() => labels.id, { onDelete: "cascade" }),
	},
	(t) => [primaryKey({ columns: [t.messageId, t.labelId] }), index("idx_message_labels_label").on(t.labelId)],
);

export const attachments = sqliteTable(
	"attachments",
	{
		id: text("id").primaryKey(),
		messageId: text("message_id")
			.notNull()
			.references(() => messages.id, { onDelete: "cascade" }),
		filename: text("filename").notNull(),
		mimeType: text("mime_type").notNull(),
		size: integer("size").notNull(),
		contentId: text("content_id"),
		disposition: text("disposition", { enum: ["attachment", "inline"] }).notNull(),
		r2Key: text("r2_key").notNull(),
	},
	(t) => [index("idx_attachments_message").on(t.messageId)],
);

const systemLabelRows = Object.values(SystemLabel)
	.map((id) => `('${id}', '${id}', 'system', NULL, 0)`)
	.join(",\n\t\t\t\t");

export const MAILBOX_MIGRATIONS: readonly Migration[] = [
	{
		version: 1,
		name: "init",
		sql: `
			CREATE TABLE labels (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				type TEXT NOT NULL CHECK (type IN ('system', 'user')),
				color TEXT,
				created_at INTEGER NOT NULL
			);
			CREATE UNIQUE INDEX idx_labels_name ON labels(name COLLATE NOCASE);
			INSERT INTO labels (id, name, type, color, created_at) VALUES
				${systemLabelRows};

			CREATE TABLE threads (
				id TEXT PRIMARY KEY,
				subject TEXT NOT NULL,
				snippet TEXT NOT NULL,
				participants TEXT NOT NULL,
				message_count INTEGER NOT NULL,
				has_attachments INTEGER NOT NULL,
				last_message_at INTEGER NOT NULL
			);
			CREATE INDEX idx_threads_last ON threads(last_message_at);

			CREATE TABLE thread_labels (
				thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
				label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
				last_message_at INTEGER NOT NULL,
				PRIMARY KEY (thread_id, label_id)
			);
			CREATE INDEX idx_thread_labels_list ON thread_labels(label_id, last_message_at);

			CREATE TABLE messages (
				id TEXT PRIMARY KEY,
				thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
				message_id TEXT,
				in_reply_to TEXT,
				"references" TEXT,
				from_address TEXT NOT NULL,
				from_name TEXT,
				"to" TEXT NOT NULL,
				cc TEXT NOT NULL,
				bcc TEXT NOT NULL,
				reply_to TEXT NOT NULL,
				subject TEXT NOT NULL,
				snippet TEXT NOT NULL,
				text_body TEXT,
				html_body TEXT,
				html_key TEXT,
				raw_key TEXT,
				size INTEGER NOT NULL,
				has_attachments INTEGER NOT NULL,
				auth_results TEXT,
				sent_at INTEGER NOT NULL,
				received_at INTEGER NOT NULL
			);
			CREATE INDEX idx_messages_thread ON messages(thread_id, sent_at);
			CREATE INDEX idx_messages_message_id ON messages(message_id);

			CREATE TABLE message_labels (
				message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
				label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
				PRIMARY KEY (message_id, label_id)
			);
			CREATE INDEX idx_message_labels_label ON message_labels(label_id);

			CREATE TABLE attachments (
				id TEXT PRIMARY KEY,
				message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
				filename TEXT NOT NULL,
				mime_type TEXT NOT NULL,
				size INTEGER NOT NULL,
				content_id TEXT,
				disposition TEXT NOT NULL CHECK (disposition IN ('attachment', 'inline')),
				r2_key TEXT NOT NULL
			);
			CREATE INDEX idx_attachments_message ON attachments(message_id);
		`,
	},
];
