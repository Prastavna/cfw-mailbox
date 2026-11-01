import type { EmailAddress } from "../../shared/api";

/**
 * Rebuilds an RFC 5322 message from what the mailbox stores. Used for mail that has no raw
 * copy (messages sent from here: Email Service builds those itself), e.g. in the mbox export.
 */
export interface MimeSource {
	from: EmailAddress;
	to: EmailAddress[];
	cc: EmailAddress[];
	bcc: EmailAddress[];
	replyTo: EmailAddress[];
	subject: string;
	date: number;
	messageId: string | null;
	inReplyTo: string | null;
	references: string[];
	text: string | null;
	html: string | null;
	attachments: { filename: string; mimeType: string; disposition: "attachment" | "inline"; contentId: string | null; content: Uint8Array }[];
}

const CRLF = "\r\n";
const encoder = new TextEncoder();

function base64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

/** Base64 wrapped at 76 characters, as MIME requires. */
function base64Lines(bytes: Uint8Array): string {
	return (base64(bytes).match(/.{1,76}/g) ?? []).join(CRLF);
}

const isPrintableAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);

/** RFC 2047 encoded-word for headers that aren't plain ASCII. */
export function encodeHeaderText(value: string): string {
	if (isPrintableAscii(value)) return value;
	// Keep each encoded word under the 75-character limit, splitting on whole characters.
	const words: string[] = [];
	let chunk = "";
	for (const ch of value) {
		if (encoder.encode(chunk + ch).length > 45) {
			words.push(chunk);
			chunk = "";
		}
		chunk += ch;
	}
	if (chunk) words.push(chunk);
	return words.map((w) => `=?UTF-8?B?${base64(encoder.encode(w))}?=`).join(`${CRLF} `);
}

export function formatAddressHeader(list: EmailAddress[]): string {
	return list
		.map((a) => {
			if (!a.name) return a.address;
			const name = isPrintableAscii(a.name) ? `"${a.name.replace(/(["\\])/g, "\\$1")}"` : encodeHeaderText(a.name);
			return `${name} <${a.address}>`;
		})
		.join(`,${CRLF} `);
}

function contentHeaders(type: string, disposition?: string): string {
	return `Content-Type: ${type}${CRLF}Content-Transfer-Encoding: base64${CRLF}${disposition ? `Content-Disposition: ${disposition}${CRLF}` : ""}`;
}

function param(name: string, value: string): string {
	return isPrintableAscii(value) ? `${name}="${value.replace(/(["\\])/g, "\\$1")}"` : `${name}*=UTF-8''${encodeURIComponent(value)}`;
}

export function buildMime(src: MimeSource): Uint8Array<ArrayBuffer> {
	const boundary = (tag: string) => `=_cfw_${tag}_${crypto.randomUUID().replaceAll("-", "")}`;
	const headers: string[] = [
		`From: ${formatAddressHeader([src.from])}`,
		...(src.to.length ? [`To: ${formatAddressHeader(src.to)}`] : []),
		...(src.cc.length ? [`Cc: ${formatAddressHeader(src.cc)}`] : []),
		...(src.bcc.length ? [`Bcc: ${formatAddressHeader(src.bcc)}`] : []),
		...(src.replyTo.length ? [`Reply-To: ${formatAddressHeader(src.replyTo)}`] : []),
		`Subject: ${encodeHeaderText(src.subject)}`,
		`Date: ${new Date(src.date).toUTCString().replace("GMT", "+0000")}`,
		...(src.messageId ? [`Message-ID: <${src.messageId}>`] : []),
		...(src.inReplyTo ? [`In-Reply-To: <${src.inReplyTo}>`] : []),
		...(src.references.length ? [`References: ${src.references.map((r) => `<${r}>`).join(`${CRLF} `)}`] : []),
		"MIME-Version: 1.0",
	];

	const text = src.text ?? "";
	const bodyParts: string[] = [];
	if (src.html !== null) {
		const alt = boundary("alt");
		bodyParts.push(
			`Content-Type: multipart/alternative; boundary="${alt}"${CRLF}${CRLF}` +
				`--${alt}${CRLF}${contentHeaders("text/plain; charset=utf-8")}${CRLF}${base64Lines(encoder.encode(text))}${CRLF}` +
				`--${alt}${CRLF}${contentHeaders("text/html; charset=utf-8")}${CRLF}${base64Lines(encoder.encode(src.html))}${CRLF}` +
				`--${alt}--`,
		);
	} else {
		bodyParts.push(`${contentHeaders("text/plain; charset=utf-8")}${CRLF}${base64Lines(encoder.encode(text))}`);
	}

	let body: string;
	if (src.attachments.length) {
		const mixed = boundary("mixed");
		const parts = [
			...bodyParts,
			...src.attachments.map(
				(a) =>
					contentHeaders(`${a.mimeType}; ${param("name", a.filename)}`, `${a.disposition}; ${param("filename", a.filename)}`) +
					(a.contentId ? `Content-ID: <${a.contentId}>${CRLF}` : "") +
					CRLF +
					base64Lines(a.content),
			),
		];
		body = `Content-Type: multipart/mixed; boundary="${mixed}"${CRLF}${CRLF}${parts.map((p) => `--${mixed}${CRLF}${p}${CRLF}`).join("")}--${mixed}--${CRLF}`;
	} else {
		body = `${bodyParts[0]}${CRLF}`;
	}
	// The body part starts with its own Content-* headers, which become the message's.
	return encoder.encode(`${headers.join(CRLF)}${CRLF}${body}`);
}
