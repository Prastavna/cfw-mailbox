import DOMPurify from "dompurify";
import type { AttachmentInfo } from "../../shared/api";

/**
 * Turns an untrusted HTML email into a self-contained document for a
 * sandboxed iframe (no scripts):
 *
 * - DOMPurify strips scripts, event handlers, forms and embeds.
 * - `cid:` images point at the message's inline attachments.
 * - Remote content (images, CSS backgrounds, fonts) is blocked by a CSP inside
 *   the iframe until the user chooses to display images, so senders can't
 *   track opens.
 * - Links open in a new tab, without referrer.
 * - Gmail-style quoted history is hidden behind a toggle.
 */

export interface RenderOptions {
	inlineImageUrl: (attachment: AttachmentInfo) => string;
	attachments: AttachmentInfo[];
	showRemoteImages: boolean;
	showQuoted: boolean;
}

export interface RenderedEmail {
	/** Full HTML document for the iframe's srcdoc. */
	document: string;
	/** True when the email references remote content that is currently blocked or allowed. */
	hasRemoteContent: boolean;
	/** True when quoted history was found (and hidden unless showQuoted). */
	hasQuoted: boolean;
}

const REMOTE_URL = /^\s*(https?:)?\/\//i;
const CSS_REMOTE_URL = /url\(\s*['"]?\s*(https?:)?\/\//i;
const QUOTE_SELECTORS = [".gmail_quote", "blockquote[type=cite]", ".yahoo_quoted", "#appendonsend", "#divRplyFwdMsg"];

const BASE_STYLE = `
	html, body { margin: 0; padding: 0; background: #fff; }
	body { font: 14px/1.5 Arial, Helvetica, sans-serif; color: #222; overflow-wrap: anywhere; }
	img { max-width: 100%; height: auto; }
	table { max-width: 100%; }
	pre { white-space: pre-wrap; }
	.cfw-hidden-quote { display: none !important; }
`;

function csp(showRemote: boolean): string {
	const remote = showRemote ? " https: http:" : "";
	return [
		"default-src 'none'",
		`img-src 'self' data: blob:${remote}`,
		`style-src 'unsafe-inline'${remote}`,
		`font-src data:${remote}`,
	].join("; ");
}

export function renderEmailHtml(html: string, opts: RenderOptions): RenderedEmail {
	if (typeof window === "undefined") return { document: "", hasRemoteContent: false, hasQuoted: false };

	let hasRemoteContent = false;
	const byCid = new Map(opts.attachments.filter((a) => a.contentId).map((a) => [a.contentId!.toLowerCase(), a]));

	const purify = DOMPurify(window);
	purify.addHook("afterSanitizeAttributes", (node) => {
		const el = node as Element;
		if (el.tagName === "A") {
			el.setAttribute("target", "_blank");
			el.setAttribute("rel", "noopener noreferrer");
		}
		if (el.tagName === "IMG") {
			const src = el.getAttribute("src") ?? "";
			if (src.toLowerCase().startsWith("cid:")) {
				const attachment = byCid.get(decodeURIComponent(src.slice(4)).toLowerCase());
				if (attachment) el.setAttribute("src", opts.inlineImageUrl(attachment));
				else el.removeAttribute("src");
			} else if (REMOTE_URL.test(src)) {
				hasRemoteContent = true;
			}
			el.removeAttribute("srcset");
		}
		if (el.hasAttribute("background") && REMOTE_URL.test(el.getAttribute("background") ?? "")) hasRemoteContent = true;
		if (CSS_REMOTE_URL.test(el.getAttribute("style") ?? "")) hasRemoteContent = true;
	});
	purify.addHook("uponSanitizeElement", (node, data) => {
		if (data.tagName === "style" && CSS_REMOTE_URL.test(node.textContent ?? "")) hasRemoteContent = true;
	});

	const root = purify.sanitize(html, {
		WHOLE_DOCUMENT: true,
		RETURN_DOM: true,
		ADD_TAGS: ["style"],
		ADD_ATTR: ["target"],
		FORBID_TAGS: ["form", "input", "button", "select", "textarea", "iframe", "object", "embed", "base", "meta", "link", "svg", "math"],
		FORBID_ATTR: ["srcset"],
		ALLOW_DATA_ATTR: false,
	}) as HTMLElement;

	const doc = root.ownerDocument;
	const head = root.querySelector("head") ?? root.insertBefore(doc.createElement("head"), root.firstChild);
	const body = root.querySelector("body") ?? root.appendChild(doc.createElement("body"));

	// Hide the last quoted block (earlier messages in the conversation).
	let hasQuoted = false;
	const quote = [...body.querySelectorAll(QUOTE_SELECTORS.join(","))].filter(
		(el) => !el.parentElement?.closest(QUOTE_SELECTORS.join(",")),
	).at(-1);
	if (quote && quote.textContent?.trim() !== body.textContent?.trim()) {
		hasQuoted = true;
		if (!opts.showQuoted) quote.classList.add("cfw-hidden-quote");
	}

	const meta = doc.createElement("meta");
	meta.setAttribute("http-equiv", "Content-Security-Policy");
	meta.setAttribute("content", csp(opts.showRemoteImages));
	const charset = doc.createElement("meta");
	charset.setAttribute("charset", "utf-8");
	const base = doc.createElement("style");
	base.textContent = BASE_STYLE;
	// insertBefore rather than prepend(): the Workers types also declare an Element.prepend with a different signature.
	for (const node of [base, meta, charset]) head.insertBefore(node, head.firstChild);

	return { document: `<!doctype html>${root.outerHTML}`, hasRemoteContent, hasQuoted };
}

// ---- Plain-text bodies ---------------------------------------------------------

const QUOTE_INTRO = /^\s*On .{5,200} wrote:\s*$/;

/** Splits a plain-text body into what's new and the quoted history below it. */
export function splitQuotedText(text: string): { body: string; quoted: string | null } {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	let cut = lines.findIndex((l, i) => QUOTE_INTRO.test(l) && lines.slice(i + 1).some((n) => n.startsWith(">")));
	if (cut === -1) {
		// Trailing block of "> " lines.
		let i = lines.length - 1;
		while (i >= 0 && (lines[i]!.startsWith(">") || !lines[i]!.trim())) i--;
		if (i < lines.length - 1 && lines.slice(i + 1).some((l) => l.startsWith(">"))) cut = i + 1;
	}
	if (cut <= 0) return { body: text.trimEnd(), quoted: null };
	return { body: lines.slice(0, cut).join("\n").trimEnd(), quoted: lines.slice(cut).join("\n").trim() };
}

const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;

/** Splits text into plain strings and URLs, for rendering links in plain-text mail. */
export function linkify(text: string): (string | { url: string })[] {
	const out: (string | { url: string })[] = [];
	let last = 0;
	for (const m of text.matchAll(URL_RE)) {
		if (m.index! > last) out.push(text.slice(last, m.index));
		out.push({ url: m[0] });
		last = m.index! + m[0].length;
	}
	if (last < text.length) out.push(text.slice(last));
	return out;
}
