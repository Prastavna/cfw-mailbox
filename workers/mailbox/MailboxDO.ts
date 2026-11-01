import { DurableObject } from "cloudflare:workers";
import {
	ALL_MAIL,
	MANAGED_LABELS,
	type MessageLabelChange,
	type ModifyResult,
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
import { isReplySubject, makeSnippet, normalizeSubject } from "../email/parse";
import { runMigrations } from "../lib/migrate";
import { fail, ok, type Result } from "../lib/result";
import { MAILBOX_MIGRATIONS, SystemLabel } from "./schema";

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
	rawKey: string;
	size: number;
	authResults: AuthResults | null;
	attachments: (AttachmentInfo & { r2Key: string })[];
	labelIds: string[];
}

export type IngestResult = { status: "stored" | "duplicate"; threadId: string };

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
	(SELECT group_concat(label_id) FROM thread_labels WHERE thread_id = t.id) AS label_ids`;

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
		const result = this.ctx.storage.transactionSync((): IngestResult => {
			if (input.messageId) {
				const existing = this.sql
					.exec<{ thread_id: string }>("SELECT thread_id FROM messages WHERE message_id = ? LIMIT 1", input.messageId)
					.toArray()[0];
				if (existing) return { status: "duplicate", threadId: existing.thread_id };
			}

			const threadId = this.findThread(input) ?? this.createThread(input);
			this.insertMessage(threadId, input);
			this.updateThread(threadId, input);
			this.refreshThreadLabels(threadId);
			return { status: "stored", threadId };
		});

		if (result.status === "stored") this.broadcast({ type: "threads.changed", threadIds: [result.threadId] });
		return result;
	}

	private findThread(input: IngestInput): string | null {
		const ids = [...new Set([input.inReplyTo, ...input.references].filter((x): x is string => !!x))].slice(-MAX_REFERENCES);
		if (ids.length) {
			const row = this.sql
				.exec<{ thread_id: string }>(
					`SELECT thread_id FROM messages WHERE message_id IN (${ids.map(() => "?").join(",")})
					 ORDER BY received_at DESC LIMIT 1`,
					...ids,
				)
				.toArray()[0];
			if (row) return row.thread_id;
		}

		// A reply to this message may have arrived first.
		if (input.messageId) {
			const row = this.sql
				.exec<{ thread_id: string }>("SELECT thread_id FROM messages WHERE in_reply_to = ? LIMIT 1", input.messageId)
				.toArray()[0];
			if (row) return row.thread_id;
		}

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
			if (row) return row.id;
		}
		return null;
	}

	private createThread(input: IngestInput): string {
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
		for (const labelId of input.labelIds) {
			this.sql.exec(
				"INSERT OR IGNORE INTO message_labels (message_id, label_id) SELECT ?, id FROM labels WHERE id = ?",
				input.id,
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

	/** Recomputes a thread's list-view fields from its messages. */
	private updateThread(threadId: string, input: IngestInput): void {
		const thread = this.sql
			.exec<{ participants: string }>("SELECT participants FROM threads WHERE id = ?", threadId)
			.one();
		const participants = JSON.parse(thread.participants) as EmailAddress[];
		if (input.from.address && !participants.some((p) => p.address === input.from.address)) {
			participants.push(input.from);
		}

		const latest = this.sql
			.exec<{ snippet: string; received_at: number }>(
				"SELECT snippet, received_at FROM messages WHERE thread_id = ? ORDER BY received_at DESC, sent_at DESC LIMIT 1",
				threadId,
			)
			.one();
		const stats = this.sql
			.exec<{ n: number; att: number }>(
				"SELECT COUNT(*) AS n, MAX(has_attachments) AS att FROM messages WHERE thread_id = ?",
				threadId,
			)
			.one();

		this.sql.exec(
			`UPDATE threads SET snippet = ?, participants = ?, message_count = ?, has_attachments = ?, last_message_at = ?
			 WHERE id = ?`,
			latest.snippet,
			JSON.stringify(participants.slice(0, MAX_PARTICIPANTS)),
			stats.n,
			stats.att ? 1 : 0,
			latest.received_at,
			threadId,
		);
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

	async getThread(threadId: string): Promise<ThreadDetail | null> {
		const thread = this.sql.exec<ThreadRow>(`SELECT ${THREAD_COLUMNS} FROM threads t WHERE t.id = ?`, threadId).toArray()[0];
		if (!thread) return null;

		const rows = this.sql
			.exec<MessageRow>(
				`SELECT m.id, m.thread_id, m.message_id, m.from_address, m.from_name, m."to", m.cc, m.bcc, m.reply_to,
					m.subject, m.snippet, m.text_body, m.html_body, m.html_key, m.auth_results, m.sent_at, m.received_at,
					(SELECT group_concat(label_id) FROM message_labels WHERE message_id = m.id) AS label_ids
				 FROM messages m WHERE m.thread_id = ?
				 ORDER BY m.received_at ASC, m.sent_at ASC`,
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
			.exec<{ id: string; thread_id: string }>(
				`SELECT id, thread_id FROM messages WHERE thread_id IN (SELECT value FROM json_each(?))
				 ORDER BY thread_id, received_at, sent_at`,
				JSON.stringify(threadIds),
			)
			.toArray();
		const latest = new Map<string, string>();
		for (const r of rows) latest.set(r.thread_id, r.id);

		const entries = rows.map((r) => ({
			messageId: r.id,
			addLabelIds: addLabelIds.filter((l) => !LATEST_MESSAGE_ONLY.has(l) || latest.get(r.thread_id) === r.id),
			removeLabelIds,
		}));
		return ok(this.applyChanges(entries));
	}

	/** Adds/removes labels on individual messages; also used to undo an earlier change exactly. */
	async modifyMessages(changes: MessageLabelChange[]): Promise<Result<ModifyResult>> {
		const invalid = this.checkLabelIds(changes.flatMap((c) => [...c.addLabelIds, ...c.removeLabelIds]));
		if (invalid) return invalid;
		if (changes.length > MAX_BATCH * 20) return fail("invalid", "Too many changes at once");
		return ok(this.applyChanges(changes));
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
						this.sql.exec("INSERT OR IGNORE INTO message_labels (message_id, label_id) VALUES (?, ?)", e.messageId, l)
							.rowsWritten > 0,
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
