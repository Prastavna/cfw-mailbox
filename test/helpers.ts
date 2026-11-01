import { env } from "cloudflare:workers";
import type { Mailbox } from "../shared/api";
import type { InboundMessage } from "../workers/email/inbound";
import { getRegistry } from "../workers/registry/RegistryDO";

/** A fresh domain + mailbox, so tests don't share state. */
export async function makeMailbox(): Promise<Mailbox> {
	const domain = `d${crypto.randomUUID().slice(0, 8)}.test`;
	const registry = getRegistry(env);
	await registry.addDomain(domain);
	const result = await registry.createMailbox({ address: `me@${domain}`, displayName: "Me" });
	if (!result.ok) throw new Error(result.message);
	return result.value;
}

export interface EmlAttachment {
	filename: string;
	mimeType: string;
	content: Uint8Array;
	contentId?: string;
	inline?: boolean;
}

export interface EmlOptions {
	from?: string;
	to: string;
	subject?: string;
	messageId?: string;
	inReplyTo?: string;
	references?: string[];
	date?: string;
	text?: string;
	html?: string;
	attachments?: EmlAttachment[];
	extraHeaders?: string[];
}

function base64(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/.{76}/g, "$&\r\n");
}

/** Builds a raw RFC 5322 message with CRLF line endings. */
export function eml(o: EmlOptions): string {
	const headers = [
		`From: ${o.from ?? "Alice <alice@sender.test>"}`,
		`To: ${o.to}`,
		`Subject: ${o.subject ?? "Hello"}`,
		`Date: ${o.date ?? new Date().toUTCString()}`,
		`MIME-Version: 1.0`,
		...(o.messageId ? [`Message-ID: <${o.messageId}>`] : []),
		...(o.inReplyTo ? [`In-Reply-To: <${o.inReplyTo}>`] : []),
		...(o.references?.length ? [`References: ${o.references.map((r) => `<${r}>`).join(" ")}`] : []),
		...(o.extraHeaders ?? []),
	];

	const textPart = (body: string, type: string) =>
		[`Content-Type: ${type}; charset=utf-8`, "Content-Transfer-Encoding: 8bit", "", body].join("\r\n");

	const multipart = (subtype: string, parts: string[]) => {
		const boundary = `b-${crypto.randomUUID()}`;
		return {
			contentType: `multipart/${subtype}; boundary="${boundary}"`,
			body: parts.map((p) => `--${boundary}\r\n${p}`).join("\r\n") + `\r\n--${boundary}--`,
		};
	};

	const bodyParts: string[] = [];
	if (o.text !== undefined) bodyParts.push(textPart(o.text, "text/plain"));
	if (o.html !== undefined) bodyParts.push(textPart(o.html, "text/html"));
	if (!bodyParts.length) bodyParts.push(textPart("", "text/plain"));
	if (bodyParts.length === 2) {
		// Text and HTML are alternative renderings of the same content.
		const alt = multipart("alternative", bodyParts);
		bodyParts.splice(0, 2, `Content-Type: ${alt.contentType}\r\n\r\n${alt.body}`);
	}

	const attachmentParts = (o.attachments ?? []).map((a) =>
		[
			`Content-Type: ${a.mimeType}; name="${a.filename}"`,
			`Content-Disposition: ${a.inline ? "inline" : "attachment"}; filename="${a.filename}"`,
			...(a.contentId ? [`Content-ID: <${a.contentId}>`] : []),
			"Content-Transfer-Encoding: base64",
			"",
			base64(a.content),
		].join("\r\n"),
	);

	let body: string;
	if (bodyParts.length === 1 && !attachmentParts.length) {
		// Single part: its headers become the message's own.
		const part = bodyParts[0]!;
		const split = part.indexOf("\r\n\r\n");
		headers.push(...part.slice(0, split).split("\r\n"));
		body = part.slice(split + 4);
	} else {
		const mixed = multipart("mixed", [...bodyParts, ...attachmentParts]);
		headers.push(`Content-Type: ${mixed.contentType}`);
		body = mixed.body;
	}
	return `${headers.join("\r\n")}\r\n\r\n${body}\r\n`;
}

/** A stand-in for Email Routing's ForwardableEmailMessage. */
export function inbound(raw: string, to: string, from = "alice@sender.test") {
	const bytes = new TextEncoder().encode(raw);
	const rejected: string[] = [];
	const message: InboundMessage = {
		from,
		to,
		raw: new Blob([bytes]).stream(),
		rawSize: bytes.byteLength,
		setReject: (reason: string) => void rejected.push(reason),
	};
	return { message, rejected };
}

// 1×1 transparent PNG.
export const PNG = Uint8Array.from(
	atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="),
	(c) => c.charCodeAt(0),
);
