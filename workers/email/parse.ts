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
	/** Bulk, list or machine-sent mail (or a bounce/auto-reply) that must never get an automatic reply. */
	automated: boolean;
}

const NO_REPLY_SENDER = /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounces?|notifications?)([+.@-]|$)/i;

/** RFC 3834: don't auto-reply to auto-generated, list or bulk mail, or to bounces. */
export function isAutomated(header: (key: string) => string | null, from: string, contentType: string | null): boolean {
	const autoSubmitted = header("auto-submitted")?.trim().toLowerCase();
	if (autoSubmitted && autoSubmitted !== "no") return true;
	if (/^(bulk|list|junk)$/i.test(header("precedence")?.trim() ?? "")) return true;
	if (header("list-id") || header("list-unsubscribe") || header("x-autoreply") || header("x-autorespond")) return true;
	if (/\b(all|oof|autoreply)\b/i.test(header("x-auto-response-suppress") ?? "")) return true;
	if (/multipart\/report/i.test(contentType ?? "")) return true;
	return !from || NO_REPLY_SENDER.test(from);
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
		automated: isAutomated(header, from?.address ?? "", header("content-type")),
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

/** Elements dropped with everything inside them. */
const DROPPED_ELEMENTS = new Set(["script", "style", "head", "title"]);
/** Tags that end a line ("<br>", or the end of a block). */
const LINE_BREAK_TAGS = new Set(["br", "/p", "/div", "/li", "/tr", "/h1", "/h2", "/h3", "/h4", "/h5", "/h6", "/blockquote"]);
/** Inline formatting doesn't separate words: "<b>noon</b>?" is "noon?". */
const INLINE_TAGS = new Set("a b strong i em u s strike del ins span font code small big sub sup mark abbr".split(" "));
const TAG_NAME = /\/?[a-z][a-z0-9]*/iy;

/**
 * Rough HTML → text, good enough for snippets and search.
 *
 * One left-to-right pass with indexOf, so the cost stays linear in the
 * input even for hostile markup (thousands of unclosed "<script" or "<!--"
 * openers). Inbound HTML comes from anyone on the internet.
 */
export function htmlToText(html: string): string {
	const out: string[] = [];
	// Where each dropped element's closing tag was last found (-1: none after that point).
	const closeAt = new Map<string, number>();
	let i = 0;
	while (i < html.length) {
		const lt = html.indexOf("<", i);
		if (lt < 0) {
			out.push(html.slice(i));
			break;
		}
		out.push(html.slice(i, lt));

		if (html.startsWith("<!--", lt)) {
			const end = html.indexOf("-->", lt + 4);
			if (end >= 0) {
				out.push(" ");
				i = end + 3;
				continue;
			}
		}

		TAG_NAME.lastIndex = lt + 1;
		const name = TAG_NAME.exec(html)?.[0].toLowerCase() ?? "";

		if (DROPPED_ELEMENTS.has(name)) {
			const close = findClose(html, name, lt, closeAt);
			if (close) {
				out.push(" ");
				i = close;
				continue;
			}
		}

		const gt = html.indexOf(">", lt + 1);
		if (gt < 0) {
			// No tag can close: the rest is text.
			out.push(html.slice(lt));
			break;
		}
		if (gt === lt + 1) {
			out.push("<");
			i = lt + 1;
			continue;
		}
		out.push(LINE_BREAK_TAGS.has(name) ? "\n" : INLINE_TAGS.has(name.replace(/^\//, "")) ? "" : " ");
		i = gt + 1;
	}

	return out
		.join("")
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

/**
 * Index just past the "</name>" that closes the element opened at `from`,
 * or 0 if there is none. Remembers results in `cache`, so a run of unclosed
 * openers costs one scan, not one scan each.
 */
function findClose(html: string, name: string, from: number, cache: Map<string, number>): number {
	const known = cache.get(name);
	if (known === -1) return 0;
	if (known !== undefined && known > from) return known;
	const re = new RegExp(`</${name}\\s*>`, "gi");
	re.lastIndex = from;
	const m = re.exec(html);
	const end = m ? m.index + m[0].length : -1;
	cache.set(name, end);
	return Math.max(end, 0);
}

/** How much HTML a snippet looks at; the preview only needs the start. */
const SNIPPET_HTML_LIMIT = 64 * 1024;

/** Short preview line: drops quoted replies and collapses whitespace. */
export function makeSnippet(text: string | null, html: string | null, max = 200): string {
	const body = text ?? (html ? htmlToText(html.slice(0, SNIPPET_HTML_LIMIT)) : "");
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
