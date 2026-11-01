import { getRegistry } from "../registry/RegistryDO";

/** Email Routing caps messages at 25 MiB; refuse anything bigger before reading it. */
export const MAX_INBOUND_BYTES = 25 * 1024 * 1024;

/**
 * Entry point for mail delivered by Cloudflare Email Routing.
 *
 * Phase 0 checks the recipient and keeps a copy of the raw message in R2, so
 * nothing is lost before parsing and threading arrive in Phase 1.
 */
export async function handleInbound(message: ForwardableEmailMessage, env: Env): Promise<void> {
	if (message.rawSize > MAX_INBOUND_BYTES) {
		message.setReject("Message too large");
		return;
	}

	const mailbox = await getRegistry(env).resolveAddress(message.to);
	if (!mailbox) {
		message.setReject("Unknown recipient");
		return;
	}

	const key = `raw/${mailbox.id}/pending/${Date.now()}-${crypto.randomUUID()}.eml`;
	await env.BUCKET.put(key, message.raw, {
		httpMetadata: { contentType: "message/rfc822" },
		customMetadata: { from: message.from, to: message.to },
	});
}
