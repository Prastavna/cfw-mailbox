import {
	ALL_MAIL,
	type AttachmentInfo,
	type Contact,
	type CreateDraftRequest,
	DEFAULT_VACATION,
	type DraftDetail,
	type DraftFields,
	type EmailAddress,
	type FilterActions,
	type Label,
	MANAGED_LABELS,
	type MailboxEvent,
	type MailboxSettings,
	type MailboxUsage,
	type MailFilter,
	type MessageDetail,
	type MessageLabelChange,
	type ModifyResult,
	SEND_LIMITS,
	type SendResult,
	type ThreadDetail,
	type ThreadPage,
	type ThreadSummary,
} from "../../shared/api";
import { parseSearch, type SearchQuery, type SearchTerm } from "../../shared/search";
import { htmlToText, makeSnippet, normalizeSubject } from "../../workers/email/parse";
import { dataUrlSize } from "./files";

/**
 * One demo mailbox, in memory. Follows MailboxDO's rules (labels on messages,
 * threads carry their union, Trash/Spam hidden elsewhere, stars and unread on the
 * newest message, undo send, snooze) closely enough to look and feel the same.
 */

export class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export interface StoredAttachment extends AttachmentInfo {
	dataUrl: string;
}

export interface StoredMessage {
	id: string;
	threadId: string;
	messageId: string | null;
	from: EmailAddress;
	to: EmailAddress[];
	cc: EmailAddress[];
	bcc: EmailAddress[];
	subject: string;
	text: string | null;
	html: string | null;
	sentAt: number;
	receivedAt: number;
	labels: Set<string>;
	attachments: StoredAttachment[];
	authResults: MessageDetail["authResults"];
	hasRaw: boolean;
	sendAt: number | null;
	sendError: string | null;
}

interface StoredThread {
	id: string;
	/** When a woken snooze put it back at the top. */
	bumpedAt: number;
	snoozedUntil: number | null;
}

const SYSTEM_LABELS = ["INBOX", "SENT", "DRAFT", "SPAM", "TRASH", "STARRED", "IMPORTANT", "UNREAD", "OUTBOX", "SNOOZED"];
const LATEST_MESSAGE_ONLY = new Set(["STARRED", "UNREAD"]);
const RESERVED_LABEL_NAMES = new Set(["inbox", "sent", "draft", "drafts", "spam", "trash", "starred", "important", "unread", "all mail", "all"]);
const DAY_MS = 86_400_000;

const hiddenLabelsFor = (labelId: string): string[] =>
	labelId === "TRASH" ? [] : labelId === "SPAM" ? ["TRASH"] : ["TRASH", "SPAM"];

export const uid = () => crypto.randomUUID();

export class DemoMailbox {
	labels = new Map<string, { id: string; name: string; type: "system" | "user"; color: string | null }>();
	messages = new Map<string, StoredMessage>();
	threads = new Map<string, StoredThread>();
	filters: MailFilter[] = [];
	contacts = new Map<string, { name: string; address: string; sent: number; received: number; last: number }>();
	settings: MailboxSettings = { signature: "", undoSendSeconds: 5, vacation: DEFAULT_VACATION };
	private listeners = new Set<(e: MailboxEvent) => void>();
	private sendTimers = new Map<string, ReturnType<typeof setTimeout>>();
	/** Called after a message goes out, so the demo world can deliver or answer it. */
	onSent?: (message: StoredMessage) => void;

	constructor(
		readonly id: string,
		readonly address: string,
		public displayName: string,
	) {
		for (const l of SYSTEM_LABELS) this.labels.set(l, { id: l, name: l, type: "system", color: null });
	}

	get me(): EmailAddress {
		return { name: this.displayName, address: this.address };
	}

	// ---- Events ------------------------------------------------------------

	subscribe(fn: (e: MailboxEvent) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	broadcast(event: MailboxEvent) {
		for (const fn of this.listeners) setTimeout(() => fn(event), 0);
	}

	private changed(threadIds: Iterable<string>) {
		const ids = [...new Set(threadIds)];
		if (ids.length) this.broadcast({ type: "threads.changed", threadIds: ids });
	}

	// ---- Threads -------------------------------------------------------------

	private messagesOf(threadId: string): StoredMessage[] {
		return [...this.messages.values()]
			.filter((m) => m.threadId === threadId)
			.sort((a, b) => a.receivedAt - b.receivedAt || a.sentAt - b.sentAt);
	}

	private threadLabels(threadId: string): Set<string> {
		const set = new Set<string>();
		for (const m of this.messages.values()) if (m.threadId === threadId) for (const l of m.labels) set.add(l);
		return set;
	}

	summary(threadId: string): ThreadSummary | null {
		const thread = this.threads.get(threadId);
		const messages = this.messagesOf(threadId);
		const latest = messages.at(-1);
		if (!thread || !latest) return null;
		const first = messages.reduce((a, m) => (m.sentAt < a.sentAt ? m : a));
		const participants: EmailAddress[] = [];
		for (const m of messages) if (!participants.some((p) => p.address === m.from.address)) participants.push(m.from);
		const labelIds = [...this.threadLabels(threadId)].sort();
		return {
			id: threadId,
			subject: first.subject,
			snippet: makeSnippet(latest.text, latest.html),
			participants: participants.slice(0, 10),
			messageCount: messages.length,
			hasAttachments: messages.some((m) => m.attachments.some((a) => a.disposition === "attachment")),
			lastMessageAt: Math.max(latest.receivedAt, thread.bumpedAt),
			labelIds,
			unread: labelIds.includes("UNREAD"),
			snoozedUntil: thread.snoozedUntil,
		};
	}

	private allSummaries(): ThreadSummary[] {
		return [...this.threads.keys()]
			.map((id) => this.summary(id))
			.filter((t): t is ThreadSummary => !!t)
			.sort((a, b) => b.lastMessageAt - a.lastMessageAt || (a.id < b.id ? 1 : -1));
	}

	private page(threads: ThreadSummary[], cursor: string | undefined, limit: number): ThreadPage {
		let start = 0;
		if (cursor) {
			const sep = cursor.indexOf("_");
			const at = Number(cursor.slice(0, sep));
			const id = cursor.slice(sep + 1);
			start = threads.findIndex((t) => t.lastMessageAt < at || (t.lastMessageAt === at && t.id < id));
			if (start === -1) start = threads.length;
		}
		const page = threads.slice(start, start + limit);
		const last = page.at(-1);
		return { threads: page, nextCursor: start + limit < threads.length && last ? `${last.lastMessageAt}_${last.id}` : null };
	}

	listLabels(): Label[] {
		const summaries = this.allSummaries();
		return [...this.labels.values()]
			.map((l) => {
				const hidden = hiddenLabelsFor(l.id);
				const inLabel = summaries.filter((t) => t.labelIds.includes(l.id) && !t.labelIds.some((x) => hidden.includes(x)));
				return { ...l, total: inLabel.length, unread: inLabel.filter((t) => t.unread).length };
			})
			.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) : a.type === "system" ? -1 : 1));
	}

	listThreads(labelId: string, cursor: string | undefined, limit: number): ThreadPage {
		const hidden = hiddenLabelsFor(labelId);
		const threads = this.allSummaries().filter(
			(t) => (labelId === ALL_MAIL || t.labelIds.includes(labelId)) && !t.labelIds.some((x) => hidden.includes(x)),
		);
		return this.page(threads, cursor, limit);
	}

	getThread(threadId: string): ThreadDetail | null {
		const thread = this.summary(threadId);
		if (!thread) return null;
		const messages = this.messagesOf(threadId).sort((a, b) => a.sentAt - b.sentAt || a.receivedAt - b.receivedAt);
		return { thread, messages: messages.map((m) => this.detail(m)) };
	}

	detail(m: StoredMessage): MessageDetail {
		return {
			id: m.id,
			threadId: m.threadId,
			messageId: m.messageId,
			from: m.from,
			to: m.to,
			cc: m.cc,
			bcc: m.bcc,
			replyTo: [],
			subject: m.subject,
			snippet: makeSnippet(m.text, m.html),
			sentAt: m.sentAt,
			receivedAt: m.receivedAt,
			text: m.text,
			html: m.html,
			labelIds: [...m.labels].sort(),
			attachments: m.attachments.map(({ dataUrl: _, ...a }) => a),
			authResults: m.authResults,
			hasRaw: m.hasRaw,
		};
	}

	// ---- Search ----------------------------------------------------------------

	search(query: string, cursor: string | undefined, limit: number, tzOffsetMinutes: number): ThreadPage {
		const parsed = parseSearch(query);
		if (!parsed.length) return { threads: [], nextCursor: null };
		const { scope, groups } = this.scopeOf(parsed);
		const hidden = scope === "ANYWHERE" ? [] : hiddenLabelsFor(scope === "ALL" ? ALL_MAIL : scope);
		const matching = new Set<string>();
		for (const m of this.messages.values()) if (this.matches(m, groups, tzOffsetMinutes)) matching.add(m.threadId);
		const threads = this.allSummaries().filter(
			(t) =>
				matching.has(t.id) &&
				(scope === "ALL" || scope === "ANYWHERE" || t.labelIds.includes(scope)) &&
				!t.labelIds.some((x) => hidden.includes(x)),
		);
		return this.page(threads, cursor, limit);
	}

	private folderId(value: string): string | null {
		const folders: Record<string, string> = {
			inbox: "INBOX", sent: "SENT", draft: "DRAFT", drafts: "DRAFT", spam: "SPAM", trash: "TRASH", bin: "TRASH",
			starred: "STARRED", important: "IMPORTANT", all: "ALL", anywhere: "ANYWHERE", outbox: "OUTBOX", scheduled: "OUTBOX",
			snoozed: "SNOOZED",
		};
		return folders[value] ?? this.userLabelId(value);
	}

	private userLabelId(name: string): string | null {
		const wanted = name.toLowerCase();
		for (const l of this.labels.values()) {
			const n = l.name.toLowerCase();
			if (l.type === "user" && (n === wanted || n.replace(/\s+/g, "-") === wanted)) return l.id;
		}
		return null;
	}

	private scopeOf(query: SearchQuery): { scope: string; groups: SearchQuery } {
		let scope = "ALL";
		const groups = query.filter((group) => {
			const t = group[0]!;
			if (group.length === 1 && t.key === "in" && !t.negate) {
				const folder = this.folderId(t.value);
				if (folder) {
					scope = folder;
					return false;
				}
			}
			return true;
		});
		return { scope, groups };
	}

	matches(m: StoredMessage, groups: SearchQuery, tzOffsetMinutes: number): boolean {
		return groups.every((group) => group.some((t) => this.matchTerm(m, t, tzOffsetMinutes) !== t.negate));
	}

	private matchTerm(m: StoredMessage, t: SearchTerm, tz: number): boolean {
		const people = (list: EmailAddress[]) => list.map((p) => `${p.name} ${p.address}`).join(" ");
		const text = (s: string) => {
			const v = t.value.toLowerCase();
			if (!/[\p{L}\p{N}]/u.test(v)) return false;
			const hay = s.toLowerCase();
			if (t.phrase) return hay.includes(v);
			const re = new RegExp(`(^|[^\\p{L}\\p{N}])${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u");
			return re.test(hay);
		};
		const size = (m.text?.length ?? 0) + (m.html?.length ?? 0) + m.attachments.reduce((n, a) => n + a.size, 0);
		const date = (v: string) => {
			const d = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(v);
			return d ? Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3])) + tz * 60_000 : null;
		};
		const age = (v: string) => {
			const a = /^(\d{1,5})([dwmy])$/.exec(v);
			return a ? Number(a[1]) * { d: 1, w: 7, m: 30, y: 365 }[a[2] as "d"] * DAY_MS : null;
		};
		const bytes = (v: string) => {
			const s = /^(\d+(?:\.\d+)?)(b|k|kb|m|mb)?$/.exec(v);
			return s ? Number(s[1]) * ({ b: 1, k: 1024, kb: 1024, m: 1048576, mb: 1048576 }[s[2] as "b"] ?? 1) : null;
		};
		switch (t.key) {
			case null:
				return text([m.subject, people([m.from]), people([...m.to, ...m.cc, ...m.bcc]), m.text ?? "", m.attachments.map((a) => a.filename).join(" ")].join(" \n "));
			case "from":
				return text(people([m.from]));
			case "to":
			case "cc":
			case "bcc":
				return text(people([...m.to, ...m.cc, ...m.bcc]));
			case "subject":
				return text(m.subject);
			case "filename":
				return text(m.attachments.map((a) => a.filename).join(" "));
			case "has":
				if (t.value === "attachment" || t.value === "attachments") return m.attachments.some((a) => a.disposition === "attachment");
				if (t.value === "userlabels") return [...m.labels].some((l) => this.labels.get(l)?.type === "user");
				if (t.value === "nouserlabels") return ![...m.labels].some((l) => this.labels.get(l)?.type === "user");
				return false;
			case "is": {
				const states: Record<string, [string, boolean]> = {
					unread: ["UNREAD", true], read: ["UNREAD", false], starred: ["STARRED", true], unstarred: ["STARRED", false],
					important: ["IMPORTANT", true], draft: ["DRAFT", true], sent: ["SENT", true], snoozed: ["SNOOZED", true],
				};
				const s = states[t.value];
				return s ? m.labels.has(s[0]) === s[1] : false;
			}
			case "in":
			case "label": {
				const id = t.key === "in" ? this.folderId(t.value) : this.userLabelId(t.value);
				if (id === "ALL" || id === "ANYWHERE") return true;
				return id ? m.labels.has(id) : false;
			}
			case "before":
			case "older":
			case "after":
			case "newer": {
				const at = date(t.value);
				if (at === null) return false;
				return t.key === "before" || t.key === "older" ? m.receivedAt < at : m.receivedAt >= at;
			}
			case "older_than":
			case "newer_than": {
				const a = age(t.value);
				if (a === null) return false;
				return t.key === "older_than" ? m.receivedAt < Date.now() - a : m.receivedAt >= Date.now() - a;
			}
			case "larger":
			case "smaller": {
				const b = bytes(t.value);
				if (b === null) return false;
				return t.key === "larger" ? size > b : size < b;
			}
		}
	}

	// ---- Label changes ----------------------------------------------------------

	private checkLabelIds(ids: string[]) {
		if (ids.some((id) => (MANAGED_LABELS as readonly string[]).includes(id))) throw new HttpError(400, "Sent and Drafts are managed automatically");
		if (ids.some((id) => !this.labels.has(id))) throw new HttpError(400, "Unknown label");
	}

	private applyChanges(entries: MessageLabelChange[]): ModifyResult {
		const changes: MessageLabelChange[] = [];
		const threadIds = new Set<string>();
		for (const e of entries) {
			const m = this.messages.get(e.messageId);
			if (!m) continue;
			const added = e.addLabelIds.filter((l) => !m.labels.has(l) && m.labels.add(l));
			const removed = e.removeLabelIds.filter((l) => m.labels.delete(l));
			if (added.length || removed.length) {
				changes.push({ messageId: m.id, addLabelIds: added, removeLabelIds: removed });
				threadIds.add(m.threadId);
			}
		}
		this.changed(threadIds);
		return { changes, threadIds: [...threadIds] };
	}

	modifyThreads(threadIds: string[], add: string[] = [], remove: string[] = []): ModifyResult {
		this.checkLabelIds([...add, ...remove]);
		const entries: MessageLabelChange[] = [];
		for (const threadId of threadIds) {
			const msgs = this.messagesOf(threadId);
			const latest = msgs.filter((m) => !m.labels.has("DRAFT") && !m.labels.has("OUTBOX")).at(-1);
			for (const m of msgs) {
				entries.push({ messageId: m.id, addLabelIds: add.filter((l) => !LATEST_MESSAGE_ONLY.has(l) || latest?.id === m.id), removeLabelIds: remove });
			}
		}
		const result = this.applyChanges(entries);
		if (add.some((l) => l === "INBOX" || l === "TRASH" || l === "SPAM")) this.changed(this.cancelSnoozes(threadIds));
		return result;
	}

	modifyMessages(changes: MessageLabelChange[]): ModifyResult {
		this.checkLabelIds(changes.flatMap((c) => [...c.addLabelIds, ...c.removeLabelIds]));
		return this.applyChanges(changes);
	}

	deleteThreads(threadIds: string[]): { threadIds: string[] } {
		const ids = threadIds.filter((id) => {
			const labels = this.threadLabels(id);
			return labels.has("TRASH") || labels.has("SPAM");
		});
		for (const id of ids) {
			for (const m of this.messagesOf(id)) this.messages.delete(m.id);
			this.threads.delete(id);
		}
		this.changed(ids);
		return { threadIds: ids };
	}

	// ---- Labels --------------------------------------------------------------------

	private checkLabelName(name: string, exceptId?: string) {
		if (RESERVED_LABEL_NAMES.has(name.toLowerCase())) throw new HttpError(400, `"${name}" is reserved`);
		for (const l of this.labels.values()) {
			if (l.id !== exceptId && l.type === "user" && l.name.toLowerCase() === name.toLowerCase()) throw new HttpError(409, `A label named "${name}" already exists`);
		}
	}

	createLabel(name: string, color: string | null): Label {
		this.checkLabelName(name);
		const label = { id: `lbl-${uid().slice(0, 8)}`, name, type: "user" as const, color };
		this.labels.set(label.id, label);
		return { ...label, total: 0, unread: 0 };
	}

	updateLabel(id: string, patch: { name?: string; color?: string | null }) {
		const label = this.labels.get(id);
		if (!label || label.type !== "user") throw new HttpError(404, "Label not found");
		if (patch.name !== undefined) {
			this.checkLabelName(patch.name, id);
			label.name = patch.name;
		}
		if (patch.color !== undefined) label.color = patch.color;
		this.changed([]);
	}

	deleteLabel(id: string) {
		const label = this.labels.get(id);
		if (!label || label.type !== "user") throw new HttpError(404, "Label not found");
		const touched = new Set<string>();
		for (const m of this.messages.values()) if (m.labels.delete(id)) touched.add(m.threadId);
		this.labels.delete(id);
		this.filters = this.filters.filter((f) => f.actions.labelId !== id);
		this.changed(touched);
	}

	// ---- Settings ---------------------------------------------------------------------

	updateSettings(patch: Partial<MailboxSettings>): MailboxSettings {
		this.settings = {
			...this.settings,
			...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
			vacation: { ...this.settings.vacation, ...patch.vacation },
		};
		return this.settings;
	}

	usage(): MailboxUsage {
		let bytes = 0;
		for (const m of this.messages.values()) bytes += (m.html?.length ?? 0) + (m.text?.length ?? 0) + m.attachments.reduce((n, a) => n + a.size, 0);
		return { messages: this.messages.size, messageBytes: bytes, databaseBytes: Math.round(bytes * 0.6) + 98_304, databaseLimitBytes: 9 * 1024 ** 3 };
	}

	// ---- Contacts -------------------------------------------------------------------------

	recordContacts(people: EmailAddress[], direction: "sent" | "received", at: number) {
		for (const p of people) {
			if (p.address === this.address) continue;
			const c = this.contacts.get(p.address) ?? { name: p.name, address: p.address, sent: 0, received: 0, last: 0 };
			c.name = p.name || c.name;
			c[direction]++;
			c.last = Math.max(c.last, at);
			this.contacts.set(p.address, c);
		}
	}

	listContacts(query: string, limit: number): Contact[] {
		const q = query.trim().toLowerCase();
		return [...this.contacts.values()]
			.filter((c) => !q || c.address.startsWith(q) || c.address.includes(`@${q}`) || c.name.toLowerCase().startsWith(q) || c.name.toLowerCase().includes(` ${q}`))
			.sort((a, b) => b.sent - a.sent || b.received - a.received || b.last - a.last)
			.slice(0, limit)
			.map(({ name, address }) => ({ name, address }));
	}

	// ---- Filters ---------------------------------------------------------------------------

	createFilter(query: string, actions: FilterActions, applyToExisting: boolean): { filter: MailFilter; applied: number } {
		if (!parseSearch(query).length) throw new HttpError(400, "A filter needs search criteria");
		if (!Object.entries(actions).some(([k, v]) => (k === "labelId" ? v !== null : v === true))) throw new HttpError(400, "Choose at least one action");
		const filter: MailFilter = { id: uid(), query: query.trim(), actions, createdAt: Date.now() };
		this.filters.push(filter);
		let applied = 0;
		if (applyToExisting) {
			const groups = parseSearch(filter.query);
			const threadIds = new Set<string>();
			for (const m of this.messages.values()) {
				if (["TRASH", "SPAM", "DRAFT", "OUTBOX"].some((l) => m.labels.has(l))) continue;
				if (this.matches(m, groups, new Date().getTimezoneOffset())) threadIds.add(m.threadId);
			}
			const { add, remove } = filterDelta(actions);
			if (threadIds.size) applied = this.modifyThreads([...threadIds], add, remove).threadIds.length;
		}
		return { filter, applied };
	}

	deleteFilter(id: string) {
		const before = this.filters.length;
		this.filters = this.filters.filter((f) => f.id !== id);
		if (this.filters.length === before) throw new HttpError(404, "Filter not found");
	}

	// ---- Drafts ---------------------------------------------------------------------------

	createDraft(request: CreateDraftRequest): DraftDetail {
		const parent = request.parent ? this.messages.get(request.parent.messageId) : undefined;
		if (request.parent && !parent) throw new HttpError(404, "The message you're replying to no longer exists");
		const threadId = parent?.threadId ?? this.newThread();
		const now = Date.now();
		const html = request.html ?? "";
		const id = uid();
		this.messages.set(id, {
			id,
			threadId,
			messageId: null,
			from: this.me,
			to: request.to ?? [],
			cc: request.cc ?? [],
			bcc: request.bcc ?? [],
			subject: (request.subject ?? "").replace(/[\r\n]+/g, " ").slice(0, SEND_LIMITS.subjectChars),
			text: htmlToText(html),
			html,
			sentAt: now,
			receivedAt: now,
			labels: new Set(["DRAFT"]),
			attachments: request.parent?.kind === "forward" && parent ? parent.attachments.map((a) => ({ ...a, id: uid() })) : [],
			authResults: null,
			hasRaw: false,
			sendAt: null,
			sendError: null,
		});
		this.changed([threadId]);
		return this.getDraft(id)!;
	}

	newThread(): string {
		const id = `thr-${uid().slice(0, 12)}`;
		this.threads.set(id, { id, bumpedAt: 0, snoozedUntil: null });
		return id;
	}

	getDraft(id: string): DraftDetail | null {
		const m = this.messages.get(id);
		if (!m || !(m.labels.has("DRAFT") || m.labels.has("OUTBOX"))) return null;
		return {
			id: m.id,
			threadId: m.threadId,
			to: m.to,
			cc: m.cc,
			bcc: m.bcc,
			subject: m.subject,
			html: m.html ?? "",
			attachments: m.attachments.map(({ dataUrl: _, ...a }) => a),
			sendAt: m.labels.has("OUTBOX") ? m.sendAt : null,
			sendError: m.sendError,
			updatedAt: m.receivedAt,
		};
	}

	private draft(id: string): StoredMessage {
		const m = this.messages.get(id);
		if (!m) throw new HttpError(404, "Draft not found");
		if (!m.labels.has("DRAFT")) throw new HttpError(409, "This message has already been sent");
		return m;
	}

	updateDraft(id: string, fields: DraftFields): DraftDetail {
		const m = this.draft(id);
		const now = Date.now();
		Object.assign(m, {
			to: fields.to,
			cc: fields.cc,
			bcc: fields.bcc,
			subject: fields.subject.replace(/[\r\n]+/g, " "),
			html: fields.html,
			text: htmlToText(fields.html),
			sentAt: now,
			receivedAt: now,
			sendError: null,
		});
		this.changed([m.threadId]);
		return this.getDraft(id)!;
	}

	discardDraft(id: string) {
		const m = this.draft(id);
		this.messages.delete(id);
		if (!this.messagesOf(m.threadId).length) this.threads.delete(m.threadId);
		this.changed([m.threadId]);
	}

	addDraftAttachment(id: string, file: { filename: string; mimeType: string; dataUrl: string }): AttachmentInfo {
		const m = this.draft(id);
		const a: StoredAttachment = { id: uid(), filename: file.filename, mimeType: file.mimeType, size: dataUrlSize(file.dataUrl), contentId: null, disposition: "attachment", dataUrl: file.dataUrl };
		if (m.attachments.length >= SEND_LIMITS.attachments) throw new HttpError(400, `At most ${SEND_LIMITS.attachments} attachments`);
		m.attachments.push(a);
		this.changed([m.threadId]);
		const { dataUrl: _, ...info } = a;
		return info;
	}

	removeDraftAttachment(id: string, attachmentId: string) {
		const m = this.draft(id);
		const before = m.attachments.length;
		m.attachments = m.attachments.filter((a) => a.id !== attachmentId);
		if (m.attachments.length === before) throw new HttpError(404, "Attachment not found");
		this.changed([m.threadId]);
	}

	sendDraft(id: string): SendResult {
		const m = this.draft(id);
		const recipients = [...m.to, ...m.cc, ...m.bcc];
		if (!recipients.length) throw new HttpError(400, "Add at least one recipient");
		if (recipients.length > SEND_LIMITS.recipients) throw new HttpError(400, `At most ${SEND_LIMITS.recipients} recipients per message`);
		const delay = this.settings.undoSendSeconds * 1000;
		m.labels.delete("DRAFT");
		m.labels.add("OUTBOX");
		m.sendAt = Date.now() + delay;
		m.sendError = null;
		this.changed([m.threadId]);
		if (delay === 0) return this.deliver(id);
		this.sendTimers.set(id, setTimeout(() => this.deliver(id), delay));
		return { status: "queued", draftId: id, threadId: m.threadId, sendAt: m.sendAt };
	}

	cancelSend(id: string): DraftDetail {
		const m = this.messages.get(id);
		if (!m) throw new HttpError(404, "Message not found");
		if (m.labels.has("DRAFT")) return this.getDraft(id)!;
		if (!m.labels.has("OUTBOX")) throw new HttpError(409, "Too late: the message has been sent");
		clearTimeout(this.sendTimers.get(id));
		this.sendTimers.delete(id);
		m.labels.delete("OUTBOX");
		m.labels.add("DRAFT");
		m.sendAt = null;
		this.changed([m.threadId]);
		return this.getDraft(id)!;
	}

	private deliver(id: string): SendResult {
		this.sendTimers.delete(id);
		const m = this.messages.get(id);
		if (!m?.labels.has("OUTBOX")) throw new HttpError(404, "Nothing to send");
		const now = Date.now();
		m.labels.delete("OUTBOX");
		m.labels.add("SENT");
		Object.assign(m, { messageId: `${uid()}@${this.address.split("@")[1]}`, sentAt: now, receivedAt: now, sendAt: null });
		this.recordContacts([...m.to, ...m.cc, ...m.bcc], "sent", now);
		this.changed([m.threadId]);
		this.onSent?.(m);
		return { status: "sent", draftId: id, threadId: m.threadId, sendAt: now };
	}

	// ---- Snooze ------------------------------------------------------------------------------

	snoozeThreads(threadIds: string[], until: number): { threadIds: string[] } {
		if (until <= Date.now()) throw new HttpError(400, "Pick a time in the future");
		const ids = threadIds.filter((id) => this.threads.has(id));
		if (!ids.length) throw new HttpError(404, "Conversation not found");
		for (const id of ids) {
			this.threads.get(id)!.snoozedUntil = until;
			for (const m of this.messagesOf(id)) {
				m.labels.delete("INBOX");
				m.labels.add("SNOOZED");
			}
		}
		this.changed(ids);
		return { threadIds: ids };
	}

	unsnoozeThreads(threadIds: string[]): { threadIds: string[] } {
		const ids = this.cancelSnoozes(threadIds);
		for (const id of ids) this.returnToInbox(id, false);
		this.changed(ids);
		return { threadIds: ids };
	}

	private cancelSnoozes(threadIds: string[]): string[] {
		const ids = threadIds.filter((id) => this.threads.get(id)?.snoozedUntil != null);
		for (const id of ids) {
			this.threads.get(id)!.snoozedUntil = null;
			for (const m of this.messagesOf(id)) m.labels.delete("SNOOZED");
		}
		return ids;
	}

	private returnToInbox(threadId: string, asNew: boolean) {
		const real = this.messagesOf(threadId).filter((m) => !m.labels.has("DRAFT") && !m.labels.has("OUTBOX"));
		for (const m of real) m.labels.add("INBOX");
		if (asNew) {
			real.at(-1)?.labels.add("UNREAD");
			this.threads.get(threadId)!.bumpedAt = Date.now();
		}
	}

	/** Wakes snoozes that are due. Called on a timer. */
	tick() {
		const now = Date.now();
		const due = [...this.threads.values()].filter((t) => t.snoozedUntil !== null && t.snoozedUntil <= now).map((t) => t.id);
		const ids = this.cancelSnoozes(due);
		for (const id of ids) this.returnToInbox(id, true);
		this.changed(ids);
	}

	// ---- Incoming mail -------------------------------------------------------------------------

	/** Delivers a message to this mailbox: threads it by subject, applies filters, notifies the UI. */
	receive(input: { from: EmailAddress; to: EmailAddress[]; cc?: EmailAddress[]; subject: string; text?: string; html?: string; attachments?: StoredAttachment[] }): StoredMessage {
		const now = Date.now();
		const subject = normalizeSubject(input.subject);
		const existing = [...this.threads.keys()]
			.map((id) => this.summary(id))
			.find((t) => t && normalizeSubject(t.subject) === subject && now - t.lastMessageAt < 30 * DAY_MS);
		const threadId = existing?.id ?? this.newThread();
		const m: StoredMessage = {
			id: uid(),
			threadId,
			messageId: `${uid()}@${input.from.address.split("@")[1]}`,
			from: input.from,
			to: input.to,
			cc: input.cc ?? [],
			bcc: [],
			subject: input.subject,
			text: input.text ?? (input.html ? htmlToText(input.html) : ""),
			html: input.html ?? null,
			sentAt: now,
			receivedAt: now,
			labels: new Set(["INBOX", "UNREAD"]),
			attachments: input.attachments ?? [],
			authResults: { spf: "pass", dkim: "pass", dmarc: "pass" },
			hasRaw: true,
			sendAt: null,
			sendError: null,
		};
		this.messages.set(m.id, m);
		// A reply brings a snoozed or archived conversation back.
		this.cancelSnoozes([threadId]);
		for (const other of this.messagesOf(threadId)) if (!other.labels.has("DRAFT") && !other.labels.has("OUTBOX")) other.labels.add("INBOX");
		this.recordContacts([input.from], "received", now);
		for (const f of this.filters) {
			if (!this.matches(m, parseSearch(f.query), new Date().getTimezoneOffset())) continue;
			const { add, remove } = filterDelta(f.actions);
			for (const l of add) m.labels.add(l);
			for (const l of remove) m.labels.delete(l);
		}
		this.changed([threadId]);
		return m;
	}
}

function filterDelta(a: FilterActions): { add: string[]; remove: string[] } {
	const add: string[] = [];
	const remove: string[] = [];
	if (a.archive) remove.push("INBOX");
	if (a.markRead) remove.push("UNREAD");
	if (a.star) add.push("STARRED");
	if (a.important) add.push("IMPORTANT");
	if (a.labelId) add.push(a.labelId);
	if (a.trash) {
		add.push("TRASH");
		if (!remove.includes("INBOX")) remove.push("INBOX");
	}
	return { add, remove };
}
