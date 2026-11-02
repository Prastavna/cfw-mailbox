import { DurableObject } from "cloudflare:workers";
import {
	ALL_MAIL,
	MANAGED_LABELS,
	SEND_LIMITS,
	type Contact,
	type CreateDraftRequest,
	type ImportContactsResult,
	type OtherContact,
	type SavedContact,
	type SavedContactInput,
	DEFAULT_VACATION,
	type FilterActions,
	type MailFilter,
	type DraftDetail,
	type DraftFields,
	type MailboxSettings,
	type MailboxUsage,
	type MessageLabelChange,
	type ModifyResult,
	type SendResult,
} from "../../shared/api";
import type {
	AttachmentInfo,
	AuthResults,
	EmailAddress,
	Label,
	MailboxEvent,
	MessageDetail,
	ThreadDetail,
	ThreadPage,
	ThreadSummary,
} from "../../shared/api";
import type { MimeSource } from "../email/mime";
import { buildEmail, describeSendError, normalizeMessageId, type OutgoingMessage, referencesHeader, transport } from "../email/outbound";
import { htmlToText, isReplySubject, makeSnippet, normalizeSubject } from "../email/parse";
import { runMigrations } from "../lib/migrate";
import { fail, ok, type Result } from "../lib/result";
import { messageKeys, TEXT_LIMIT } from "./keys";
import { parseSearch } from "../../shared/search";
import { MAILBOX_MIGRATIONS, SystemLabel } from "./schema";
import { compileSearch } from "./search";
import * as addressBook from "./address-book";
import type { VCardContact } from "../../shared/vcard";

/** Everything needed to store one message. Blobs are already in R2. */
export interface IngestInput {
	id: string;
	messageId: string | null;
	inReplyTo: string | null;
	references: string[];
	from: EmailAddress;
	to: EmailAddress[];
	cc: EmailAddress[];
	bcc: EmailAddress[];
	replyTo: EmailAddress[];
	subject: string;
	sentAt: number;
	receivedAt: number;
	text: string | null;
	/** Inline HTML, or null when it's stored in R2 at htmlKey (or there is none). */
	html: string | null;
	htmlKey: string | null;
	rawKey: string | null;
	size: number;
	authResults: AuthResults | null;
	attachments: (AttachmentInfo & { r2Key: string })[];
	labelIds: string[];
}

export type IngestResult =
	/** `notify`: the message is still unread in the Inbox after filters, so browsers should hear about it. */
	| { status: "stored"; threadId: string; merged?: string[]; notify?: { snippet: string } }
	| { status: "duplicate"; threadId: string }
	| { status: "full" };

/**
 * A SQLite-backed Durable Object holds at most 10 GB. New mail is refused a little before
 * that, so there's room left to read, delete and move what's there. Mutable for tests.
 */
export const STORAGE_LIMITS = { databaseBytes: 9 * 1024 ** 3 };

/** One message for the mbox export: its raw copy, or what's needed to rebuild it. */
export interface ExportItem {
	id: string;
	rawKey: string | null;
	labels: string[];
	receivedAt: number;
	source: Omit<MimeSource, "html" | "attachments"> & {
		html: string | null;
		htmlKey: string | null;
		attachments: (Omit<MimeSource["attachments"][number], "content"> & { r2Key: string })[];
	};
}

export interface StoredAttachment {
	filename: string;
	mimeType: string;
	disposition: "attachment" | "inline";
	r2Key: string;
}

/** A reply whose subject matches a thread this recent joins it even without References. */
const SUBJECT_THREAD_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PARTICIPANTS = 10;
const MAX_REFERENCES = 50;

type ThreadRow = {
	id: string;
	subject: string;
	snippet: string;
	participants: string;
	message_count: number;
	has_attachments: number;
	last_message_at: number;
	label_ids: string | null;
	snoozed_until: number | null;
};

type MessageRow = {
	id: string;
	thread_id: string;
	message_id: string | null;
	from_address: string;
	from_name: string | null;
	to: string;
	cc: string;
	bcc: string;
	reply_to: string;
	subject: string;
	snippet: string;
	text_body: string | null;
	html_body: string | null;
	html_key: string | null;
	auth_results: string | null;
	sent_at: number;
	received_at: number;
	label_ids: string | null;
};

type AttachmentRow = {
	id: string;
	message_id: string;
	filename: string;
	mime_type: string;
	size: number;
	content_id: string | null;
	disposition: "attachment" | "inline";
	r2_key: string;
};

const THREAD_COLUMNS = `t.id, t.subject, t.snippet, t.participants, t.message_count, t.has_attachments, t.last_message_at,
	(SELECT group_concat(label_id) FROM thread_labels WHERE thread_id = t.id) AS label_ids,
	(SELECT until FROM snoozes WHERE thread_id = t.id) AS snoozed_until`;

function toThreadSummary(row: ThreadRow): ThreadSummary {
	const labelIds = row.label_ids ? row.label_ids.split(",").sort() : [];
	return {
		id: row.id,
		subject: row.subject,
		snippet: row.snippet,
		participants: JSON.parse(row.participants) as EmailAddress[],
		messageCount: row.message_count,
		hasAttachments: !!row.has_attachments,
		lastMessageAt: row.last_message_at,
		labelIds,
		unread: labelIds.includes(SystemLabel.UNREAD),
		snoozedUntil: row.snoozed_until,
	};
}

function encodeCursor(row: { last_message_at: number; id: string }): string {
	return `${row.last_message_at}_${row.id}`;
}

function decodeCursor(cursor: string | undefined): { at: number; id: string } | null {
	if (!cursor) return null;
	const sep = cursor.indexOf("_");
	const at = Number(cursor.slice(0, sep));
	return sep > 0 && Number.isFinite(at) ? { at, id: cursor.slice(sep + 1) } : null;
}

/**
 * Threads in Trash or Spam are hidden from every other view, like Gmail.
 * Spam also hides trashed threads; Trash shows everything trashed.
 */
function hiddenLabelsFor(labelId: string): string[] {
	if (labelId === SystemLabel.TRASH) return [];
	if (labelId === SystemLabel.SPAM) return [SystemLabel.TRASH];
	return [SystemLabel.TRASH, SystemLabel.SPAM];
}

/** Labels that apply to one message of a thread (the newest) rather than all of them. */
const LATEST_MESSAGE_ONLY = new Set<string>([SystemLabel.STARRED, SystemLabel.UNREAD]);

/** Names user labels can't take, so they don't look like system folders. */
const RESERVED_LABEL_NAMES = new Set(["inbox", "sent", "draft", "drafts", "spam", "trash", "starred", "important", "unread", "all mail", "all"]);

const MAX_BATCH = 500;

const DEFAULT_SETTINGS: MailboxSettings = { signature: "", undoSendSeconds: 5, vacation: DEFAULT_VACATION };
/** Trash and Spam are emptied of messages that have been there this long. */
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** A sender gets at most one vacation reply in this period, like Gmail. */
const VACATION_INTERVAL_MS = 4 * 24 * 60 * 60 * 1000;
/** Most messages deleted per alarm run when emptying Trash/Spam; the alarm re-arms for the rest. */
const PURGE_BATCH = 500;
const MAX_FILTERS = 200;
/** While a message is being handed to Email Service it is leased for this long; a crash mid-send retries after it. */
const SEND_LEASE_MS = 10 * 60 * 1000;
/** Delays before retrying a send that failed for a temporary reason. */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];
/** Messages delivered per alarm run; the alarm re-arms itself for the rest. */
const SEND_BATCH = 10;

type DraftRow = {
	id: string;
	thread_id: string;
	from_address: string;
	from_name: string | null;
	to: string;
	cc: string;
	bcc: string;
	subject: string;
	html_body: string | null;
	text_body: string | null;
	in_reply_to: string | null;
	references: string | null;
	send_at: number | null;
	send_error: string | null;
	send_attempts: number;
	received_at: number;
	label_ids: string | null;
};

const DRAFT_COLUMNS = `m.id, m.thread_id, m.from_address, m.from_name, m."to", m.cc, m.bcc, m.subject, m.html_body, m.text_body,
	m.in_reply_to, m."references", m.send_at, m.send_error, m.send_attempts, m.received_at,
	(SELECT group_concat(label_id) FROM message_labels WHERE message_id = m.id) AS label_ids`;

/** The label changes a filter makes. */
function filterDelta(a: FilterActions): { add: string[]; remove: string[] } {
	const add: string[] = [];
	const remove: string[] = [];
	if (a.archive) remove.push(SystemLabel.INBOX);
	if (a.markRead) remove.push(SystemLabel.UNREAD);
	if (a.star) add.push(SystemLabel.STARRED);
	if (a.important) add.push(SystemLabel.IMPORTANT);
	if (a.labelId) add.push(a.labelId);
	if (a.trash) {
		add.push(SystemLabel.TRASH);
		if (!remove.includes(SystemLabel.INBOX)) remove.push(SystemLabel.INBOX);
	}
	return { add, remove };
}

/** Header-safe subject: no line breaks, within Email Service's limit. */
function cleanSubject(subject: string): string {
	return subject.replace(/[\r\n]+/g, " ").slice(0, SEND_LIMITS.subjectChars);
}

/**
 * One instance per mailbox, addressed by the registry's mailbox ID. Holds
 * every message, thread and label for that mailbox in its own SQLite
 * database, and pushes change notifications to open browser tabs.
 */
export class MailboxDO extends DurableObject<Env> {
	private sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		ctx.blockConcurrencyWhile(async () => runMigrations(ctx.storage, MAILBOX_MIGRATIONS));
	}

	// ---- Receiving ---------------------------------------------------------

	async hasMessage(messageId: string): Promise<boolean> {
		return this.sql.exec("SELECT 1 FROM messages WHERE message_id = ? LIMIT 1", messageId).toArray().length > 0;
	}

	/** Stores a message and files it into a thread. Messages already stored (same Message-ID) are skipped. */
	async ingest(input: IngestInput): Promise<IngestResult> {
		if (this.ctx.storage.sql.databaseSize >= STORAGE_LIMITS.databaseBytes) return { status: "full" };
		const result = this.ctx.storage.transactionSync((): IngestResult => {
			if (input.messageId) {
				const existing = this.sql
					.exec<{ thread_id: string }>("SELECT thread_id FROM messages WHERE message_id = ? LIMIT 1", input.messageId)
					.toArray()[0];
				if (existing) return { status: "duplicate", threadId: existing.thread_id };
			}

			const [found, ...strays] = this.findThreads(input);
			const threadId = found ?? this.createThread(input);
			this.insertMessage(threadId, input);
			// Replies that arrived before this message started threads of their own; join them up.
			for (const stray of strays) this.mergeThread(stray, threadId);
			// New mail in a snoozed conversation brings it back, like Gmail.
			this.cancelSnoozes([threadId]);
			if (input.labelIds.includes(SystemLabel.INBOX)) {
				this.applyFilters(input.id);
				this.recordContacts([input.from], "received", input.receivedAt);
			}
			this.recomputeThread(threadId);
			const row = this.sql
				.exec<{ snippet: string; inbox: number }>(
					`SELECT snippet, (SELECT COUNT(*) FROM message_labels WHERE message_id = ?1 AND label_id IN ('INBOX', 'UNREAD')) = 2
					   AND NOT EXISTS (SELECT 1 FROM message_labels WHERE message_id = ?1 AND label_id IN ('SPAM', 'TRASH')) AS inbox
					 FROM messages WHERE id = ?1`,
					input.id,
				)
				.toArray()[0];
			return { status: "stored", threadId, merged: strays, notify: row?.inbox ? { snippet: row.snippet } : undefined };
		});

		if (result.status === "stored") {
			this.broadcast({ type: "threads.changed", threadIds: [result.threadId, ...(result.merged ?? [])] });
			// A filter may have sent it to Trash, which starts the 30-day clock.
			await this.scheduleAlarm();
		}
		return result;
	}

	/**
	 * Threads this message belongs to: the thread of a message it refers to, then the threads of
	 * replies to it that arrived first. More than one means those should become one conversation.
	 */
	private findThreads(input: IngestInput): string[] {
		const threads: string[] = [];
		const ids = [...new Set([input.inReplyTo, ...input.references].filter((x): x is string => !!x))].slice(-MAX_REFERENCES);
		if (ids.length) {
			const row = this.sql
				.exec<{ thread_id: string }>(
					`SELECT thread_id FROM messages WHERE message_id IN (${ids.map(() => "?").join(",")})
					 ORDER BY received_at DESC LIMIT 1`,
					...ids,
				)
				.toArray()[0];
			if (row) threads.push(row.thread_id);
		}

		// Replies to this message may have arrived first, naming it in In-Reply-To or References.
		if (input.messageId) {
			const rows = this.sql
				.exec<{ thread_id: string }>(
					`SELECT DISTINCT m.thread_id FROM message_refs r JOIN messages m ON m.id = r.message_id
					 WHERE r.ref = ? LIMIT 20`,
					input.messageId,
				)
				.toArray();
			for (const { thread_id } of rows) if (!threads.includes(thread_id)) threads.push(thread_id);
		}
		if (threads.length) return threads;

		// Some clients drop References; fall back to "Re: <same subject>" seen recently.
		const normalized = normalizeSubject(input.subject);
		if (normalized && isReplySubject(input.subject)) {
			const row = this.sql
				.exec<{ id: string }>(
					`SELECT id FROM threads WHERE normalized_subject = ? AND last_message_at > ?
					 ORDER BY last_message_at DESC LIMIT 1`,
					normalized,
					input.receivedAt - SUBJECT_THREAD_WINDOW_MS,
				)
				.toArray()[0];
			if (row) return [row.id];
		}
		return [];
	}

	/** Moves every message of `from` into `into`; `from` disappears. Labels and counts follow. */
	private mergeThread(from: string, into: string): void {
		if (from === into) return;
		this.sql.exec("UPDATE messages SET thread_id = ? WHERE thread_id = ?", into, from);
		this.recomputeThread(from); // now empty: removes the thread, its labels and any snooze
	}

	private createThread(input: Pick<IngestInput, "subject">): string {
		const id = crypto.randomUUID();
		this.sql.exec(
			`INSERT INTO threads (id, subject, normalized_subject, snippet, participants, message_count, has_attachments, last_message_at)
			 VALUES (?, ?, ?, '', '[]', 0, 0, 0)`,
			id,
			input.subject,
			normalizeSubject(input.subject),
		);
		return id;
	}

	private insertMessage(threadId: string, input: IngestInput): void {
		const hasAttachments = input.attachments.some((a) => a.disposition === "attachment");
		this.sql.exec(
			`INSERT INTO messages (id, thread_id, message_id, in_reply_to, "references", from_address, from_name,
				"to", cc, bcc, reply_to, subject, snippet, text_body, html_body, html_key, raw_key, size,
				has_attachments, auth_results, sent_at, received_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			input.id,
			threadId,
			input.messageId,
			input.inReplyTo,
			JSON.stringify(input.references),
			input.from.address,
			input.from.name || null,
			JSON.stringify(input.to),
			JSON.stringify(input.cc),
			JSON.stringify(input.bcc),
			JSON.stringify(input.replyTo),
			input.subject,
			makeSnippet(input.text, input.html),
			input.text,
			input.html,
			input.htmlKey,
			input.rawKey,
			input.size,
			hasAttachments ? 1 : 0,
			input.authResults ? JSON.stringify(input.authResults) : null,
			input.sentAt,
			input.receivedAt,
		);
		const refs = [...new Set([input.inReplyTo, ...input.references].filter((x): x is string => !!x))];
		for (const ref of refs) this.sql.exec("INSERT OR IGNORE INTO message_refs (ref, message_id) VALUES (?, ?)", ref, input.id);
		for (const labelId of input.labelIds) {
			this.sql.exec(
				"INSERT OR IGNORE INTO message_labels (message_id, label_id, added_at) SELECT ?, id, ? FROM labels WHERE id = ?",
				input.id,
				input.receivedAt,
				labelId,
			);
		}
		for (const a of input.attachments) {
			this.sql.exec(
				`INSERT INTO attachments (id, message_id, filename, mime_type, size, content_id, disposition, r2_key)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				a.id,
				input.id,
				a.filename,
				a.mimeType,
				a.size,
				a.contentId,
				a.disposition,
				a.r2Key,
			);
		}
	}

	/**
	 * Recomputes a thread's list-view fields and labels from its messages,
	 * and deletes the thread once it has none left (a discarded draft).
	 */
	private recomputeThread(threadId: string): void {
		const messages = this.sql
			.exec<{ from_address: string; from_name: string | null; snippet: string; subject: string; sent_at: number; received_at: number; has_attachments: number }>(
				`SELECT from_address, from_name, snippet, subject, sent_at, received_at, has_attachments FROM messages WHERE thread_id = ?
				 ORDER BY received_at, sent_at`,
				threadId,
			)
			.toArray();
		const latest = messages.at(-1);
		const first = messages.reduce<(typeof messages)[number] | undefined>((a, m) => (!a || m.sent_at < a.sent_at ? m : a), undefined);
		if (!latest || !first) {
			this.sql.exec("DELETE FROM snoozes WHERE thread_id = ?", threadId);
			this.sql.exec("DELETE FROM thread_labels WHERE thread_id = ?", threadId);
			this.sql.exec("DELETE FROM threads WHERE id = ?", threadId);
			return;
		}

		const participants: EmailAddress[] = [];
		for (const m of messages) {
			if (m.from_address && !participants.some((p) => p.address === m.from_address)) {
				participants.push({ name: m.from_name ?? "", address: m.from_address });
			}
		}
		this.sql.exec(
			`UPDATE threads SET subject = ?, normalized_subject = ?, snippet = ?, participants = ?, message_count = ?,
				has_attachments = ?, last_message_at = ?
			 WHERE id = ?`,
			// Like Gmail, a conversation is named after its first message, even if a reply arrived first.
			first.subject,
			normalizeSubject(first.subject),
			latest.snippet,
			JSON.stringify(participants.slice(0, MAX_PARTICIPANTS)),
			messages.length,
			messages.some((m) => m.has_attachments) ? 1 : 0,
			latest.received_at,
			threadId,
		);
		this.refreshThreadLabels(threadId);
	}

	/** A thread carries every label any of its messages carries. */
	private refreshThreadLabels(threadId: string): void {
		this.sql.exec("DELETE FROM thread_labels WHERE thread_id = ?", threadId);
		this.sql.exec(
			`INSERT INTO thread_labels (thread_id, label_id, last_message_at)
			 SELECT DISTINCT m.thread_id, ml.label_id, t.last_message_at
			 FROM message_labels ml
			 JOIN messages m ON m.id = ml.message_id
			 JOIN threads t ON t.id = m.thread_id
			 WHERE m.thread_id = ?`,
			threadId,
		);
	}

	// ---- Reading -----------------------------------------------------------

	async listLabels(): Promise<Label[]> {
		// A thread counts towards a label unless it's hidden there (see hiddenLabelsFor).
		const visible = `NOT EXISTS (
			SELECT 1 FROM thread_labels x WHERE x.thread_id = tl.thread_id AND (
				(l.id NOT IN ('TRASH', 'SPAM') AND x.label_id IN ('TRASH', 'SPAM'))
				OR (l.id = 'SPAM' AND x.label_id = 'TRASH')))`;
		return this.sql
			.exec<{ id: string; name: string; type: "system" | "user"; color: string | null; total: number; unread: number }>(
				`SELECT l.id, l.name, l.type, l.color,
					(SELECT COUNT(*) FROM thread_labels tl WHERE tl.label_id = l.id AND ${visible}) AS total,
					(SELECT COUNT(*) FROM thread_labels tl
					 JOIN thread_labels u ON u.thread_id = tl.thread_id AND u.label_id = 'UNREAD'
					 WHERE tl.label_id = l.id AND ${visible}) AS unread
				 FROM labels l
				 ORDER BY l.type, l.name COLLATE NOCASE`,
			)
			.toArray();
	}

	async listThreads(opts: { labelId: string; cursor?: string; limit: number }): Promise<ThreadPage> {
		const cursor = decodeCursor(opts.cursor);
		const cursorArgs = [cursor?.at ?? null, cursor?.at ?? null, cursor?.at ?? null, cursor?.id ?? null];
		const rows =
			opts.labelId === ALL_MAIL
				? this.sql
						.exec<ThreadRow>(
							`SELECT ${THREAD_COLUMNS} FROM threads t
							 WHERE (? IS NULL OR t.last_message_at < ? OR (t.last_message_at = ? AND t.id < ?))
							   AND NOT EXISTS (SELECT 1 FROM thread_labels x WHERE x.thread_id = t.id AND x.label_id IN ('TRASH', 'SPAM'))
							 ORDER BY t.last_message_at DESC, t.id DESC
							 LIMIT ?`,
							...cursorArgs,
							opts.limit + 1,
						)
						.toArray()
				: this.sql
						.exec<ThreadRow>(
							`SELECT ${THREAD_COLUMNS}
							 FROM thread_labels tl JOIN threads t ON t.id = tl.thread_id
							 WHERE tl.label_id = ?
							   AND (? IS NULL OR tl.last_message_at < ? OR (tl.last_message_at = ? AND tl.thread_id < ?))
							   AND NOT EXISTS (SELECT 1 FROM thread_labels x
							                   WHERE x.thread_id = tl.thread_id AND x.label_id IN (SELECT value FROM json_each(?)))
							 ORDER BY tl.last_message_at DESC, tl.thread_id DESC
							 LIMIT ?`,
							opts.labelId,
							...cursorArgs,
							JSON.stringify(hiddenLabelsFor(opts.labelId)),
							opts.limit + 1,
						)
						.toArray();
		const page = rows.slice(0, opts.limit);
		const last = page.at(-1);
		return {
			threads: page.map(toThreadSummary),
			nextCursor: rows.length > opts.limit && last ? encodeCursor(last) : null,
		};
	}

	/**
	 * Threads with at least one message matching a Gmail-style query, newest
	 * first. Trash and Spam are left out unless the query asks for them.
	 */
	async search(opts: { query: string; cursor?: string; limit: number; tzOffsetMinutes: number }): Promise<Result<ThreadPage>> {
		const parsed = parseSearch(opts.query);
		if (!parsed.length) return ok({ threads: [], nextCursor: null });
		const labels = this.sql.exec<{ id: string; name: string }>("SELECT id, name FROM labels WHERE type = 'user'").toArray();
		const compiled = compileSearch(parsed, { labels, now: Date.now(), tzOffsetMinutes: opts.tzOffsetMinutes });

		// Search conditions use numbered parameters (?1, ?2, …); continue the numbering here.
		const params: (string | number | null)[] = [...compiled.params];
		const bind = (v: string | number | null) => {
			params.push(v);
			return `?${params.length}`;
		};
		const clauses: string[] = [];
		if (compiled.scope === "ALL") {
			clauses.push("NOT EXISTS (SELECT 1 FROM thread_labels x WHERE x.thread_id = t.id AND x.label_id IN ('TRASH', 'SPAM'))");
		} else if (compiled.scope !== "ANYWHERE") {
			clauses.push(`EXISTS (SELECT 1 FROM thread_labels x WHERE x.thread_id = t.id AND x.label_id = ${bind(compiled.scope)})`);
			const hidden = hiddenLabelsFor(compiled.scope);
			if (hidden.length) {
				clauses.push(
					`NOT EXISTS (SELECT 1 FROM thread_labels x WHERE x.thread_id = t.id AND x.label_id IN (SELECT value FROM json_each(${bind(JSON.stringify(hidden))})))`,
				);
			}
		}
		if (compiled.where) clauses.push(`t.id IN (SELECT m.thread_id FROM messages m WHERE ${compiled.where})`);
		const cursor = decodeCursor(opts.cursor);
		if (cursor) {
			const at = bind(cursor.at);
			clauses.push(`(t.last_message_at < ${at} OR (t.last_message_at = ${at} AND t.id < ${bind(cursor.id)}))`);
		}

		let rows: ThreadRow[];
		try {
			rows = this.sql
				.exec<ThreadRow>(
					`SELECT ${THREAD_COLUMNS} FROM threads t
					 ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
					 ORDER BY t.last_message_at DESC, t.id DESC
					 LIMIT ${bind(opts.limit + 1)}`,
					...params,
				)
				.toArray();
		} catch (err) {
			console.warn("Search failed", { query: opts.query, err: String(err) });
			return fail("invalid", "Couldn't understand that search");
		}
		const page = rows.slice(0, opts.limit);
		const last = page.at(-1);
		return ok({ threads: page.map(toThreadSummary), nextCursor: rows.length > opts.limit && last ? encodeCursor(last) : null });
	}

	/** The conversation a message belongs to, or null if there's no such message. */
	async threadIdOf(messageId: string): Promise<string | null> {
		return this.sql.exec<{ thread_id: string }>("SELECT thread_id FROM messages WHERE id = ?", messageId).toArray()[0]?.thread_id ?? null;
	}

	async getThread(threadId: string): Promise<ThreadDetail | null> {
		const thread = this.sql.exec<ThreadRow>(`SELECT ${THREAD_COLUMNS} FROM threads t WHERE t.id = ?`, threadId).toArray()[0];
		if (!thread) return null;

		const rows = this.sql
			.exec<MessageRow & { has_raw: number }>(
				`SELECT m.id, m.thread_id, m.message_id, m.from_address, m.from_name, m."to", m.cc, m.bcc, m.reply_to,
					m.subject, m.snippet, m.text_body, m.html_body, m.html_key, m.auth_results, m.sent_at, m.received_at,
					m.raw_key IS NOT NULL AS has_raw,
					(SELECT group_concat(label_id) FROM message_labels WHERE message_id = m.id) AS label_ids
				 FROM messages m WHERE m.thread_id = ?
				 ORDER BY m.sent_at ASC, m.received_at ASC`,
				threadId,
			)
			.toArray();
		const attachments = this.sql
			.exec<AttachmentRow>(
				`SELECT a.* FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.thread_id = ? ORDER BY a.rowid`,
				threadId,
			)
			.toArray();

		const messages = await Promise.all(
			rows.map(async (m): Promise<MessageDetail> => {
				let html = m.html_body;
				if (!html && m.html_key) html = (await (await this.env.BUCKET.get(m.html_key))?.text()) ?? null;
				return {
					id: m.id,
					threadId: m.thread_id,
					messageId: m.message_id,
					from: { name: m.from_name ?? "", address: m.from_address },
					to: JSON.parse(m.to),
					cc: JSON.parse(m.cc),
					bcc: JSON.parse(m.bcc),
					replyTo: JSON.parse(m.reply_to),
					subject: m.subject,
					snippet: m.snippet,
					sentAt: m.sent_at,
					receivedAt: m.received_at,
					text: m.text_body,
					html,
					labelIds: m.label_ids ? m.label_ids.split(",").sort() : [],
					attachments: attachments
						.filter((a) => a.message_id === m.id)
						.map((a) => ({
							id: a.id,
							filename: a.filename,
							mimeType: a.mime_type,
							size: a.size,
							contentId: a.content_id,
							disposition: a.disposition,
						})),
					authResults: m.auth_results ? JSON.parse(m.auth_results) : null,
					hasRaw: !!m.has_raw,
				};
			}),
		);
		return { thread: toThreadSummary(thread), messages };
	}

	async getAttachment(messageId: string, attachmentId: string): Promise<StoredAttachment | null> {
		const row = this.sql
			.exec<AttachmentRow>("SELECT * FROM attachments WHERE id = ? AND message_id = ?", attachmentId, messageId)
			.toArray()[0];
		return row ? { filename: row.filename, mimeType: row.mime_type, disposition: row.disposition, r2Key: row.r2_key } : null;
	}

	async getRawKey(messageId: string): Promise<string | null> {
		return (
			this.sql.exec<{ raw_key: string | null }>("SELECT raw_key FROM messages WHERE id = ?", messageId).toArray()[0]?.raw_key ??
			null
		);
	}

	// ---- Actions -------------------------------------------------------------

	/**
	 * Adds/removes labels on whole threads (archive, trash, read, star, …).
	 * STARRED and UNREAD are added to the newest message only, like Gmail;
	 * everything else applies to every message.
	 */
	async modifyThreads(threadIds: string[], addLabelIds: string[], removeLabelIds: string[]): Promise<Result<ModifyResult>> {
		const invalid = this.checkLabelIds([...addLabelIds, ...removeLabelIds]);
		if (invalid) return invalid;
		if (threadIds.length > MAX_BATCH) return fail("invalid", `At most ${MAX_BATCH} threads at a time`);

		const rows = this.sql
			.exec<{ id: string; thread_id: string; unsent: number }>(
				`SELECT id, thread_id,
					EXISTS (SELECT 1 FROM message_labels WHERE message_id = messages.id AND label_id IN ('DRAFT', 'OUTBOX')) AS unsent
				 FROM messages WHERE thread_id IN (SELECT value FROM json_each(?))
				 ORDER BY thread_id, received_at, sent_at`,
				JSON.stringify(threadIds),
			)
			.toArray();
		// Stars and unread marks go on the newest real message, not on a draft.
		const latest = new Map<string, string>();
		for (const r of rows) if (!r.unsent) latest.set(r.thread_id, r.id);

		const entries = rows.map((r) => ({
			messageId: r.id,
			addLabelIds: addLabelIds.filter((l) => !LATEST_MESSAGE_ONLY.has(l) || latest.get(r.thread_id) === r.id),
			removeLabelIds,
		}));
		const result = this.applyChanges(entries);
		// Moving a snoozed conversation to the inbox, Trash or Spam ends the snooze. This isn't part of
		// the undoable change: undo then leaves the conversation archived rather than half-snoozed.
		if (addLabelIds.some((l) => l === SystemLabel.INBOX || l === SystemLabel.TRASH || l === SystemLabel.SPAM)) {
			const cancelled = this.ctx.storage.transactionSync(() => this.cancelSnoozes(threadIds));
			if (cancelled.length) this.broadcast({ type: "threads.changed", threadIds: cancelled });
		}
		await this.scheduleAlarm();
		return ok(result);
	}

	/** Adds/removes labels on individual messages; also used to undo an earlier change exactly. */
	async modifyMessages(changes: MessageLabelChange[]): Promise<Result<ModifyResult>> {
		const invalid = this.checkLabelIds(changes.flatMap((c) => [...c.addLabelIds, ...c.removeLabelIds]));
		if (invalid) return invalid;
		if (changes.length > MAX_BATCH * 20) return fail("invalid", "Too many changes at once");
		const result = this.applyChanges(changes);
		await this.scheduleAlarm();
		return ok(result);
	}

	private checkLabelIds(ids: string[]): Result<never> | null {
		const unique = [...new Set(ids)];
		if (unique.some((id) => (MANAGED_LABELS as readonly string[]).includes(id))) {
			return fail("invalid", "Sent and Drafts are managed automatically");
		}
		const found = this.sql
			.exec<{ n: number }>("SELECT COUNT(*) AS n FROM labels WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(unique))
			.one().n;
		return found === unique.length ? null : fail("invalid", "Unknown label");
	}

	/** Applies label changes in one transaction and reports only what actually changed. */
	private applyChanges(entries: MessageLabelChange[]): ModifyResult {
		const now = Date.now();
		const result = this.ctx.storage.transactionSync(() => {
			const applied: MessageLabelChange[] = [];
			const threadIds = new Set<string>();
			for (const e of entries) {
				const threadId = this.sql
					.exec<{ thread_id: string }>("SELECT thread_id FROM messages WHERE id = ?", e.messageId)
					.toArray()[0]?.thread_id;
				if (!threadId) continue;
				const added = e.addLabelIds.filter(
					(l) =>
						this.sql.exec(
							"INSERT OR IGNORE INTO message_labels (message_id, label_id, added_at) VALUES (?, ?, ?)",
							e.messageId,
							l,
							now,
						).rowsWritten > 0,
				);
				const removed = e.removeLabelIds.filter(
					(l) =>
						this.sql.exec("DELETE FROM message_labels WHERE message_id = ? AND label_id = ?", e.messageId, l).rowsWritten > 0,
				);
				if (added.length || removed.length) {
					applied.push({ messageId: e.messageId, addLabelIds: added, removeLabelIds: removed });
					threadIds.add(threadId);
				}
			}
			for (const id of threadIds) this.refreshThreadLabels(id);
			return { changes: applied, threadIds: [...threadIds] };
		});
		if (result.threadIds.length) this.broadcast({ type: "threads.changed", threadIds: result.threadIds });
		return result;
	}

	/**
	 * Permanently deletes threads that are in Trash or Spam (others are
	 * skipped), including their files in R2.
	 */
	async deleteThreads(threadIds: string[]): Promise<Result<{ threadIds: string[] }>> {
		if (threadIds.length > MAX_BATCH) return fail("invalid", `At most ${MAX_BATCH} threads at a time`);
		const { ids, keys } = this.ctx.storage.transactionSync(() => {
			const ids = this.sql
				.exec<{ thread_id: string }>(
					`SELECT DISTINCT thread_id FROM thread_labels
					 WHERE thread_id IN (SELECT value FROM json_each(?)) AND label_id IN ('TRASH', 'SPAM')`,
					JSON.stringify(threadIds),
				)
				.toArray()
				.map((r) => r.thread_id);
			if (!ids.length) return { ids, keys: [] as string[] };
			const json = JSON.stringify(ids);
			const inThreads = "SELECT id FROM messages WHERE thread_id IN (SELECT value FROM json_each(?))";
			const keys = [
				...this.sql
					.exec<{ k: string }>(
						`SELECT raw_key AS k FROM messages WHERE thread_id IN (SELECT value FROM json_each(?)) AND raw_key IS NOT NULL
						 UNION ALL SELECT html_key FROM messages WHERE thread_id IN (SELECT value FROM json_each(?)) AND html_key IS NOT NULL
						 UNION ALL SELECT r2_key FROM attachments WHERE message_id IN (${inThreads})`,
						json,
						json,
						json,
					)
					.toArray()
					.map((r) => r.k),
			];
			// Children first, so this works whether or not foreign keys are enforced.
			this.sql.exec(`DELETE FROM attachments WHERE message_id IN (${inThreads})`, json);
			this.sql.exec(`DELETE FROM message_labels WHERE message_id IN (${inThreads})`, json);
			this.sql.exec("DELETE FROM messages WHERE thread_id IN (SELECT value FROM json_each(?))", json);
			this.sql.exec("DELETE FROM thread_labels WHERE thread_id IN (SELECT value FROM json_each(?))", json);
			this.sql.exec("DELETE FROM snoozes WHERE thread_id IN (SELECT value FROM json_each(?))", json);
			this.sql.exec("DELETE FROM threads WHERE id IN (SELECT value FROM json_each(?))", json);
			return { ids, keys };
		});

		for (let i = 0; i < keys.length; i += 1000) await this.env.BUCKET.delete(keys.slice(i, i + 1000));
		if (ids.length) this.broadcast({ type: "threads.changed", threadIds: ids });
		return ok({ threadIds: ids });
	}

	// ---- Labels --------------------------------------------------------------

	private labelNameProblem(name: string, exceptId?: string): Result<never> | null {
		if (RESERVED_LABEL_NAMES.has(name.toLowerCase())) return fail("invalid", `"${name}" is reserved`);
		const clash = this.sql
			.exec<{ id: string }>("SELECT id FROM labels WHERE name = ? COLLATE NOCASE", name)
			.toArray()
			.find((r) => r.id !== exceptId);
		return clash ? fail("conflict", `A label named "${name}" already exists`) : null;
	}

	async createLabel(name: string, color: string | null): Promise<Result<Label>> {
		const problem = this.labelNameProblem(name);
		if (problem) return problem;
		const id = crypto.randomUUID();
		this.sql.exec(
			"INSERT INTO labels (id, name, type, color, created_at) VALUES (?, ?, 'user', ?, ?)",
			id,
			name,
			color,
			Date.now(),
		);
		this.broadcast({ type: "threads.changed", threadIds: [] });
		return ok({ id, name, type: "user", color, total: 0, unread: 0 });
	}

	async updateLabel(id: string, patch: { name?: string; color?: string | null }): Promise<Result<null>> {
		const label = this.sql.exec<{ type: string }>("SELECT type FROM labels WHERE id = ?", id).toArray()[0];
		if (!label || label.type !== "user") return fail("not_found", "Label not found");
		if (patch.name !== undefined) {
			const problem = this.labelNameProblem(patch.name, id);
			if (problem) return problem;
			this.sql.exec("UPDATE labels SET name = ? WHERE id = ?", patch.name, id);
		}
		if (patch.color !== undefined) this.sql.exec("UPDATE labels SET color = ? WHERE id = ?", patch.color, id);
		this.broadcast({ type: "threads.changed", threadIds: [] });
		return ok(null);
	}

	/** Removes a user label from every message, then deletes it. Mail itself is untouched. */
	async deleteLabel(id: string): Promise<Result<null>> {
		const label = this.sql.exec<{ type: string }>("SELECT type FROM labels WHERE id = ?", id).toArray()[0];
		if (!label || label.type !== "user") return fail("not_found", "Label not found");
		this.ctx.storage.transactionSync(() => {
			this.sql.exec("DELETE FROM message_labels WHERE label_id = ?", id);
			this.sql.exec("DELETE FROM thread_labels WHERE label_id = ?", id);
			this.sql.exec("DELETE FROM labels WHERE id = ?", id);
		});
		this.broadcast({ type: "threads.changed", threadIds: [] });
		return ok(null);
	}

	// ---- Settings ------------------------------------------------------------

	/**
	 * Messages for the mbox export, oldest first, `limit` at a time after `cursor` (a rowid).
	 * Unsent drafts are left out.
	 */
	exportPage(cursor: number, limit = 100): { items: ExportItem[]; nextCursor: number | null } {
		const rows = this.sql
			.exec<MessageRow & { rowid: number; raw_key: string | null; in_reply_to: string | null; references: string; label_names: string | null }>(
				`SELECT m.rowid, m.*,
					(SELECT group_concat(l.name, char(31)) FROM message_labels ml JOIN labels l ON l.id = ml.label_id
					  WHERE ml.message_id = m.id) AS label_names
				 FROM messages m
				 WHERE m.rowid > ?
				   AND NOT EXISTS (SELECT 1 FROM message_labels ml WHERE ml.message_id = m.id AND ml.label_id IN ('DRAFT', 'OUTBOX'))
				 ORDER BY m.rowid LIMIT ?`,
				cursor,
				limit + 1,
			)
			.toArray();
		const page = rows.slice(0, limit);
		const ids = page.filter((r) => !r.raw_key).map((r) => r.id);
		const attachments = ids.length
			? this.sql.exec<AttachmentRow>("SELECT * FROM attachments WHERE message_id IN (SELECT value FROM json_each(?)) ORDER BY rowid", JSON.stringify(ids)).toArray()
			: [];
		return {
			items: page.map((m) => ({
				id: m.id,
				rawKey: m.raw_key,
				labels: m.label_names ? m.label_names.split("\u001f").sort() : [],
				receivedAt: m.received_at,
				source: {
					from: { name: m.from_name ?? "", address: m.from_address },
					to: JSON.parse(m.to),
					cc: JSON.parse(m.cc),
					bcc: JSON.parse(m.bcc),
					replyTo: JSON.parse(m.reply_to),
					subject: m.subject,
					date: m.sent_at,
					messageId: m.message_id,
					inReplyTo: m.in_reply_to,
					references: JSON.parse(m.references || "[]"),
					text: m.text_body,
					html: m.html_body,
					htmlKey: m.html_key,
					attachments: attachments
						.filter((a) => a.message_id === m.id)
						.map((a) => ({ filename: a.filename, mimeType: a.mime_type, disposition: a.disposition, contentId: a.content_id, r2Key: a.r2_key })),
				},
			})),
			nextCursor: rows.length > limit ? page.at(-1)!.rowid : null,
		};
	}

	usage(): MailboxUsage {
		const row = this.sql.exec<{ n: number; bytes: number }>("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM messages").one();
		return {
			messages: row.n,
			messageBytes: row.bytes,
			databaseBytes: this.ctx.storage.sql.databaseSize,
			databaseLimitBytes: STORAGE_LIMITS.databaseBytes,
		};
	}

	async getSettings(): Promise<MailboxSettings> {
		const rows = this.sql.exec<{ key: string; value: string }>("SELECT key, value FROM settings").toArray();
		const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)])) as Partial<MailboxSettings>;
		return { ...DEFAULT_SETTINGS, ...stored, vacation: { ...DEFAULT_VACATION, ...stored.vacation } };
	}

	async updateSettings(patch: Partial<MailboxSettings>): Promise<MailboxSettings> {
		// Changing the vacation responder starts it afresh: everyone may get one reply again.
		if (patch.vacation) this.sql.exec("DELETE FROM vacation_replies");
		for (const [key, value] of Object.entries(patch)) {
			if (value === undefined || !(key in DEFAULT_SETTINGS)) continue;
			this.sql.exec("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", key, JSON.stringify(value));
		}
		return this.getSettings();
	}

	// ---- Drafts ----------------------------------------------------------------

	/**
	 * Creates a draft. Replies and forwards join the parent's thread and carry
	 * In-Reply-To/References; forwards also copy the parent's attachments.
	 */
	async createDraft(input: {
		mailboxId: string;
		sender: EmailAddress;
		request: CreateDraftRequest;
	}): Promise<Result<DraftDetail>> {
		const { request } = input;
		let parent: { thread_id: string; message_id: string | null; references: string | null } | undefined;
		if (request.parent) {
			parent = this.sql
				.exec<{ thread_id: string; message_id: string | null; references: string | null }>(
					`SELECT thread_id, message_id, "references" FROM messages WHERE id = ?`,
					request.parent.messageId,
				)
				.toArray()[0];
			if (!parent) return fail("not_found", "The message you're replying to no longer exists");
		}

		const id = crypto.randomUUID();
		const keys = messageKeys(input.mailboxId, id);
		const copied: (AttachmentInfo & { r2Key: string })[] = [];
		if (request.parent?.kind === "forward") {
			const originals = this.sql
				.exec<AttachmentRow>("SELECT * FROM attachments WHERE message_id = ? ORDER BY rowid", request.parent.messageId)
				.toArray();
			for (const a of originals) {
				const object = await this.env.BUCKET.get(a.r2_key);
				if (!object) continue;
				const copy = { id: crypto.randomUUID(), filename: a.filename, mimeType: a.mime_type, size: a.size, contentId: a.content_id, disposition: a.disposition };
				const r2Key = keys.attachment(copy.id);
				await this.env.BUCKET.put(r2Key, object.body, { httpMetadata: { contentType: a.mime_type } });
				copied.push({ ...copy, r2Key });
			}
		}

		const fields: DraftFields = {
			to: request.to ?? [],
			cc: request.cc ?? [],
			bcc: request.bcc ?? [],
			subject: cleanSubject(request.subject ?? ""),
			html: request.html ?? "",
		};
		const now = Date.now();
		const references = parent ? [...(JSON.parse(parent.references ?? "[]") as string[]), ...(parent.message_id ? [parent.message_id] : [])] : [];

		this.ctx.storage.transactionSync(() => {
			const threadId = parent?.thread_id ?? this.createThread(fields);
			const text = htmlToText(fields.html);
			this.insertMessage(threadId, {
				id,
				messageId: null,
				inReplyTo: parent?.message_id ?? null,
				references: references.slice(-MAX_REFERENCES),
				from: input.sender,
				...fields,
				replyTo: [],
				sentAt: now,
				receivedAt: now,
				text: text.slice(0, TEXT_LIMIT),
				htmlKey: null,
				rawKey: null,
				size: fields.html.length + copied.reduce((n, a) => n + a.size, 0),
				authResults: null,
				attachments: copied,
				labelIds: [SystemLabel.DRAFT],
			});
			this.recomputeThread(threadId);
		});
		const draft = this.readDraft(id)!;
		this.broadcast({ type: "threads.changed", threadIds: [draft.threadId] });
		return ok(draft);
	}

	async getDraft(id: string): Promise<DraftDetail | null> {
		return this.readDraft(id);
	}

	private draftRow(id: string): DraftRow | undefined {
		return this.sql.exec<DraftRow>(`SELECT ${DRAFT_COLUMNS} FROM messages m WHERE m.id = ?`, id).toArray()[0];
	}

	/** A message that is still a draft (or waiting to be sent) as the composer sees it. */
	private readDraft(id: string): DraftDetail | null {
		const row = this.draftRow(id);
		const labels = row?.label_ids?.split(",") ?? [];
		if (!row || !(labels.includes(SystemLabel.DRAFT) || labels.includes(SystemLabel.OUTBOX))) return null;
		return {
			id: row.id,
			threadId: row.thread_id,
			to: JSON.parse(row.to),
			cc: JSON.parse(row.cc),
			bcc: JSON.parse(row.bcc),
			subject: row.subject,
			html: row.html_body ?? "",
			attachments: this.attachmentsOf(id),
			sendAt: labels.includes(SystemLabel.OUTBOX) ? row.send_at : null,
			sendError: row.send_error,
			updatedAt: row.received_at,
		};
	}

	private attachmentsOf(messageId: string): AttachmentInfo[] {
		return this.sql
			.exec<AttachmentRow>("SELECT * FROM attachments WHERE message_id = ? ORDER BY rowid", messageId)
			.toArray()
			.map((a) => ({ id: a.id, filename: a.filename, mimeType: a.mime_type, size: a.size, contentId: a.content_id, disposition: a.disposition }));
	}

	private isDraft(id: string): boolean {
		return (
			this.sql.exec("SELECT 1 FROM message_labels WHERE message_id = ? AND label_id = 'DRAFT'", id).toArray().length > 0
		);
	}

	private draftProblem(id: string): Result<never> | null {
		if (this.isDraft(id)) return null;
		const exists = this.sql.exec("SELECT 1 FROM messages WHERE id = ?", id).toArray().length > 0;
		return exists ? fail("conflict", "This message has already been sent") : fail("not_found", "Draft not found");
	}

	async updateDraft(id: string, fields: DraftFields): Promise<Result<DraftDetail>> {
		const problem = this.draftProblem(id);
		if (problem) return problem;
		const subject = cleanSubject(fields.subject);
		const text = htmlToText(fields.html);
		const now = Date.now();
		const threadId = this.ctx.storage.transactionSync(() => {
			const { thread_id } = this.sql.exec<{ thread_id: string }>("SELECT thread_id FROM messages WHERE id = ?", id).one();
			const attachmentBytes = this.sql
				.exec<{ n: number | null }>("SELECT SUM(size) AS n FROM attachments WHERE message_id = ?", id)
				.one().n ?? 0;
			this.sql.exec(
				`UPDATE messages SET "to" = ?, cc = ?, bcc = ?, subject = ?, html_body = ?, text_body = ?, snippet = ?,
					size = ?, sent_at = ?, received_at = ?, send_error = NULL
				 WHERE id = ?`,
				JSON.stringify(fields.to),
				JSON.stringify(fields.cc),
				JSON.stringify(fields.bcc),
				subject,
				fields.html,
				text.slice(0, TEXT_LIMIT),
				makeSnippet(text, null),
				fields.html.length + attachmentBytes,
				now,
				now,
				id,
			);
			// A thread that is only this draft is named after it.
			this.sql.exec(
				`UPDATE threads SET subject = ?, normalized_subject = ?
				 WHERE id = ? AND (SELECT COUNT(*) FROM messages WHERE thread_id = ?) = 1`,
				subject,
				normalizeSubject(subject),
				thread_id,
				thread_id,
			);
			this.recomputeThread(thread_id);
			return thread_id;
		});
		this.broadcast({ type: "threads.changed", threadIds: [threadId] });
		return ok(this.readDraft(id)!);
	}

	/** Deletes a draft and its attachments. */
	async discardDraft(id: string): Promise<Result<null>> {
		const problem = this.draftProblem(id);
		if (problem) return problem;
		const { threadId, keys } = this.ctx.storage.transactionSync(() => {
			const { thread_id } = this.sql.exec<{ thread_id: string }>("SELECT thread_id FROM messages WHERE id = ?", id).one();
			const keys = this.sql
				.exec<{ r2_key: string }>("SELECT r2_key FROM attachments WHERE message_id = ?", id)
				.toArray()
				.map((r) => r.r2_key);
			this.sql.exec("DELETE FROM attachments WHERE message_id = ?", id);
			this.sql.exec("DELETE FROM message_labels WHERE message_id = ?", id);
			this.sql.exec("DELETE FROM messages WHERE id = ?", id);
			this.recomputeThread(thread_id);
			return { threadId: thread_id, keys };
		});
		if (keys.length) await this.env.BUCKET.delete(keys);
		this.broadcast({ type: "threads.changed", threadIds: [threadId] });
		return ok(null);
	}

	/** Records an attachment the Worker has already uploaded to R2. The caller deletes the upload on failure. */
	async addDraftAttachment(draftId: string, attachment: AttachmentInfo & { r2Key: string }): Promise<Result<AttachmentInfo>> {
		const problem = this.draftProblem(draftId);
		if (problem) return problem;
		const { n, bytes } = this.sql
			.exec<{ n: number; bytes: number | null }>("SELECT COUNT(*) AS n, SUM(size) AS bytes FROM attachments WHERE message_id = ?", draftId)
			.one();
		if (n >= SEND_LIMITS.attachments) return fail("too_large", `At most ${SEND_LIMITS.attachments} attachments per message`);
		if ((bytes ?? 0) + attachment.size > SEND_LIMITS.messageBytes) return fail("too_large", "Attachments can add up to at most 25 MB");

		const threadId = this.ctx.storage.transactionSync(() => {
			this.sql.exec(
				`INSERT INTO attachments (id, message_id, filename, mime_type, size, content_id, disposition, r2_key)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				attachment.id,
				draftId,
				attachment.filename,
				attachment.mimeType,
				attachment.size,
				attachment.contentId,
				attachment.disposition,
				attachment.r2Key,
			);
			this.sql.exec(
				`UPDATE messages SET size = size + ?, has_attachments = has_attachments OR ? WHERE id = ?`,
				attachment.size,
				attachment.disposition === "attachment" ? 1 : 0,
				draftId,
			);
			const { thread_id } = this.sql.exec<{ thread_id: string }>("SELECT thread_id FROM messages WHERE id = ?", draftId).one();
			this.recomputeThread(thread_id);
			return thread_id;
		});
		this.broadcast({ type: "threads.changed", threadIds: [threadId] });
		const { r2Key: _key, ...info } = attachment;
		return ok(info);
	}

	async removeDraftAttachment(draftId: string, attachmentId: string): Promise<Result<null>> {
		const problem = this.draftProblem(draftId);
		if (problem) return problem;
		const row = this.sql
			.exec<AttachmentRow>("SELECT * FROM attachments WHERE id = ? AND message_id = ?", attachmentId, draftId)
			.toArray()[0];
		if (!row) return fail("not_found", "Attachment not found");
		const threadId = this.ctx.storage.transactionSync(() => {
			this.sql.exec("DELETE FROM attachments WHERE id = ?", attachmentId);
			this.sql.exec(
				`UPDATE messages SET size = MAX(0, size - ?),
					has_attachments = EXISTS (SELECT 1 FROM attachments WHERE message_id = ? AND disposition = 'attachment')
				 WHERE id = ?`,
				row.size,
				draftId,
				draftId,
			);
			const { thread_id } = this.sql.exec<{ thread_id: string }>("SELECT thread_id FROM messages WHERE id = ?", draftId).one();
			this.recomputeThread(thread_id);
			return thread_id;
		});
		await this.env.BUCKET.delete(row.r2_key);
		this.broadcast({ type: "threads.changed", threadIds: [threadId] });
		return ok(null);
	}

	// ---- Sending ---------------------------------------------------------------

	/** IDs being handed to Email Service right now; they can't be cancelled. */
	private inFlight = new Set<string>();

	/**
	 * Moves a draft to the Outbox. It goes out after the mailbox's undo-send
	 * delay (via the alarm), or right away when the delay is 0.
	 */
	async sendDraft(id: string): Promise<Result<SendResult>> {
		const problem = this.draftProblem(id);
		if (problem) return problem;
		const row = this.draftRow(id)!;
		const recipients = [...JSON.parse(row.to), ...JSON.parse(row.cc), ...JSON.parse(row.bcc)] as EmailAddress[];
		if (!recipients.length) return fail("invalid", "Add at least one recipient");
		if (recipients.length > SEND_LIMITS.recipients) return fail("invalid", `At most ${SEND_LIMITS.recipients} recipients per message`);

		const { undoSendSeconds } = await this.getSettings();
		const sendAt = Date.now() + undoSendSeconds * 1000;
		this.ctx.storage.transactionSync(() => {
			this.sql.exec("DELETE FROM message_labels WHERE message_id = ? AND label_id = 'DRAFT'", id);
			this.sql.exec("INSERT OR IGNORE INTO message_labels (message_id, label_id) VALUES (?, 'OUTBOX')", id);
			this.sql.exec("UPDATE messages SET send_at = ?, send_error = NULL, send_attempts = 0 WHERE id = ?", sendAt, id);
			this.refreshThreadLabels(row.thread_id);
		});
		this.broadcast({ type: "threads.changed", threadIds: [row.thread_id] });

		if (undoSendSeconds === 0) {
			const result = await this.deliver(id);
			await this.scheduleAlarm();
			return result;
		}
		await this.scheduleAlarm();
		return ok({ status: "queued", draftId: id, threadId: row.thread_id, sendAt });
	}

	/** Undo send: returns a queued message to Drafts, unless it's already on its way. */
	async cancelSend(id: string): Promise<Result<DraftDetail>> {
		const row = this.draftRow(id);
		if (!row) return fail("not_found", "Message not found");
		const labels = row.label_ids?.split(",") ?? [];
		if (labels.includes(SystemLabel.DRAFT)) return ok(this.readDraft(id)!);
		if (!labels.includes(SystemLabel.OUTBOX) || this.inFlight.has(id)) return fail("conflict", "Too late: the message has been sent");

		this.ctx.storage.transactionSync(() => {
			this.sql.exec("DELETE FROM message_labels WHERE message_id = ? AND label_id = 'OUTBOX'", id);
			this.sql.exec("INSERT OR IGNORE INTO message_labels (message_id, label_id) VALUES (?, 'DRAFT')", id);
			this.sql.exec("UPDATE messages SET send_at = NULL, send_error = NULL WHERE id = ?", id);
			this.refreshThreadLabels(row.thread_id);
		});
		await this.scheduleAlarm();
		this.broadcast({ type: "threads.changed", threadIds: [row.thread_id] });
		return ok(this.readDraft(id)!);
	}

	/**
	 * One alarm serves everything time-based: sending after the undo window,
	 * waking snoozed conversations, and emptying old Trash/Spam. Each run does
	 * what's due and re-arms for the earliest next thing.
	 */
	async alarm(): Promise<void> {
		this.wakeSnoozes();
		await this.purgeExpired();
		const due = this.sql
			.exec<{ id: string }>(
				`SELECT m.id FROM messages m JOIN message_labels ml ON ml.message_id = m.id AND ml.label_id = 'OUTBOX'
				 WHERE m.send_at <= ? ORDER BY m.send_at LIMIT ?`,
				Date.now(),
				SEND_BATCH,
			)
			.toArray();
		for (const { id } of due) await this.deliver(id);
		await this.scheduleAlarm();
	}

	private async scheduleAlarm(): Promise<void> {
		const { send, snooze, purge } = this.sql
			.exec<{ send: number | null; snooze: number | null; purge: number | null }>(
				`SELECT
					(SELECT MIN(m.send_at) FROM messages m JOIN message_labels ml ON ml.message_id = m.id AND ml.label_id = 'OUTBOX') AS send,
					(SELECT MIN(until) FROM snoozes) AS snooze,
					(SELECT MIN(coalesce(added_at, 0)) FROM message_labels WHERE label_id IN ('TRASH', 'SPAM')) AS purge`,
			)
			.one();
		const times = [send, snooze, purge === null ? null : purge + RETENTION_MS].filter((t): t is number => t !== null);
		if (!times.length) {
			await this.ctx.storage.deleteAlarm();
			return;
		}
		const next = Math.max(Math.min(...times), Date.now());
		// Avoid a storage write when the alarm is already set for that moment.
		if ((await this.ctx.storage.getAlarm()) !== next) await this.ctx.storage.setAlarm(next);
	}

	/** Hands one Outbox message to Email Service and files the outcome. */
	private async deliver(id: string): Promise<Result<SendResult>> {
		if (this.inFlight.has(id)) return fail("conflict", "Already sending");
		const row = this.draftRow(id);
		if (!row?.label_ids?.split(",").includes(SystemLabel.OUTBOX)) return fail("not_found", "Nothing to send");

		this.inFlight.add(id);
		const attempt = row.send_attempts + 1;
		this.sql.exec("UPDATE messages SET send_at = ?, send_attempts = ? WHERE id = ?", Date.now() + SEND_LEASE_MS, attempt, id);
		try {
			const outgoing: OutgoingMessage = {
				from: { name: row.from_name ?? "", address: row.from_address },
				to: JSON.parse(row.to),
				cc: JSON.parse(row.cc),
				bcc: JSON.parse(row.bcc),
				subject: row.subject,
				html: row.html_body ?? "",
				text: row.text_body ?? "",
				inReplyTo: row.in_reply_to,
				references: JSON.parse(row.references ?? "[]"),
				attachments: this.sql
					.exec<AttachmentRow>("SELECT * FROM attachments WHERE message_id = ? ORDER BY rowid", id)
					.toArray()
					.map((a) => ({ filename: a.filename, mimeType: a.mime_type, disposition: a.disposition, contentId: a.content_id, r2Key: a.r2_key })),
			};
			const { messageId } = await transport.send(this.env, await buildEmail(this.env, outgoing));

			const now = Date.now();
			this.ctx.storage.transactionSync(() => {
				this.sql.exec("DELETE FROM message_labels WHERE message_id = ? AND label_id = 'OUTBOX'", id);
				this.sql.exec("INSERT OR IGNORE INTO message_labels (message_id, label_id) VALUES (?, 'SENT')", id);
				this.sql.exec(
					"UPDATE messages SET message_id = ?, sent_at = ?, received_at = ?, send_at = NULL, send_error = NULL WHERE id = ?",
					normalizeMessageId(messageId),
					now,
					now,
					id,
				);
				this.recordContacts([...outgoing.to, ...outgoing.cc, ...outgoing.bcc], "sent", now);
				this.recomputeThread(row.thread_id);
			});
			this.broadcast({ type: "threads.changed", threadIds: [row.thread_id] });
			return ok({ status: "sent", draftId: id, threadId: row.thread_id, sendAt: now });
		} catch (err) {
			const error = describeSendError(err);
			console.warn("Send failed", { id, code: error.code, attempt });
			const retryIn = error.retryable ? RETRY_DELAYS_MS[attempt - 1] : undefined;
			this.ctx.storage.transactionSync(() => {
				if (retryIn !== undefined) {
					this.sql.exec("UPDATE messages SET send_at = ?, send_error = ? WHERE id = ?", Date.now() + retryIn, error.message, id);
					return;
				}
				// Give up: back to Drafts so the sender can fix it and try again.
				this.sql.exec("DELETE FROM message_labels WHERE message_id = ? AND label_id = 'OUTBOX'", id);
				this.sql.exec("INSERT OR IGNORE INTO message_labels (message_id, label_id) VALUES (?, 'DRAFT')", id);
				this.sql.exec("UPDATE messages SET send_at = NULL, send_error = ? WHERE id = ?", error.message, id);
				this.refreshThreadLabels(row.thread_id);
			});
			this.broadcast({ type: "threads.changed", threadIds: [row.thread_id] });
			if (retryIn !== undefined) return fail("unavailable", `${error.message} It will be retried automatically.`);
			this.broadcast({ type: "send.failed", draftId: id, threadId: row.thread_id, subject: row.subject, error: error.message });
			return fail("rejected", error.message);
		} finally {
			this.inFlight.delete(id);
		}
	}

	// ---- Snooze ----------------------------------------------------------------

	/** Takes conversations out of the inbox until `until`, when they come back unread. */
	async snoozeThreads(threadIds: string[], until: number): Promise<Result<{ threadIds: string[] }>> {
		if (threadIds.length > MAX_BATCH) return fail("invalid", `At most ${MAX_BATCH} threads at a time`);
		if (until <= Date.now()) return fail("invalid", "Pick a time in the future");
		const existing = this.sql
			.exec<{ id: string }>("SELECT id FROM threads WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(threadIds))
			.toArray()
			.map((r) => r.id);
		if (!existing.length) return fail("not_found", "Conversation not found");

		const now = Date.now();
		this.ctx.storage.transactionSync(() => {
			for (const id of existing) {
				this.sql.exec("INSERT OR REPLACE INTO snoozes (thread_id, until, created_at) VALUES (?, ?, ?)", id, until, now);
				this.sql.exec(
					`DELETE FROM message_labels WHERE label_id = 'INBOX' AND message_id IN (SELECT id FROM messages WHERE thread_id = ?)`,
					id,
				);
				this.sql.exec(
					`INSERT OR IGNORE INTO message_labels (message_id, label_id, added_at)
					 SELECT id, 'SNOOZED', ? FROM messages WHERE thread_id = ?`,
					now,
					id,
				);
				this.refreshThreadLabels(id);
			}
		});
		await this.scheduleAlarm();
		this.broadcast({ type: "threads.changed", threadIds: existing });
		return ok({ threadIds: existing });
	}

	/** Ends a snooze now: the conversation goes back to the inbox. */
	async unsnoozeThreads(threadIds: string[]): Promise<Result<{ threadIds: string[] }>> {
		if (threadIds.length > MAX_BATCH) return fail("invalid", `At most ${MAX_BATCH} threads at a time`);
		const woken = this.ctx.storage.transactionSync(() => {
			const ids = this.cancelSnoozes(threadIds);
			for (const id of ids) this.returnToInbox(id, false);
			return ids;
		});
		await this.scheduleAlarm();
		if (woken.length) this.broadcast({ type: "threads.changed", threadIds: woken });
		return ok({ threadIds: woken });
	}

	/** Drops snoozes for these threads (if any) and returns which ones were snoozed. Call inside a transaction. */
	private cancelSnoozes(threadIds: string[]): string[] {
		const ids = this.sql
			.exec<{ thread_id: string }>("SELECT thread_id FROM snoozes WHERE thread_id IN (SELECT value FROM json_each(?))", JSON.stringify(threadIds))
			.toArray()
			.map((r) => r.thread_id);
		for (const id of ids) {
			this.sql.exec("DELETE FROM snoozes WHERE thread_id = ?", id);
			this.sql.exec(
				`DELETE FROM message_labels WHERE label_id = 'SNOOZED' AND message_id IN (SELECT id FROM messages WHERE thread_id = ?)`,
				id,
			);
			this.refreshThreadLabels(id);
		}
		return ids;
	}

	/** Puts a conversation back in the inbox, optionally unread and at the top. Call inside a transaction. */
	private returnToInbox(threadId: string, asNew: boolean): void {
		const now = Date.now();
		this.sql.exec(
			`INSERT OR IGNORE INTO message_labels (message_id, label_id, added_at)
			 SELECT id, 'INBOX', ? FROM messages m WHERE thread_id = ?
			   AND NOT EXISTS (SELECT 1 FROM message_labels x WHERE x.message_id = m.id AND x.label_id IN ('DRAFT', 'OUTBOX'))`,
			now,
			threadId,
		);
		if (asNew) {
			this.sql.exec(
				`INSERT OR IGNORE INTO message_labels (message_id, label_id, added_at)
				 SELECT id, 'UNREAD', ? FROM messages m WHERE thread_id = ?
				   AND NOT EXISTS (SELECT 1 FROM message_labels x WHERE x.message_id = m.id AND x.label_id IN ('DRAFT', 'OUTBOX'))
				 ORDER BY received_at DESC LIMIT 1`,
				now,
				threadId,
			);
			// Back at the top of the inbox, dated when it returned.
			this.sql.exec("UPDATE threads SET last_message_at = MAX(last_message_at, ?) WHERE id = ?", now, threadId);
		}
		this.refreshThreadLabels(threadId);
	}

	private wakeSnoozes(): void {
		const woken = this.ctx.storage.transactionSync(() => {
			const due = this.sql
				.exec<{ thread_id: string }>("SELECT thread_id FROM snoozes WHERE until <= ? LIMIT ?", Date.now(), MAX_BATCH)
				.toArray()
				.map((r) => r.thread_id);
			const ids = this.cancelSnoozes(due);
			for (const id of ids) this.returnToInbox(id, true);
			return ids;
		});
		if (woken.length) this.broadcast({ type: "threads.changed", threadIds: woken });
	}

	// ---- Emptying Trash and Spam ----------------------------------------------------

	/** Deletes messages that have been in Trash or Spam for 30 days, with their files. */
	private async purgeExpired(): Promise<void> {
		const ids = this.sql
			.exec<{ message_id: string }>(
				`SELECT DISTINCT message_id FROM message_labels
				 WHERE label_id IN ('TRASH', 'SPAM') AND coalesce(added_at, 0) <= ? LIMIT ?`,
				Date.now() - RETENTION_MS,
				PURGE_BATCH,
			)
			.toArray()
			.map((r) => r.message_id);
		if (!ids.length) return;
		const { keys, threadIds } = this.ctx.storage.transactionSync(() => {
			const json = JSON.stringify(ids);
			const inIds = "SELECT value FROM json_each(?)";
			const threadIds = this.sql
				.exec<{ thread_id: string }>(`SELECT DISTINCT thread_id FROM messages WHERE id IN (${inIds})`, json)
				.toArray()
				.map((r) => r.thread_id);
			const keys = this.sql
				.exec<{ k: string }>(
					`SELECT raw_key AS k FROM messages WHERE id IN (${inIds}) AND raw_key IS NOT NULL
					 UNION ALL SELECT html_key FROM messages WHERE id IN (${inIds}) AND html_key IS NOT NULL
					 UNION ALL SELECT r2_key FROM attachments WHERE message_id IN (${inIds})`,
					json,
					json,
					json,
				)
				.toArray()
				.map((r) => r.k);
			this.sql.exec(`DELETE FROM attachments WHERE message_id IN (${inIds})`, json);
			this.sql.exec(`DELETE FROM message_labels WHERE message_id IN (${inIds})`, json);
			this.sql.exec(`DELETE FROM messages WHERE id IN (${inIds})`, json);
			for (const id of threadIds) this.recomputeThread(id);
			return { keys, threadIds };
		});
		for (let i = 0; i < keys.length; i += 1000) await this.env.BUCKET.delete(keys.slice(i, i + 1000));
		this.broadcast({ type: "threads.changed", threadIds });
	}

	// ---- Contacts ----------------------------------------------------------------

	/** Remembers people this mailbox writes to or hears from. Call inside a transaction. */
	private recordContacts(people: EmailAddress[], direction: "sent" | "received", at: number): void {
		const column = direction === "sent" ? "sent_count" : "received_count";
		for (const p of people) {
			if (!p.address) continue;
			this.sql.exec(
				`INSERT INTO contacts (address, name, ${column}, last_contacted) VALUES (?, ?, 1, ?)
				 ON CONFLICT (address) DO UPDATE SET
					${column} = ${column} + 1,
					last_contacted = MAX(last_contacted, excluded.last_contacted),
					name = CASE WHEN excluded.name != '' THEN excluded.name ELSE contacts.name END`,
				p.address,
				p.name ?? "",
				at,
			);
		}
	}

	/** Recipient suggestions: saved contacts first, then people you write to most. */
	async listContacts(query: string, limit: number, exclude: string[] = []): Promise<Contact[]> {
		return addressBook.suggest(this.sql, query, limit, exclude);
	}

	// ---- Address book --------------------------------------------------------------

	async listSavedContacts(query = ""): Promise<SavedContact[]> {
		return addressBook.listSaved(this.sql, query);
	}

	async listOtherContacts(query: string, limit: number, exclude: string[]): Promise<OtherContact[]> {
		return addressBook.listOther(this.sql, query, limit, exclude);
	}

	async createSavedContact(input: SavedContactInput): Promise<Result<SavedContact>> {
		return this.ctx.storage.transactionSync(() => addressBook.createSaved(this.sql, input));
	}

	async updateSavedContact(id: string, input: SavedContactInput): Promise<Result<SavedContact>> {
		return this.ctx.storage.transactionSync(() => addressBook.updateSaved(this.sql, id, input));
	}

	async deleteSavedContacts(ids: string[]): Promise<Result<{ deleted: number }>> {
		const deleted = this.ctx.storage.transactionSync(() => addressBook.deleteSaved(this.sql, ids));
		return deleted ? ok({ deleted }) : fail("not_found", "Contact not found");
	}

	async importContacts(cards: VCardContact[]): Promise<ImportContactsResult> {
		return this.ctx.storage.transactionSync(() => addressBook.importCards(this.sql, cards));
	}

	// ---- Filters ---------------------------------------------------------------------

	async listFilters(): Promise<MailFilter[]> {
		return this.sql
			.exec<{ id: string; query: string; actions: string; created_at: number }>("SELECT * FROM filters ORDER BY created_at")
			.toArray()
			.map((f) => ({ id: f.id, query: f.query, actions: JSON.parse(f.actions), createdAt: f.created_at }));
	}

	async createFilter(query: string, actions: FilterActions, applyToExisting: boolean): Promise<Result<{ filter: MailFilter; applied: number }>> {
		const parsed = parseSearch(query);
		if (!parsed.length) return fail("invalid", "A filter needs search criteria");
		if (!Object.entries(actions).some(([k, v]) => (k === "labelId" ? v !== null : v === true))) {
			return fail("invalid", "Choose at least one action");
		}
		if (actions.labelId) {
			const label = this.sql.exec<{ type: string }>("SELECT type FROM labels WHERE id = ?", actions.labelId).toArray()[0];
			if (label?.type !== "user") return fail("invalid", "Unknown label");
		}
		if (this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM filters").one().n >= MAX_FILTERS) {
			return fail("invalid", `At most ${MAX_FILTERS} filters`);
		}
		const filter: MailFilter = { id: crypto.randomUUID(), query: query.trim(), actions, createdAt: Date.now() };
		this.sql.exec(
			"INSERT INTO filters (id, query, actions, created_at) VALUES (?, ?, ?, ?)",
			filter.id,
			filter.query,
			JSON.stringify(actions),
			filter.createdAt,
		);

		let applied = 0;
		if (applyToExisting) {
			const compiled = this.compileFilter(filter.query);
			if (compiled) {
				const threadIds = this.sql
					.exec<{ thread_id: string }>(
						`SELECT DISTINCT m.thread_id FROM messages m WHERE (${compiled.where})
						   AND NOT EXISTS (SELECT 1 FROM message_labels x WHERE x.message_id = m.id AND x.label_id IN ('TRASH', 'SPAM', 'DRAFT', 'OUTBOX'))
						 LIMIT ${MAX_BATCH}`,
						...compiled.params,
					)
					.toArray()
					.map((r) => r.thread_id);
				const { add, remove } = filterDelta(actions);
				if (threadIds.length) {
					const result = await this.modifyThreads(threadIds, add, remove);
					applied = result.ok ? result.value.threadIds.length : 0;
				}
			}
		}
		return ok({ filter, applied });
	}

	async deleteFilter(id: string): Promise<Result<null>> {
		return this.sql.exec("DELETE FROM filters WHERE id = ?", id).rowsWritten ? ok(null) : fail("not_found", "Filter not found");
	}

	private compileFilter(query: string): { where: string; params: (string | number)[] } | null {
		const labels = this.sql.exec<{ id: string; name: string }>("SELECT id, name FROM labels WHERE type = 'user'").toArray();
		const compiled = compileSearch(parseSearch(query), { labels, now: Date.now(), tzOffsetMinutes: 0 });
		return compiled.where ? { where: compiled.where, params: compiled.params } : null;
	}

	/** Runs every filter against a newly received message and applies the matching ones. Call inside a transaction. */
	private applyFilters(messageId: string): void {
		const filters = this.sql.exec<{ query: string; actions: string }>("SELECT query, actions FROM filters ORDER BY created_at").toArray();
		const now = Date.now();
		for (const f of filters) {
			const compiled = this.compileFilter(f.query);
			if (!compiled) continue;
			let matches = false;
			try {
				matches =
					this.sql
						.exec(`SELECT 1 FROM messages m WHERE m.id = ?${compiled.params.length + 1} AND (${compiled.where})`, ...compiled.params, messageId)
						.toArray().length > 0;
			} catch (err) {
				console.warn("Filter failed", { query: f.query, err: String(err) });
			}
			if (!matches) continue;
			const { add, remove } = filterDelta(JSON.parse(f.actions) as FilterActions);
			for (const l of add) {
				this.sql.exec(
					"INSERT OR IGNORE INTO message_labels (message_id, label_id, added_at) SELECT ?, id, ? FROM labels WHERE id = ?",
					messageId,
					now,
					l,
				);
			}
			for (const l of remove) this.sql.exec("DELETE FROM message_labels WHERE message_id = ? AND label_id = ?", messageId, l);
		}
	}

	// ---- Vacation responder ------------------------------------------------------------

	/**
	 * Sends the vacation reply for a message that just arrived, if the
	 * responder is on and this sender hasn't had one recently. Never throws:
	 * a failed auto-reply must not fail delivery.
	 */
	async autoReply(input: {
		messageId: string;
		mailbox: EmailAddress;
		from: EmailAddress;
		subject: string;
		inReplyTo: string | null;
		references: string[];
		automated: boolean;
	}): Promise<"sent" | "skipped"> {
		try {
			const { vacation } = await this.getSettings();
			const now = Date.now();
			const sender = input.from.address;
			if (!vacation.enabled || !vacation.message.trim() || input.automated || !sender) return "skipped";
			if ((vacation.startAt !== null && now < vacation.startAt) || (vacation.endAt !== null && now > vacation.endAt)) return "skipped";
			if (sender === input.mailbox.address.toLowerCase()) return "skipped";
			const labels = this.sql
				.exec<{ label_id: string }>("SELECT label_id FROM message_labels WHERE message_id = ?", input.messageId)
				.toArray()
				.map((r) => r.label_id);
			if (labels.includes(SystemLabel.SPAM) || labels.includes(SystemLabel.TRASH)) return "skipped";
			if (vacation.contactsOnly) {
				const known = this.sql.exec<{ n: number }>("SELECT sent_count AS n FROM contacts WHERE address = ?", sender).toArray()[0];
				if (!known?.n && !addressBook.isSaved(this.sql, sender)) return "skipped";
			}
			const last = this.sql.exec<{ sent_at: number }>("SELECT sent_at FROM vacation_replies WHERE address = ?", sender).toArray()[0];
			if (last && now - last.sent_at < VACATION_INTERVAL_MS) return "skipped";

			const stored = this.sql.exec<{ message_id: string | null }>("SELECT message_id FROM messages WHERE id = ?", input.messageId).toArray()[0];
			const original = stored?.message_id ?? null;
			const references = [...input.references, ...(original ? [original] : [])].slice(-MAX_REFERENCES);
			const headers: Record<string, string> = { "Auto-Submitted": "auto-replied" };
			if (original) headers["In-Reply-To"] = `<${original}>`;
			const refs = referencesHeader(references);
			if (refs) headers.References = refs;
			// Record first: if sending throws halfway we'd rather miss a reply than send two.
			this.sql.exec("INSERT OR REPLACE INTO vacation_replies (address, sent_at) VALUES (?, ?)", sender, now);
			await transport.send(this.env, {
				from: input.mailbox.name ? { name: input.mailbox.name, email: input.mailbox.address } : input.mailbox.address,
				to: sender,
				subject: cleanSubject(vacation.subject.trim() || `Re: ${input.subject}`.trim()),
				text: vacation.message,
				html: vacation.message
					.split(/\n{2,}/)
					.map((p) => `<p>${p.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`).replace(/\n/g, "<br>")}</p>`)
					.join(""),
				headers,
			} as EmailMessageBuilder);
			return "sent";
		} catch (err) {
			console.warn("Vacation reply failed", String(err));
			return "skipped";
		}
	}

	// ---- Live updates ------------------------------------------------------

	/** Only WebSocket upgrades come through fetch(); the Worker has already checked access. */
	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response("Expected a WebSocket upgrade", { status: 426 });
		}
		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server);
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		if (message === "ping") ws.send("pong");
	}

	async webSocketClose(ws: WebSocket, code: number): Promise<void> {
		ws.close(code === 1005 ? 1000 : code, "closing");
	}

	private broadcast(event: MailboxEvent): void {
		const payload = JSON.stringify(event);
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.send(payload);
			} catch {
				// Socket already closed; the runtime cleans it up.
			}
		}
	}
}

export function getMailbox(env: Env, mailboxId: string): DurableObjectStub<MailboxDO> {
	const ns = env.MAILBOX as DurableObjectNamespace<MailboxDO>;
	return ns.get(ns.idFromName(mailboxId));
}
