import { isValidAddress, normalizeAddress } from "../../shared/address";
import type { EmailAddress, MessageDetail } from "../../shared/api";

/**
 * Pure helpers for writing mail: recipients and subjects for replies, the
 * quoted block under a reply or forward, and the signature.
 *
 * The quote is kept out of the rich-text editor (which would mangle email
 * HTML) and appended to the body as one block, marked so a saved draft can be
 * split back into "what you wrote" and "what you quoted".
 */

/** Class on the wrapper we add around a quote. `gmail_quote` lets Gmail and our reader fold it. */
export const QUOTE_MARKER = '<div class="gmail_quote cfw-quote"';

export function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Plain text as HTML paragraphs with line breaks. */
export function textToHtml(text: string): string {
	return text
		.replace(/\r\n/g, "\n")
		.split(/\n{2,}/)
		.map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
		.join("");
}

export function formatAddress(a: EmailAddress): string {
	return a.name ? `${a.name} <${a.address}>` : a.address;
}

/** Splits typed or pasted text like `Bob <b@x>, "Smith, Al" <al@y>; c@z` into addresses. */
export function parseAddressList(input: string): EmailAddress[] {
	const tokens: string[] = [];
	let current = "";
	let quoted = false;
	let angle = false;
	for (const ch of input) {
		if (ch === '"') quoted = !quoted;
		else if (ch === "<") angle = true;
		else if (ch === ">") angle = false;
		if (!quoted && !angle && (ch === "," || ch === ";" || ch === "\n")) {
			tokens.push(current);
			current = "";
		} else current += ch;
	}
	tokens.push(current);

	return tokens
		.map((t) => t.trim())
		.filter(Boolean)
		.map((t) => {
			const m = t.match(/^(.*?)<([^<>]*)>\s*$/);
			if (m) return { name: m[1]!.trim().replace(/^"|"$/g, "").trim(), address: normalizeAddress(m[2]!) };
			return { name: "", address: normalizeAddress(t.replace(/^mailto:/i, "")) };
		});
}

export function invalidAddresses(list: EmailAddress[]): EmailAddress[] {
	return list.filter((a) => !isValidAddress(a.address));
}

function dedupe(list: EmailAddress[], exclude: Set<string>): EmailAddress[] {
	const seen = new Set(exclude);
	return list.filter((a) => {
		const key = normalizeAddress(a.address);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/**
 * Who a reply goes to. Replying to your own message re-addresses its
 * recipients; "reply all" adds everyone else, minus this mailbox.
 */
export function replyRecipients(
	message: Pick<MessageDetail, "from" | "to" | "cc" | "replyTo">,
	mailboxAddress: string,
	all: boolean,
): { to: EmailAddress[]; cc: EmailAddress[] } {
	const me = normalizeAddress(mailboxAddress);
	const fromMe = normalizeAddress(message.from.address) === me;
	const primary = fromMe ? message.to : message.replyTo.length ? message.replyTo : [message.from];
	if (!all) {
		const to = dedupe(primary, fromMe ? new Set() : new Set([me]));
		return { to: to.length ? to : dedupe(primary, new Set()), cc: [] };
	}
	const to = dedupe(fromMe ? message.to : [...primary, ...message.to], new Set([me]));
	const cc = dedupe(message.cc, new Set([me, ...to.map((a) => normalizeAddress(a.address))]));
	return { to, cc };
}

/** "Re: Plans" / "Fwd: Plans", without stacking prefixes. */
export function prefixSubject(subject: string, prefix: "Re" | "Fwd"): string {
	const pattern = prefix === "Re" ? /^\s*re\s*:/i : /^\s*(fwd?|fw)\s*:/i;
	return pattern.test(subject) ? subject : `${prefix}: ${subject}`.trimEnd();
}

/** The signature as a block for the editor, separated by "-- " like most mail clients. */
export function signatureHtml(signature: string): string {
	const text = signature.trim();
	return text ? `<p>-- <br>${escapeHtml(text).replace(/\r?\n/g, "<br>")}</p>` : "";
}

/** The editor's initial content: a blank line to type on, then the signature. */
export function initialBody(signature: string): string {
	return `<p></p>${signatureHtml(signature)}`;
}

/**
 * Wraps a message (already sanitised to safe HTML) in the quote block
 * appended below a reply or forward.
 */
export function quoteBlock(
	message: Pick<MessageDetail, "from" | "to" | "cc" | "subject" | "sentAt">,
	safeHtml: string,
	kind: "reply" | "forward",
	formatDate: (ms: number) => string,
): string {
	const who = (a: EmailAddress) =>
		a.name ? `${escapeHtml(a.name)} &lt;<a href="mailto:${escapeHtml(a.address)}">${escapeHtml(a.address)}</a>&gt;` : `<a href="mailto:${escapeHtml(a.address)}">${escapeHtml(a.address)}</a>`;
	if (kind === "forward") {
		const lines = [
			"---------- Forwarded message ---------",
			`From: <strong>${who(message.from)}</strong>`,
			`Date: ${escapeHtml(formatDate(message.sentAt))}`,
			`Subject: ${escapeHtml(message.subject)}`,
			...(message.to.length ? [`To: ${message.to.map(who).join(", ")}`] : []),
			...(message.cc.length ? [`Cc: ${message.cc.map(who).join(", ")}`] : []),
		];
		return `${QUOTE_MARKER}><div>${lines.join("<br>")}</div><br><br>${safeHtml}</div>`;
	}
	return (
		`${QUOTE_MARKER}><div>On ${escapeHtml(formatDate(message.sentAt))}, ${who(message.from)} wrote:<br></div>` +
		`<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${safeHtml}</blockquote></div>`
	);
}

/**
 * Splits a saved draft into the part the editor shows and the quote block
 * after it. The first marker is ours: quoted mail may contain earlier ones
 * nested inside, and the editor strips classes, so what the user typed can't.
 */
export function splitDraftHtml(html: string): { body: string; quote: string | null } {
	const at = html.indexOf(QUOTE_MARKER);
	if (at === -1) return { body: html, quote: null };
	return { body: html.slice(0, at), quote: html.slice(at) };
}

/** Date format used in quote headers: "Mon, Nov 2, 2026 at 3:04 PM". */
export function quoteDate(ms: number): string {
	const d = new Date(ms);
	const date = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
	const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
	return `${date} at ${time}`;
}
