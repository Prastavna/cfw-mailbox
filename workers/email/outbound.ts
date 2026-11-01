import type { EmailAddress } from "../../shared/api";

/** A draft ready to go out, as MailboxDO hands it over. Attachment bodies are still in R2. */
export interface OutgoingMessage {
	from: EmailAddress;
	to: EmailAddress[];
	cc: EmailAddress[];
	bcc: EmailAddress[];
	subject: string;
	html: string;
	text: string;
	/** Message-IDs without angle brackets. */
	inReplyTo: string | null;
	references: string[];
	attachments: { filename: string; mimeType: string; disposition: "attachment" | "inline"; contentId: string | null; r2Key: string }[];
}

/** Indirection so tests can capture what would be sent. */
export const transport = {
	send: (env: Env, message: EmailMessageBuilder): Promise<EmailSendResult> => env.EMAIL.send(message),
};

/** Email Service rejects header values over 2048 bytes, so keep the newest references that fit. */
const MAX_HEADER_BYTES = 2000;

function addressField(a: EmailAddress): string | { name: string; email: string } {
	return a.name ? { name: a.name, email: a.address } : a.address;
}

function referencesHeader(ids: string[]): string | null {
	const kept: string[] = [];
	let bytes = 0;
	for (const id of [...ids].reverse()) {
		const token = `<${id}>`;
		if (bytes + token.length + 1 > MAX_HEADER_BYTES) break;
		kept.unshift(token);
		bytes += token.length + 1;
	}
	return kept.length ? kept.join(" ") : null;
}

/** Turns a stored draft into the Email Service payload, loading attachment bodies from R2. */
export async function buildEmail(env: Env, msg: OutgoingMessage): Promise<EmailMessageBuilder> {
	const headers: Record<string, string> = {};
	if (msg.inReplyTo && msg.inReplyTo.length + 2 <= MAX_HEADER_BYTES) headers["In-Reply-To"] = `<${msg.inReplyTo}>`;
	const refs = referencesHeader(msg.references);
	if (refs) headers.References = refs;

	const attachments = await Promise.all(
		msg.attachments.map(async (a) => {
			const object = await env.BUCKET.get(a.r2Key);
			if (!object) throw new SendError("E_ATTACHMENT_MISSING", `Attachment "${a.filename}" is missing`, false);
			return {
				disposition: a.disposition,
				...(a.contentId ? { contentId: a.contentId } : {}),
				filename: a.filename,
				type: a.mimeType,
				content: await object.arrayBuffer(),
			};
		}),
	);

	return {
		from: addressField(msg.from),
		...(msg.to.length ? { to: msg.to.map(addressField) } : {}),
		...(msg.cc.length ? { cc: msg.cc.map(addressField) } : {}),
		...(msg.bcc.length ? { bcc: msg.bcc.map(addressField) } : {}),
		subject: msg.subject,
		html: msg.html,
		text: msg.text,
		...(Object.keys(headers).length ? { headers } : {}),
		...(attachments.length ? { attachments } : {}),
	} as EmailMessageBuilder;
}

export class SendError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly retryable: boolean,
	) {
		super(message);
		this.name = "SendError";
	}
}

/** Email Service error codes we can explain to the person sending. */
const MESSAGES: Record<string, [message: string, retryable: boolean]> = {
	E_SENDER_NOT_VERIFIED: ["This address isn't set up to send mail yet. Onboard its domain to Cloudflare Email Service.", false],
	E_SENDER_DOMAIN_NOT_AVAILABLE: ["This domain isn't set up to send mail yet. Onboard it to Cloudflare Email Service.", false],
	E_RECIPIENT_NOT_ALLOWED: ["A recipient isn't allowed. Until the domain is onboarded, mail can only go to verified addresses.", false],
	E_RECIPIENT_SUPPRESSED: ["A recipient is on the suppression list (an earlier message bounced or was marked as spam).", false],
	E_TOO_MANY_RECIPIENTS: ["Too many recipients: at most 50 across To, Cc and Bcc.", false],
	E_TOO_MANY_ATTACHMENTS: ["Too many attachments: at most 32.", false],
	E_CONTENT_TOO_LARGE: ["The message is too large: at most 25 MB including attachments.", false],
	E_ACCOUNT_SUSPENDED: ["Sending is suspended for this Cloudflare account.", false],
	E_DAILY_LIMIT_EXCEEDED: ["The daily sending limit has been reached. Try again tomorrow.", false],
	E_RATE_LIMIT_EXCEEDED: ["Sending too fast; will retry shortly.", true],
	E_DELIVERY_FAILED: ["Delivery failed.", true],
	E_INTERNAL_SERVER_ERROR: ["Email Service had an internal error.", true],
};

/** Normalises anything `send()` throws into a SendError with a readable message. */
export function describeSendError(err: unknown): SendError {
	if (err instanceof SendError) return err;
	const code = typeof (err as { code?: unknown })?.code === "string" ? (err as { code: string }).code : "E_UNKNOWN";
	const known = MESSAGES[code];
	if (known) return new SendError(code, known[0], known[1]);
	const detail = err instanceof Error ? err.message : String(err);
	// Validation and header errors are about the message itself; retrying won't help.
	const retryable = !/^E_(VALIDATION|FIELD|HEADER)/.test(code);
	return new SendError(code, `Couldn't send: ${detail}`, retryable);
}

/** Strips angle brackets from the ID Email Service returns, to match how inbound Message-IDs are stored. */
export function normalizeMessageId(id: string | undefined | null): string | null {
	const trimmed = id?.trim().replace(/^<|>$/g, "");
	return trimmed ? trimmed : null;
}
