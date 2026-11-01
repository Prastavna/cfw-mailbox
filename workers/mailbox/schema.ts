import { htmlToText } from "../email/parse";
import type { Migration } from "../lib/migrate";
import { TEXT_LIMIT } from "./keys";

/**
 * MailboxDO queries its SQLite database directly (see MailboxDO.ts); this file
 * holds the schema as migrations.
 *
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
	/** Sent but still inside the undo-send window (or waiting to retry). */
	OUTBOX: "OUTBOX",
} as const;
export type SystemLabelId = (typeof SystemLabel)[keyof typeof SystemLabel];

// Frozen: the labels that existed when migration 1 was written. Later ones are added by their own migration.
const systemLabelRows = ["INBOX", "SENT", "DRAFT", "SPAM", "TRASH", "STARRED", "IMPORTANT", "UNREAD"]
	.map((id) => `('${id}', '${id}', 'system', NULL, 0)`)
	.join(",\n\t\t\t\t");

/** "name address name address …" from a JSON array of EmailAddress, for the search index. */
const addressText = (column: string) =>
	`(SELECT coalesce(group_concat(coalesce(json_extract(value, '$.name'), '') || ' ' || json_extract(value, '$.address'), ' '), '')
	  FROM json_each(${column}))`;

const ftsRow = (m: string) => `${m}.subject,
	coalesce(${m}.from_name, '') || ' ' || ${m}.from_address,
	${addressText(`${m}."to"`)} || ' ' || ${addressText(`${m}.cc`)} || ' ' || ${addressText(`${m}.bcc`)},
	coalesce(${m}.text_body, '')`;

const ftsFilenames = (messageId: string) =>
	`UPDATE messages_fts SET filenames = (SELECT coalesce(group_concat(filename, ' '), '') FROM attachments WHERE message_id = ${messageId})
	 WHERE rowid = (SELECT rowid FROM messages WHERE id = ${messageId});`;

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
	{
		version: 2,
		name: "threading",
		sql: `
			-- Subject with Re:/Fwd: stripped, for threading replies that lack References.
			ALTER TABLE threads ADD COLUMN normalized_subject TEXT NOT NULL DEFAULT '';
			CREATE INDEX idx_threads_subject ON threads(normalized_subject, last_message_at);
			-- Finds replies that arrived before the message they answer.
			CREATE INDEX idx_messages_in_reply_to ON messages(in_reply_to);
		`,
	},
	{
		version: 3,
		name: "sending",
		sql: `
			INSERT OR IGNORE INTO labels (id, name, type, color, created_at) VALUES ('OUTBOX', 'OUTBOX', 'system', NULL, 0);
			-- Drafts are messages with the DRAFT label. Once sent they wait in OUTBOX until send_at.
			ALTER TABLE messages ADD COLUMN send_at INTEGER;
			ALTER TABLE messages ADD COLUMN send_error TEXT;
			ALTER TABLE messages ADD COLUMN send_attempts INTEGER NOT NULL DEFAULT 0;
			CREATE INDEX idx_messages_send_at ON messages(send_at) WHERE send_at IS NOT NULL;
			CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		`,
	},
	{
		version: 4,
		name: "search",
		/*
		 * Full-text index over every message, keyed by the messages table's rowid
		 * and kept in step by triggers. It stores its own copy of the text so
		 * snippets and ranking don't need joins.
		 */
		sql: `
			CREATE VIRTUAL TABLE messages_fts USING fts5(
				subject, sender, recipients, body, filenames,
				tokenize = 'unicode61 remove_diacritics 2'
			);

			CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
				INSERT INTO messages_fts (rowid, subject, sender, recipients, body, filenames)
				VALUES (new.rowid, ${ftsRow("new")}, '');
			END;
			CREATE TRIGGER messages_fts_update AFTER UPDATE OF subject, from_name, from_address, "to", cc, bcc, text_body ON messages BEGIN
				DELETE FROM messages_fts WHERE rowid = old.rowid;
				INSERT INTO messages_fts (rowid, subject, sender, recipients, body, filenames)
				VALUES (new.rowid, ${ftsRow("new")},
					(SELECT coalesce(group_concat(filename, ' '), '') FROM attachments WHERE message_id = new.id));
			END;
			CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
				DELETE FROM messages_fts WHERE rowid = old.rowid;
			END;
			CREATE TRIGGER attachments_fts_insert AFTER INSERT ON attachments BEGIN
				${ftsFilenames("new.message_id")}
			END;
			CREATE TRIGGER attachments_fts_delete AFTER DELETE ON attachments BEGIN
				${ftsFilenames("old.message_id")}
			END;

			INSERT INTO messages_fts (rowid, subject, sender, recipients, body, filenames)
			SELECT m.rowid, ${ftsRow("m")},
				(SELECT coalesce(group_concat(filename, ' '), '') FROM attachments WHERE message_id = m.id)
			FROM messages m;
		`,
		// HTML-only mail had no plain text; derive it so its body is searchable (the update trigger reindexes it).
		run: (sql) => {
			const rows = sql
				.exec<{ id: string; html_body: string }>("SELECT id, html_body FROM messages WHERE text_body IS NULL AND html_body IS NOT NULL")
				.toArray();
			for (const r of rows) sql.exec("UPDATE messages SET text_body = ? WHERE id = ?", htmlToText(r.html_body).slice(0, TEXT_LIMIT), r.id);
		},
	},
];
