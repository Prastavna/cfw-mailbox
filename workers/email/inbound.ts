import { normalizeAddress } from "../../shared/address";
import { INLINE_HTML_LIMIT, messageKeys, TEXT_LIMIT } from "../mailbox/keys";
import { getMailbox, type IngestInput } from "../mailbox/MailboxDO";
import { SystemLabel } from "../mailbox/schema";
import { getRegistry } from "../registry/RegistryDO";
import { htmlToText, parseMessage, type ParsedMessage } from "./parse";

export { INLINE_HTML_LIMIT, messageKeys };

/** Email Routing caps messages at 25 MiB; refuse anything bigger before reading it. */
export const MAX_INBOUND_BYTES = 25 * 1024 * 1024;
/** A Date header further in the future than this is treated as bogus. */
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

/** The parts of Email Routing's message object we use, so tests can pass a fake one. */
export type InboundMessage = Pick<ForwardableEmailMessage, "from" | "to" | "raw" | "rawSize" | "setReject">;


/**
 * Entry point for mail delivered by Cloudflare Email Routing: check the
 * recipient, parse, put blobs in R2, then file the message in the mailbox.
 * Throwing makes Email Routing report a temporary failure so the sender retries.
 */
export async function handleInbound(message: InboundMessage, env: Env): Promise<void> {
	if (message.rawSize > MAX_INBOUND_BYTES) {
		message.setReject("Message too large");
		return;
	}

	const mailboxEntry = await getRegistry(env).resolveAddress(message.to);
	if (!mailboxEntry) {
		message.setReject("Unknown recipient");
		return;
	}

	const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
	const receivedAt = Date.now();
	const parsed = await parseMessage(raw).catch((err) => {
		console.warn("Unparseable message, storing as raw only", err);
		return unparseable(message);
	});

	const mailbox = getMailbox(env, mailboxEntry.id);
	// Email Routing may redeliver; skip before uploading anything.
	if (parsed.messageId && (await mailbox.hasMessage(parsed.messageId))) return;

	const id = crypto.randomUUID();
	const keys = messageKeys(mailboxEntry.id, id);
	const attachments = parsed.attachments.map((a) => ({ ...a, id: crypto.randomUUID() }));
	const htmlInR2 = parsed.html !== null && parsed.html.length > INLINE_HTML_LIMIT;
	const uploaded = [keys.raw, ...(htmlInR2 ? [keys.html] : []), ...attachments.map((a) => keys.attachment(a.id))];

	try {
		await Promise.all([
			env.BUCKET.put(keys.raw, raw, { httpMetadata: { contentType: "message/rfc822" } }),
			htmlInR2 ? env.BUCKET.put(keys.html, parsed.html!, { httpMetadata: { contentType: "text/html; charset=utf-8" } }) : null,
			...attachments.map((a) => env.BUCKET.put(keys.attachment(a.id), a.content, { httpMetadata: { contentType: a.mimeType } })),
		]);

		const input: IngestInput = {
			id,
			messageId: parsed.messageId,
			inReplyTo: parsed.inReplyTo,
			references: parsed.references,
			from: parsed.from.address ? parsed.from : { name: "", address: normalizeAddress(message.from) },
			to: parsed.to,
			cc: parsed.cc,
			bcc: parsed.bcc,
			replyTo: parsed.replyTo,
			subject: parsed.subject,
			sentAt: parsed.sentAt !== null && parsed.sentAt <= receivedAt + MAX_CLOCK_SKEW_MS ? parsed.sentAt : receivedAt,
			receivedAt,
			// HTML-only mail gets a derived text version, for search and the plain-text fallback.
			text: (parsed.text ?? (parsed.html ? htmlToText(parsed.html) : null))?.slice(0, TEXT_LIMIT) || null,
			html: htmlInR2 ? null : parsed.html,
			htmlKey: htmlInR2 ? keys.html : null,
			rawKey: keys.raw,
			size: raw.byteLength,
			authResults: parsed.authResults,
			attachments: attachments.map(({ content: _content, ...a }) => ({ ...a, r2Key: keys.attachment(a.id) })),
			labelIds: [SystemLabel.INBOX, SystemLabel.UNREAD],
		};

		const result = await mailbox.ingest(input);
		if (result.status === "duplicate") await env.BUCKET.delete(uploaded);
	} catch (err) {
		await env.BUCKET.delete(uploaded).catch(() => {});
		throw err;
	}
}

/** Fallback when MIME parsing fails: keep the message, readable via "Show original". */
function unparseable(message: InboundMessage): ParsedMessage {
	return {
		messageId: null,
		inReplyTo: null,
		references: [],
		from: { name: "", address: normalizeAddress(message.from) },
		to: [{ name: "", address: normalizeAddress(message.to) }],
		cc: [],
		bcc: [],
		replyTo: [],
		subject: "(message could not be displayed)",
		sentAt: null,
		text: "This message couldn't be read. Use “Show original” to see it as received.",
		html: null,
		attachments: [],
		authResults: null,
	};
}
