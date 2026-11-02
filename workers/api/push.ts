import { Hono } from "hono";
import { z } from "zod";
import type { PushConfig, PushSubscriptionState } from "../../shared/api";
import { HttpError } from "../lib/http";
import { sendPush } from "../push/notify";
import { isAllowedPushEndpoint } from "../push/webpush";
import { getRegistry } from "../registry/RegistryDO";
import { type AppEnv, parseBody } from "./common";

const Endpoint = z.string().max(2048).refine(isAllowedPushEndpoint, "Unsupported push service");
const Base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/, "Invalid key");

const SaveBody = z.object({
	subscription: z.object({
		endpoint: Endpoint,
		keys: z.object({ p256dh: Base64Url.min(80).max(100), auth: Base64Url.min(16).max(64) }),
	}),
	mailboxIds: z.array(z.string().min(1).max(100)).max(200),
	replaces: z.string().max(2048).optional(),
});
const EndpointBody = z.object({ endpoint: z.string().max(2048) });

/** /api/push: each user's own browsers; signed-in users only (the API's auth runs first). */
export const pushRoutes = new Hono<AppEnv>();

pushRoutes.get("/", async (c) => c.json<PushConfig>({ publicKey: (await getRegistry(c.env).vapidKeys()).publicKey }));

pushRoutes.get("/subscription", async (c) => {
	const endpoint = c.req.query("endpoint") ?? "";
	const sub = endpoint ? await getRegistry(c.env).getPushSubscription(c.get("identity").email, endpoint) : null;
	return c.json<PushSubscriptionState>({ mailboxIds: sub?.mailboxIds ?? [] });
});

pushRoutes.put("/subscription", async (c) => {
	const { subscription, mailboxIds, replaces } = await parseBody(c.req.raw, SaveBody);
	const { email, isAdmin } = c.get("identity");
	const registry = getRegistry(c.env);
	// Only mailboxes this user may open; access is checked again before each notification.
	const allowed = new Set((await registry.mailboxesFor(email, isAdmin)).map((m) => m.id));
	const ids = [...new Set(mailboxIds)].filter((id) => allowed.has(id));
	await registry.savePushSubscription(email, { endpoint: subscription.endpoint, ...subscription.keys }, ids, replaces);
	return c.json<PushSubscriptionState>({ mailboxIds: ids });
});

pushRoutes.post("/subscription/remove", async (c) => {
	const { endpoint } = await parseBody(c.req.raw, EndpointBody);
	await getRegistry(c.env).removePushSubscription(endpoint, c.get("identity").email);
	return c.body(null, 204);
});

/** Sends a sample notification to one of the user's browsers, to check it works. */
pushRoutes.post("/test", async (c) => {
	const { endpoint } = await parseBody(c.req.raw, EndpointBody);
	const { email } = c.get("identity");
	const registry = getRegistry(c.env);
	const sub = await registry.getPushSubscription(email, endpoint);
	if (!sub) throw new HttpError(404, "Turn notifications on first");
	const outcome = await sendPush(
		sub,
		{ type: "test", title: "Notifications are on", body: "New mail will show up like this." },
		await registry.vapidKeys(),
		`mailto:${email}`,
		{ ttlSeconds: 60 },
	);
	if (outcome === "gone") {
		await registry.removePushSubscription(endpoint);
		throw new HttpError(410, "This browser's subscription has expired. Turn notifications off and on again.");
	}
	if (outcome === "failed") throw new HttpError(502, "The browser's push service didn't accept the notification. Try again later.");
	return c.body(null, 204);
});
