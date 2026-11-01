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
