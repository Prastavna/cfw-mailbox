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
	/** Out of the inbox until its snooze time. */
	SNOOZED: "SNOOZED",
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
	{
		version: 5,
		name: "organising",
		sql: `
			INSERT OR IGNORE INTO labels (id, name, type, color, created_at) VALUES ('SNOOZED', 'SNOOZED', 'system', NULL, 0);

			-- When a label was put on a message; used to empty Trash and Spam after 30 days.
			ALTER TABLE message_labels ADD COLUMN added_at INTEGER;
			CREATE INDEX idx_message_labels_added ON message_labels(label_id, added_at);

			CREATE TABLE snoozes (
				thread_id TEXT PRIMARY KEY,
				until INTEGER NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE INDEX idx_snoozes_until ON snoozes(until);

			-- People this mailbox has corresponded with, for recipient autocomplete.
			CREATE TABLE contacts (
				address TEXT PRIMARY KEY,
				name TEXT NOT NULL DEFAULT '',
				sent_count INTEGER NOT NULL DEFAULT 0,
				received_count INTEGER NOT NULL DEFAULT 0,
				last_contacted INTEGER NOT NULL
			);

			CREATE TABLE filters (
				id TEXT PRIMARY KEY,
				query TEXT NOT NULL,
				actions TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);

			-- Who got a vacation reply, and when (one per sender every few days).
			CREATE TABLE vacation_replies (
				address TEXT PRIMARY KEY,
				sent_at INTEGER NOT NULL
			);

			INSERT INTO contacts (address, name, received_count, last_contacted)
			SELECT m.from_address, MAX(coalesce(m.from_name, '')), COUNT(*), MAX(m.received_at)
			FROM messages m
			WHERE m.from_address != ''
			  AND NOT EXISTS (SELECT 1 FROM message_labels ml WHERE ml.message_id = m.id AND ml.label_id IN ('SENT', 'DRAFT', 'OUTBOX'))
			GROUP BY m.from_address;

			INSERT INTO contacts (address, name, sent_count, last_contacted)
			SELECT json_extract(r.value, '$.address'), MAX(coalesce(json_extract(r.value, '$.name'), '')), COUNT(*), MAX(m.received_at)
			FROM messages m
			JOIN message_labels ml ON ml.message_id = m.id AND ml.label_id = 'SENT',
			     json_each(json_array(json(m."to"), json(m.cc), json(m.bcc))) AS lists,
			     json_each(lists.value) AS r
			WHERE true
			GROUP BY json_extract(r.value, '$.address')
			ON CONFLICT (address) DO UPDATE SET
				sent_count = excluded.sent_count,
				last_contacted = MAX(contacts.last_contacted, excluded.last_contacted),
				name = CASE WHEN contacts.name = '' THEN excluded.name ELSE contacts.name END;
		`,
		// Existing Trash and Spam start their 30 days now.
		run: (sql) => {
			sql.exec("UPDATE message_labels SET added_at = ? WHERE label_id IN ('TRASH', 'SPAM')", Date.now());
		},
	},
	{
		version: 6,
		name: "reference index",
		sql: `
			-- Every Message-ID a message points at (In-Reply-To and References), so a parent that
			-- arrives after its replies can find them, however the replies named it.
			CREATE TABLE message_refs (
				ref TEXT NOT NULL,
				message_id TEXT NOT NULL,
				PRIMARY KEY (ref, message_id)
			) WITHOUT ROWID;
			CREATE INDEX idx_message_refs_message ON message_refs(message_id);
			CREATE TRIGGER message_refs_cleanup AFTER DELETE ON messages BEGIN
				DELETE FROM message_refs WHERE message_id = old.id;
			END;

			INSERT OR IGNORE INTO message_refs (ref, message_id)
			SELECT in_reply_to, id FROM messages WHERE in_reply_to IS NOT NULL AND in_reply_to != '';
			INSERT OR IGNORE INTO message_refs (ref, message_id)
			SELECT j.value, m.id FROM messages m, json_each(m."references") j
			WHERE json_valid(m."references") AND j.type = 'text' AND j.value != '';
		`,
	},
];
