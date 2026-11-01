import PostalMime, { type Address, type Attachment } from "postal-mime";
import type { AuthResults, EmailAddress } from "../../shared/api";
import { normalizeAddress } from "../../shared/address";

/** Turns a raw RFC 5322 message into the fields the mailbox stores. */

export interface ParsedAttachment {
	filename: string;
	mimeType: string;
	size: number;
	contentId: string | null;
	disposition: "attachment" | "inline";
	content: Uint8Array;
}

export interface ParsedMessage {
	messageId: string | null;
	inReplyTo: string | null;
	references: string[];
	from: EmailAddress;
	to: EmailAddress[];
	cc: EmailAddress[];
	bcc: EmailAddress[];
	replyTo: EmailAddress[];
	subject: string;
	/** From the Date header; null if missing or unparseable. */
	sentAt: number | null;
	text: string | null;
	html: string | null;
	attachments: ParsedAttachment[];
	authResults: AuthResults | null;
}

export async function parseMessage(raw: Uint8Array): Promise<ParsedMessage> {
	const email = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" });
	const header = (key: string) => email.headers.find((h) => h.key === key)?.value ?? null;

	const date = email.date ? Date.parse(email.date) : NaN;
	const from = flatten(email.from ? [email.from] : [])[0] ?? flatten(email.sender ? [email.sender] : [])[0];

	return {
		messageId: firstMessageId(email.messageId),
		inReplyTo: firstMessageId(email.inReplyTo),
		references: messageIds(email.references),
		from: from ?? { name: "", address: "" },
		to: flatten(email.to),
		cc: flatten(email.cc),
		bcc: flatten(email.bcc),
		replyTo: flatten(email.replyTo),
		subject: (email.subject ?? "").trim(),
		sentAt: Number.isNaN(date) ? null : date,
		text: email.text?.trim() ? email.text : null,
		html: email.html?.trim() ? email.html : null,
		attachments: email.attachments.map(toAttachment),
		authResults: parseAuthResults(header("authentication-results")),
	};
}

function flatten(list: Address[] | undefined): EmailAddress[] {
	const out: EmailAddress[] = [];
	for (const a of list ?? []) {
		if (a.group) out.push(...a.group.map((m) => ({ name: m.name, address: normalizeAddress(m.address) })));
		else if (a.address) out.push({ name: a.name, address: normalizeAddress(a.address) });
	}
	return out;
}

/** All `<id>` tokens in a header, without brackets. Falls back to whitespace-separated tokens. */
export function messageIds(value: string | null | undefined): string[] {
	if (!value) return [];
	const bracketed = [...value.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1]!);
	if (bracketed.length) return bracketed;
	return value.split(/\s+/).filter((t) => t.includes("@"));
}

function firstMessageId(value: string | null | undefined): string | null {
	return messageIds(value)[0] ?? null;
}

const EXTENSIONS: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"application/pdf": "pdf",
	"text/calendar": "ics",
	"message/rfc822": "eml",
	"text/plain": "txt",
};

function toAttachment(a: Attachment, index: number): ParsedAttachment {
	const content =
		a.content instanceof ArrayBuffer
			? new Uint8Array(a.content)
			: typeof a.content === "string"
				? new TextEncoder().encode(a.content)
				: a.content;
	const contentId = a.contentId ? a.contentId.replace(/^<|>$/g, "").trim() || null : null;
	const inline = !!contentId && (a.disposition === "inline" || a.related === true || a.disposition === null);
	const ext = EXTENSIONS[a.mimeType];
	return {
		filename: a.filename?.trim() || `attachment-${index + 1}${ext ? `.${ext}` : ""}`,
		mimeType: a.mimeType || "application/octet-stream",
		size: content.byteLength,
		contentId,
		disposition: inline ? "inline" : "attachment",
		content,
	};
}

/** Pulls spf/dkim/dmarc verdicts out of an Authentication-Results header. */
export function parseAuthResults(value: string | null): AuthResults | null {
	if (!value) return null;
	const verdict = (method: string) => value.match(new RegExp(`\\b${method}=([a-z]+)`, "i"))?.[1]?.toLowerCase() ?? null;
	const results = { spf: verdict("spf"), dkim: verdict("dkim"), dmarc: verdict("dmarc") };
	return results.spf || results.dkim || results.dmarc ? results : null;
}

// ---- Text helpers ------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Rough HTML → text, good enough for snippets and search. */
export function htmlToText(html: string): string {
	return html
		.replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
			if (e[0] === "#") {
				const code = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
				return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
			}
			return ENTITIES[e.toLowerCase()] ?? m;
		})
		.replace(/[ \t\u00a0]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Short preview line: drops quoted replies and collapses whitespace. */
export function makeSnippet(text: string | null, html: string | null, max = 200): string {
	const body = text ?? (html ? htmlToText(html) : "");
	const lines = body.split(/\r?\n/);
	const kept: string[] = [];
	for (const line of lines) {
		if (/^\s*>/.test(line)) continue;
		// "On Mon, 1 Jan 2026, Alice <a@x> wrote:" introduces the quoted part.
		if (/^\s*On .{5,200} wrote:\s*$/.test(line)) break;
		kept.push(line);
	}
	const collapsed = kept.join(" ").replace(/\s+/g, " ").trim();
	return collapsed.length > max ? `${collapsed.slice(0, max - 1).trimEnd()}…` : collapsed;
}

const REPLY_PREFIX = /^\s*((re|fwd?|aw|sv|antw|wg|tr|rif)(\[\d+\])?\s*:\s*)+/i;

/** Subject with Re:/Fwd: prefixes stripped, for matching replies to threads. */
export function normalizeSubject(subject: string): string {
	return subject.replace(REPLY_PREFIX, "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function isReplySubject(subject: string): boolean {
	return REPLY_PREFIX.test(subject);
}
