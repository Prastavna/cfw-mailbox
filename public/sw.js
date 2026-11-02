// @ts-check
/// <reference lib="webworker" />
/**
 * cfw-mailbox service worker: makes the app installable, opens it without a connection,
 * keeps mail you've read for offline reading (only when "Offline mail" is on for this
 * device), and shows new-mail notifications.
 *
 * Plain JavaScript, served as-is from /sw.js. The page shares its caches: app/lib/pwa.ts
 * writes the settings below and clears saved mail when offline mail is turned off.
 */
const sw = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (self));

/** App code and pages. Fingerprinted assets never change, so old ones are only trimmed. */
const SHELL = "cfw-shell-v1";
/** API responses saved for offline reading. */
const DATA = "cfw-data-v1";
/** Small settings shared with the page. */
const META = "cfw-meta";
const KNOWN = [SHELL, DATA, META];

const OFFLINE_FLAG = "/__sw/offline";
const OWNER = "/__sw/owner";
const PUSH_MAILBOXES = "/__sw/push-mailboxes";
const SHELL_PAGE = "/__sw/shell";

const MAX_ASSETS = 300;
const MAX_DATA = 800;

/** API reads worth keeping offline: who you are, folders, conversation lists and conversations. */
const SAVED_API = [
	/^\/api\/me$/,
	/^\/api\/mailboxes\/[^/]+\/(labels|settings)$/,
	/^\/api\/mailboxes\/[^/]+\/threads$/,
	/^\/api\/mailboxes\/[^/]+\/threads\/[^/]+$/,
	/^\/api\/mailboxes\/[^/]+\/messages\/[^/]+\/attachments\/[^/]+$/,
];

sw.addEventListener("install", () => void sw.skipWaiting());

sw.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			for (const name of await caches.keys()) if (name.startsWith("cfw-") && !KNOWN.includes(name)) await caches.delete(name);
			await sw.clients.claim();
		})(),
	);
});

async function readMeta(key) {
	const res = await (await caches.open(META)).match(key);
	return res ? res.text() : null;
}

const offlineEnabled = async () => (await readMeta(OFFLINE_FLAG)) === "1";

/** Keeps a cache to its newest `max` entries (keys come back oldest first). */
async function trim(name, max) {
	const cache = await caches.open(name);
	const keys = await cache.keys();
	for (const key of keys.slice(0, Math.max(0, keys.length - max))) await cache.delete(key);
}

function savable(url) {
	if (!SAVED_API.some((re) => re.test(url.pathname))) return false;
	// Search results change with every query; folder lists and conversations are what you reread.
	if (url.pathname.endsWith("/threads")) return url.searchParams.has("label") && !url.searchParams.has("q");
	if (url.pathname.includes("/attachments/")) return url.searchParams.get("inline") === "1";
	return true;
}

/** A copy marked with when it was saved, so the page can say how old offline data is. */
async function stamped(res) {
	const headers = new Headers(res.headers);
	headers.set("x-cfw-saved-at", String(Date.now()));
	return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers });
}

/** The saved copy, marked so the page knows it's looking at offline data. */
async function fromCache(cache, request) {
	const hit = await cache.match(request, { ignoreVary: true });
	if (!hit) return null;
	const headers = new Headers(hit.headers);
	headers.set("x-cfw-offline", headers.get("x-cfw-saved-at") ?? "0");
	return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers });
}

/** Saved mail belongs to whoever was signed in; another account on this browser starts afresh. */
async function checkOwner(res) {
	try {
		const { email } = await res.clone().json();
		if (typeof email !== "string") return;
		const meta = await caches.open(META);
		const owner = await readMeta(OWNER);
		if (owner !== email) {
			if (owner !== null) await caches.delete(DATA);
			await meta.put(OWNER, new Response(email));
		}
	} catch {
		// Not JSON; leave things as they are.
	}
}

async function handleApi(request, url) {
	if (!(await offlineEnabled())) return fetch(request);
	const cache = await caches.open(DATA);
	let res;
	try {
		res = await fetch(request);
	} catch (err) {
		const saved = await fromCache(cache, request);
		if (saved) return saved;
		throw err;
	}
	if (res.ok && res.type === "basic") {
		if (url.pathname === "/api/me") await checkOwner(res);
		await cache.put(request, await stamped(res.clone()));
		if (Math.random() < 0.05) void trim(DATA, MAX_DATA);
	}
	return res;
}

async function handleNavigation(event) {
	const cache = await caches.open(SHELL);
	const key = new URL(event.request.url);
	key.search = "";
	try {
		const res = await fetch(event.request);
		// Only the app's own pages: not a sign-in redirect, not an error.
		if (res.ok && res.type === "basic" && !res.redirected && res.headers.get("content-type")?.includes("text/html")) {
			event.waitUntil(Promise.all([cache.put(key.href, res.clone()), cache.put(SHELL_PAGE, res.clone())]));
		}
		return res;
	} catch {
		// Offline: this page as last seen, or any page of the app (it routes in the browser).
		return (await cache.match(key.href, { ignoreVary: true })) ?? (await cache.match(SHELL_PAGE, { ignoreVary: true })) ?? Response.error();
	}
}

async function handleAsset(request) {
	const cache = await caches.open(SHELL);
	const hit = await cache.match(request, { ignoreVary: true });
	if (hit) return hit;
	const res = await fetch(request);
	if (res.ok && res.type === "basic") {
		await cache.put(request, res.clone());
		if (Math.random() < 0.05) void trim(SHELL, MAX_ASSETS);
	}
	return res;
}

/** Icons, the manifest and unfingerprinted code: fresh when online, saved otherwise. */
async function handleStatic(request) {
	const cache = await caches.open(SHELL);
	try {
		const res = await fetch(request);
		if (res.ok && res.type === "basic") await cache.put(request, res.clone());
		return res;
	} catch {
		return (await cache.match(request, { ignoreVary: true })) ?? Response.error();
	}
}

sw.addEventListener("fetch", (event) => {
	const { request } = event;
	if (request.method !== "GET") return;
	const url = new URL(request.url);
	if (url.origin !== sw.location.origin) return;

	if (request.mode === "navigate") {
		if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/cdn-cgi/")) return;
		event.respondWith(handleNavigation(event));
	} else if (url.pathname.startsWith("/assets/")) {
		event.respondWith(handleAsset(request));
	} else if (
		url.pathname.startsWith("/icons/") ||
		url.pathname === "/manifest.webmanifest" ||
		url.pathname === "/favicon.ico" ||
		// Unbundled code (the dev server's modules): always fresh, saved for offline use.
		(!url.pathname.startsWith("/api/") && ["script", "style", "font"].includes(request.destination))
	) {
		event.respondWith(handleStatic(request));
	} else if (url.pathname.startsWith("/api/") && savable(url)) {
		event.respondWith(handleApi(request, url));
	}
});

// ---- Notifications ---------------------------------------------------------------

/** @param {any} data */
function notificationFor(data) {
	if (data?.type === "mail") {
		return {
			title: String(data.title || "New message"),
			options: {
				body: String(data.body ?? ""),
				// One notification per conversation; a newer message replaces it.
				tag: `thread:${data.threadId}`,
				data: { url: `/mail/${encodeURIComponent(data.mailboxId)}/inbox/${encodeURIComponent(data.threadId)}` },
			},
		};
	}
	return {
		title: String(data?.title || "Mail"),
		options: { body: String(data?.body ?? ""), tag: "test", data: { url: "/" } },
	};
}

sw.addEventListener("push", (event) => {
	let data = null;
	try {
		data = event.data?.json() ?? null;
	} catch {
		// Not ours; still show something (browsers require a notification for every push).
	}
	const { title, options } = notificationFor(data);
	event.waitUntil(sw.registration.showNotification(title, { icon: "/icons/icon-192.png", badge: "/icons/badge-96.png", ...options }));
});

sw.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const path = event.notification.data?.url ?? "/";
	event.waitUntil(
		(async () => {
			const windows = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
			const open = windows.find((c) => new URL(c.url).origin === sw.location.origin);
			if (open) {
				await open.focus();
				// The page navigates itself, without a reload (app/lib/pwa.ts).
				open.postMessage({ type: "navigate", path });
				return;
			}
			await sw.clients.openWindow(path);
		})(),
	);
});

function keyBytes(base64url) {
	const b64 = base64url.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((base64url.length + 3) % 4);
	return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// The push service replaced this browser's subscription: tell the server the new one.
sw.addEventListener("pushsubscriptionchange", (/** @type {any} */ event) => {
	event.waitUntil(
		(async () => {
			const mailboxIds = JSON.parse((await readMeta(PUSH_MAILBOXES)) ?? "[]");
			if (!mailboxIds.length) return;
			const { publicKey } = await (await fetch("/api/push")).json();
			const subscription =
				event.newSubscription ??
				(await sw.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
			await fetch("/api/push/subscription", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ subscription: subscription.toJSON(), mailboxIds, replaces: event.oldSubscription?.endpoint }),
			});
		})().catch(() => {}),
	);
});
