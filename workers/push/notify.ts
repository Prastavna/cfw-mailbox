import type { EmailAddress, PushPayload } from "../../shared/api";
import { adminEmails } from "../auth/access";
import { getRegistry } from "../registry/RegistryDO";
import { encryptPayload, MAX_PUSH_PLAINTEXT, type PushSubscriptionKeys, vapidAuthorization, type VapidKeys } from "./webpush";

/** How the Worker reaches push services. Tests replace `send`. */
export const pushTransport = {
	send: (url: string, init: RequestInit): Promise<Response> => fetch(url, init),
};

export type PushOutcome = "sent" | "gone" | "failed";

/** Encrypts and delivers one notification to one browser. */
export async function sendPush(
	sub: PushSubscriptionKeys,
	payload: PushPayload,
	vapid: VapidKeys,
	subject: string,
	options: { topic?: string; ttlSeconds?: number } = {},
): Promise<PushOutcome> {
	const body = await encryptPayload(sub, fitPayload(payload));
	const headers: Record<string, string> = {
		Authorization: await vapidAuthorization(sub.endpoint, vapid, subject),
		"Content-Encoding": "aes128gcm",
		"Content-Type": "application/octet-stream",
		TTL: String(options.ttlSeconds ?? 24 * 3600),
		Urgency: "normal",
	};
	// A newer notification for the same conversation replaces one still waiting at the push service.
	if (options.topic) headers.Topic = options.topic.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
	try {
		const res = await pushTransport.send(sub.endpoint, { method: "POST", headers, body });
		// 404 and 410: the browser unsubscribed or the subscription expired.
		if (res.status === 404 || res.status === 410) return "gone";
		if (!res.ok) {
			console.warn("Push failed", { host: new URL(sub.endpoint).host, status: res.status });
			return "failed";
		}
		return "sent";
	} catch (err) {
		console.warn("Push failed", { host: new URL(sub.endpoint).host, err: String(err) });
		return "failed";
	}
}

/** Shortens the text until the JSON fits in one push message. */
function fitPayload(payload: PushPayload): Uint8Array<ArrayBuffer> {
	const enc = new TextEncoder();
	let p = payload;
	for (;;) {
		const bytes = enc.encode(JSON.stringify(p));
		if (bytes.length <= MAX_PUSH_PLAINTEXT || (!p.body && p.title.length <= 100)) return bytes;
		p = p.body ? { ...p, body: p.body.slice(0, Math.floor(p.body.length / 2)) } : { ...p, title: p.title.slice(0, 100) };
	}
}

/**
 * Tells every browser subscribed to this mailbox that a message arrived. Never throws: a
 * notification that can't be sent must not fail delivery.
 */
export async function notifyNewMail(
	env: Env,
	mailbox: { id: string; address: string },
	message: { threadId: string; from: EmailAddress; subject: string; snippet: string },
): Promise<void> {
	try {
		const registry = getRegistry(env);
		const targets = await registry.pushTargets(mailbox.id, [...adminEmails(env)]);
		if (!targets.length) return;
		const vapid = await registry.vapidKeys();
		const payload: PushPayload = {
			type: "mail",
			mailboxId: mailbox.id,
			mailboxAddress: mailbox.address,
			threadId: message.threadId,
			title: message.from.name || message.from.address || "New message",
			body: [message.subject || "(no subject)", message.snippet].filter(Boolean).join("\n"),
		};
		const outcomes = await Promise.all(
			targets.map((t) => sendPush(t, payload, vapid, `mailto:${mailbox.address}`, { topic: message.threadId.replace(/-/g, "") })),
		);
		await Promise.all(targets.map((t, i) => (outcomes[i] === "gone" ? registry.removePushSubscription(t.endpoint) : null)));
	} catch (err) {
		console.warn("New-mail notification failed", String(err));
	}
}
