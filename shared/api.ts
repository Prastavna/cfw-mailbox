/** Request/response shapes for the HTTP API, shared by the Worker and the browser. */

export type MailboxRole = "owner" | "member";

export interface Mailbox {
	id: string;
	address: string;
	domain: string;
	displayName: string;
	createdAt: number;
}

export interface MailboxAccess extends Mailbox {
	role: MailboxRole;
}

export interface Me {
	email: string;
	isAdmin: boolean;
	/** Mailboxes this user may open, sorted by domain then address. */
	mailboxes: MailboxAccess[];
}

export interface Domain {
	domain: string;
	createdAt: number;
}

export interface Member {
	mailboxId: string;
	userEmail: string;
	role: MailboxRole;
	createdAt: number;
}

export interface ApiError {
	error: string;
}

// ---- Mail ----------------------------------------------------------------

export interface EmailAddress {
	name: string;
	address: string;
}

export interface Label {
	id: string;
	name: string;
	type: "system" | "user";
	color: string | null;
	/** Threads carrying this label. */
	total: number;
	/** Of those, threads with at least one unread message. */
	unread: number;
}

export interface ThreadSummary {
	id: string;
	subject: string;
	snippet: string;
	/** Distinct senders, oldest first. */
	participants: EmailAddress[];
	messageCount: number;
	hasAttachments: boolean;
	/** When the newest message arrived (ms since epoch). Threads sort by this. */
	lastMessageAt: number;
	labelIds: string[];
	unread: boolean;
	/** When a snoozed conversation comes back to the inbox (ms since epoch). */
	snoozedUntil: number | null;
}

export interface ThreadPage {
	threads: ThreadSummary[];
	/** Pass back as `cursor` to get the next page; null on the last page. */
	nextCursor: string | null;
}

export interface AttachmentInfo {
	id: string;
	filename: string;
	mimeType: string;
	size: number;
	/** Content-ID without angle brackets, for `cid:` references in the HTML body. */
	contentId: string | null;
	disposition: "attachment" | "inline";
}

export interface AuthResults {
	spf: string | null;
	dkim: string | null;
	dmarc: string | null;
}

export interface MessageDetail {
	id: string;
	threadId: string;
	messageId: string | null;
	from: EmailAddress;
	to: EmailAddress[];
	cc: EmailAddress[];
	bcc: EmailAddress[];
	replyTo: EmailAddress[];
	subject: string;
	snippet: string;
	sentAt: number;
	receivedAt: number;
	text: string | null;
	/** Unsanitised. The browser must sanitise it and render it in a sandboxed iframe. */
	html: string | null;
	labelIds: string[];
	attachments: AttachmentInfo[];
	authResults: AuthResults | null;
	/** Whether "Show original" is available (sent mail has no stored raw copy). */
	hasRaw: boolean;
}

export interface ThreadDetail {
	thread: ThreadSummary;
	/** Oldest first. */
	messages: MessageDetail[];
}

/** Sent over /api/mailboxes/:id/events when something in the mailbox changes. */
export type MailboxEvent =
	| { type: "threads.changed"; threadIds: string[] }
	/** A queued message couldn't be sent; it's back in Drafts with `error`. */
	| { type: "send.failed"; draftId: string; threadId: string; subject: string; error: string };

// ---- Actions ---------------------------------------------------------------

/** Pseudo-label for "All Mail": every thread except Spam and Trash. */
export const ALL_MAIL = "ALL";

/** Labels the server manages itself; they can't be added or removed by hand. */
export const MANAGED_LABELS = ["SENT", "DRAFT", "OUTBOX", "SNOOZED"] as const;

export interface ModifyThreadsRequest {
	threadIds: string[];
	addLabelIds?: string[];
	removeLabelIds?: string[];
}

/** The labels actually added to / removed from one message. Inverting these undoes an action exactly. */
export interface MessageLabelChange {
	messageId: string;
	addLabelIds: string[];
	removeLabelIds: string[];
}

export interface ModifyMessagesRequest {
	changes: MessageLabelChange[];
}

export interface ModifyResult {
	changes: MessageLabelChange[];
	threadIds: string[];
}

export interface DeleteThreadsRequest {
	threadIds: string[];
}

export interface LabelInput {
	name: string;
	color?: string | null;
}

/** Undo for a ModifyResult: the same changes, reversed. */
export function invertChanges(changes: MessageLabelChange[]): MessageLabelChange[] {
	return changes.map((c) => ({ messageId: c.messageId, addLabelIds: c.removeLabelIds, removeLabelIds: c.addLabelIds }));
}

// ---- Writing -----------------------------------------------------------------

/** Fields the composer edits. `html` is the whole body, including any quoted reply. */
export interface DraftFields {
	to: EmailAddress[];
	cc: EmailAddress[];
	bcc: EmailAddress[];
	subject: string;
	html: string;
}

export interface CreateDraftRequest extends Partial<DraftFields> {
	/** Reply to or forward this message (our message ID); the draft joins its thread. */
	parent?: { messageId: string; kind: "reply" | "forward" };
}

export interface DraftDetail extends DraftFields {
	id: string;
	threadId: string;
	attachments: AttachmentInfo[];
	/** Set while the message waits out the undo-send delay. */
	sendAt: number | null;
	/** Why the last send attempt failed, if it did. */
	sendError: string | null;
	updatedAt: number;
}

export interface SendResult {
	status: "queued" | "sent";
	draftId: string;
	threadId: string;
	/** When a queued message goes out (ms since epoch). */
	sendAt: number;
}

export interface VacationSettings {
	enabled: boolean;
	/** Empty: "Re: <their subject>". */
	subject: string;
	/** Plain text. */
	message: string;
	/** Optional window (ms since epoch); outside it no replies are sent. */
	startAt: number | null;
	endAt: number | null;
	/** Only reply to people this mailbox has written to. */
	contactsOnly: boolean;
}

/** How much the mailbox stores. */
export interface MailboxUsage {
	messages: number;
	/** Raw size of all messages (what R2 holds, roughly). */
	messageBytes: number;
	/** The mailbox database (index, metadata, bodies). */
	databaseBytes: number;
	/** New mail is refused once the database reaches this. */
	databaseLimitBytes: number;
}

export interface MailboxSettings {
	/** Plain text, added below new messages and replies. */
	signature: string;
	/** How long "Undo" is offered after Send, in seconds (0 sends at once). */
	undoSendSeconds: number;
	vacation: VacationSettings;
}

export const DEFAULT_VACATION: VacationSettings = {
	enabled: false,
	subject: "",
	message: "",
	startAt: null,
	endAt: null,
	contactsOnly: false,
};

// ---- Organising ----------------------------------------------------------------

export interface SnoozeRequest {
	threadIds: string[];
	/** When the conversations come back (ms since epoch). */
	until: number;
}

export interface Contact {
	name: string;
	address: string;
}

/** What a filter does to matching incoming mail. */
export interface FilterActions {
	archive: boolean;
	markRead: boolean;
	star: boolean;
	important: boolean;
	trash: boolean;
	/** A user label to apply. */
	labelId: string | null;
}

export interface MailFilter {
	id: string;
	/** Search syntax, e.g. `from:news@example.com has:attachment`. */
	query: string;
	actions: FilterActions;
	createdAt: number;
}

export interface CreateFilterRequest {
	query: string;
	actions: FilterActions;
	/** Also apply to conversations already in the mailbox. */
	applyToExisting?: boolean;
}

export const UNDO_SEND_CHOICES = [0, 5, 10, 20, 30] as const;

/** Limits from Cloudflare Email Service. */
export const SEND_LIMITS = {
	recipients: 50,
	attachments: 32,
	messageBytes: 25 * 1024 * 1024,
	subjectChars: 998,
} as const;
