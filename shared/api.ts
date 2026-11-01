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
}

export interface ThreadDetail {
	thread: ThreadSummary;
	/** Oldest first. */
	messages: MessageDetail[];
}

/** Sent over /api/mailboxes/:id/events when something in the mailbox changes. */
export type MailboxEvent = { type: "threads.changed"; threadIds: string[] };
