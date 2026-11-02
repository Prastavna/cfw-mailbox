import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PushConfig, PushPayload, PushSubscriptionState } from "../shared/api";
import { handleInbound } from "../workers/email/inbound";
import { pushTransport } from "../workers/push/notify";
import { encryptPayload, fromBase64Url, isAllowedPushEndpoint, toBase64Url, vapidAuthorization, generateVapidKeys } from "../workers/push/webpush";
import { getRegistry } from "../workers/registry/RegistryDO";
import { eml, inbound, makeMailbox } from "./helpers";
const TEST_ADMIN = "admin@example.test";

const BASE = "http://localhost";
const call = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`${BASE}${path}`, init));
const send = (path: string, body: unknown, method = "POST") =>
	call(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const enc = new TextEncoder();

async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, bytes: number) {
	const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
	return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/** A browser's side of Web Push: its keys, and decryption as RFC 8291 describes it. */
async function fakeBrowser(endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`) {
	const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
	const publicRaw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
	const auth = crypto.getRandomValues(new Uint8Array(16));
	const subscription = { endpoint, keys: { p256dh: toBase64Url(publicRaw), auth: toBase64Url(auth) } };

	async function decrypt(body: Uint8Array<ArrayBuffer>): Promise<string> {
		const salt = body.slice(0, 16);
		const idlen = body[20]!;
		const asPublic = body.slice(21, 21 + idlen);
		const ciphertext = body.slice(21 + idlen);
		const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
		const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, pair.privateKey, 256));
		const info = new Uint8Array([...enc.encode("WebPush: info\0"), ...publicRaw, ...asPublic]);
		const ikm = await hkdf(auth, secret, info, 32);
		const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
		const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
		const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
		const padded = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext));
		expect(padded.at(-1)).toBe(2);
		return new TextDecoder().decode(padded.slice(0, -1));
	}
	return { subscription, decrypt };
}

interface Sent {
	url: string;
	headers: Headers;
	body: Uint8Array<ArrayBuffer>;
}
let sent: Sent[] = [];
let status = 201;
const realSend = pushTransport.send;
beforeEach(() => {
	sent = [];
	status = 201;
	pushTransport.send = async (url, init) => {
		sent.push({ url, headers: new Headers(init.headers), body: new Uint8Array(init.body as Uint8Array) });
		return new Response(null, { status });
	};
});
afterEach(() => {
	pushTransport.send = realSend;
});

describe("web push primitives", () => {
	it("encrypts a payload the browser can open", async () => {
		const browser = await fakeBrowser();
		const body = await encryptPayload(browser.subscription.keys, enc.encode("héllo"));
		expect(await browser.decrypt(body)).toBe("héllo");
	});

	it("signs a VAPID token for the push service's origin", async () => {
		const keys = await generateVapidKeys();
		const header = await vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", keys, "mailto:me@example.test");
		const [, t, k] = header.match(/^vapid t=([^,]+), k=(.+)$/)!;
		expect(k).toBe(keys.publicKey);
		const [h, c, sig] = t!.split(".");
		const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(c!)));
		expect(claims).toMatchObject({ aud: "https://fcm.googleapis.com", sub: "mailto:me@example.test" });
		const pub = await crypto.subtle.importKey("raw", fromBase64Url(keys.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
		expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, fromBase64Url(sig!), enc.encode(`${h}.${c}`))).toBe(true);
	});

	it("only delivers to known push services", () => {
		expect(isAllowedPushEndpoint("https://fcm.googleapis.com/fcm/send/x")).toBe(true);
		expect(isAllowedPushEndpoint("https://web.push.apple.com/abc")).toBe(true);
		expect(isAllowedPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true);
		expect(isAllowedPushEndpoint("http://fcm.googleapis.com/x")).toBe(false);
		expect(isAllowedPushEndpoint("https://evil.test/fcm.googleapis.com")).toBe(false);
		expect(isAllowedPushEndpoint("https://fcm.googleapis.com.evil.test/x")).toBe(false);
	});
});

describe("new-mail notifications", () => {
	async function setup() {
		const mb = await makeMailbox();
		const browser = await fakeBrowser();
		const deliver = async (opts: Omit<Parameters<typeof eml>[0], "to">) => {
			const { message } = inbound(eml({ to: mb.address, ...opts }), mb.address);
			await handleInbound(message, env);
		};
		return { mb, browser, deliver };
	}

	it("subscribes a browser and pushes an encrypted notification for new mail", async () => {
		const { mb, browser, deliver } = await setup();
		const config = await (await call("/api/push")).json<PushConfig>();
		expect(config.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
		expect((await (await call("/api/push")).json<PushConfig>()).publicKey).toBe(config.publicKey);

		const saved = await send("/api/push/subscription", { subscription: browser.subscription, mailboxIds: [mb.id, "not-a-mailbox"] }, "PUT");
		expect(saved.status).toBe(200);
		expect(await saved.json<PushSubscriptionState>()).toEqual({ mailboxIds: [mb.id] });
		const state = await (await call(`/api/push/subscription?endpoint=${encodeURIComponent(browser.subscription.endpoint)}`)).json();
		expect(state).toEqual({ mailboxIds: [mb.id] });

		await deliver({ from: "Alice <alice@sender.test>", subject: "Lunch?", text: "Are you free on Friday?" });
		expect(sent).toHaveLength(1);
		const [push] = sent;
		expect(push!.url).toBe(browser.subscription.endpoint);
		expect(push!.headers.get("content-encoding")).toBe("aes128gcm");
		expect(push!.headers.get("authorization")).toMatch(new RegExp(`^vapid t=.+, k=${config.publicKey}$`));
		const payload = JSON.parse(await browser.decrypt(push!.body)) as PushPayload;
		expect(payload).toMatchObject({ type: "mail", mailboxId: mb.id, mailboxAddress: mb.address, title: "Alice", body: "Lunch?\nAre you free on Friday?" });
		expect(push!.headers.get("topic")).toBe((payload as { threadId: string }).threadId.replace(/-/g, "").slice(0, 32));
	});

	it("stays quiet for mail a filter archives, and after notifications are turned off", async () => {
		const { mb, browser, deliver } = await setup();
		await send("/api/push/subscription", { subscription: browser.subscription, mailboxIds: [mb.id] }, "PUT");
		await send(`/api/mailboxes/${mb.id}/filters`, { query: "from:news@sender.test", actions: { archive: true } });
		await deliver({ from: "news@sender.test", subject: "Weekly digest" });
		expect(sent).toHaveLength(0);

		await send("/api/push/subscription/remove", { endpoint: browser.subscription.endpoint });
		await deliver({ subject: "Hello again" });
		expect(sent).toHaveLength(0);
	});

	it("forgets browsers the push service says are gone", async () => {
		const { mb, browser, deliver } = await setup();
		await send("/api/push/subscription", { subscription: browser.subscription, mailboxIds: [mb.id] }, "PUT");
		status = 410;
		await deliver({ subject: "One" });
		expect(sent).toHaveLength(1);
		await deliver({ subject: "Two" });
		expect(sent).toHaveLength(1);
	});

	it("only notifies people who can still open the mailbox", async () => {
		const { mb, browser, deliver } = await setup();
		const registry = getRegistry(env);
		const bob = "bob@people.test";
		await registry.savePushSubscription(bob, { endpoint: browser.subscription.endpoint, ...browser.subscription.keys }, [mb.id]);
		await deliver({ subject: "Not for Bob" });
		expect(sent).toHaveLength(0);

		await registry.setMember(mb.id, bob, "member");
		await deliver({ subject: "For Bob" });
		expect(sent).toHaveLength(1);

		await registry.removeMember(mb.id, bob);
		await deliver({ subject: "Bob left" });
		expect(sent).toHaveLength(1);
	});

	it("refuses unknown push services and other people's subscriptions", async () => {
		const { mb, browser } = await setup();
		const bad = await send(
			"/api/push/subscription",
			{ subscription: { ...browser.subscription, endpoint: "https://attacker.test/hook" }, mailboxIds: [mb.id] },
			"PUT",
		);
		expect(bad.status).toBe(400);

		await getRegistry(env).savePushSubscription("someone@else.test", { endpoint: browser.subscription.endpoint, ...browser.subscription.keys }, [mb.id]);
		const state = await (await call(`/api/push/subscription?endpoint=${encodeURIComponent(browser.subscription.endpoint)}`)).json();
		expect(state).toEqual({ mailboxIds: [] });
		expect((await send("/api/push/test", { endpoint: browser.subscription.endpoint })).status).toBe(404);
		// Removing someone else's browser does nothing.
		await send("/api/push/subscription/remove", { endpoint: browser.subscription.endpoint });
		expect(await getRegistry(env).getPushSubscription("someone@else.test", browser.subscription.endpoint)).not.toBeNull();
	});

	it("sends a test notification on request", async () => {
		const { mb, browser } = await setup();
		await send("/api/push/subscription", { subscription: browser.subscription, mailboxIds: [mb.id] }, "PUT");
		expect((await send("/api/push/test", { endpoint: browser.subscription.endpoint })).status).toBe(204);
		expect(JSON.parse(await browser.decrypt(sent[0]!.body))).toMatchObject({ type: "test" });
		expect(sent[0]!.headers.get("authorization")).toContain("vapid t=");
		const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(sent[0]!.headers.get("authorization")!.split(/[ .,]/)[2]!)));
		expect(claims.sub).toBe(`mailto:${TEST_ADMIN}`);
	});
});
