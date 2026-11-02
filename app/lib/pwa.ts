/**
 * The installable app: the service worker (public/sw.js), offline mail, new-mail
 * notifications and the install prompt. Everything here is per browser ("this device").
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { PushConfig, PushSubscriptionState, ThreadPage } from "../../shared/api";
import { apiFetch, apiUrl, PAGE_SIZE } from "./api";

// Cache names and keys shared with public/sw.js.
const SHELL_CACHE = "cfw-shell-v1";
const SHELL_PAGE = "/__sw/shell";
const DATA_CACHE = "cfw-data-v1";
const META_CACHE = "cfw-meta";
const OFFLINE_FLAG = "/__sw/offline";
const PUSH_MAILBOXES = "/__sw/push-mailboxes";

const isDemo = !!import.meta.env.VITE_DEMO;

// primeShellCache reads what the page loaded from resource timing; keep more than the default 250.
if (typeof performance !== "undefined") performance.setResourceTimingBufferSize?.(2000);

export const swSupported = () => !isDemo && typeof navigator !== "undefined" && "serviceWorker" in navigator && "caches" in window;

export function registerServiceWorker(): void {
	if (!swSupported()) return;
	const controlled = !!navigator.serviceWorker.controller;
	navigator.serviceWorker
		.register("/sw.js", { scope: "/" })
		.then(async () => {
			// This page loaded before the worker could see it; save it so the app opens offline.
			if (!controlled) await navigator.serviceWorker.ready.then(() => primeShellCache());
		})
		.catch((err) => console.warn("Service worker not registered", err));
}

/**
 * Saves this page and the code it loaded, as the service worker would have had it been in
 * control when they loaded (the first visit, or before offline mail was turned on).
 */
interface RouterManifest {
	entry: { module: string; imports?: string[]; css?: string[] };
	routes: Record<string, { module: string; imports?: string[]; css?: string[] } | undefined>;
}

export async function primeShellCache(): Promise<void> {
	const cache = await caches.open(SHELL_CACHE);
	const page = new URL(location.href);
	page.search = "";
	page.hash = "";
	const res = await fetch(page.href, { credentials: "same-origin" }).catch(() => null);
	if (res?.ok && !res.redirected && res.headers.get("content-type")?.includes("text/html")) {
		const html = await res.text().catch(() => null);
		if (html !== null) {
			const copy = () => new Response(html, { headers: res.headers });
			await Promise.all([cache.put(page.href, copy()), cache.put(SHELL_PAGE, copy())]);
		}
	}
	// What this page loaded, and the code of every screen, so all of them open offline.
	const loaded = performance
		.getEntriesByType("resource")
		.map((e) => e as PerformanceResourceTiming)
		.filter((e) => ["script", "link", "css", "other"].includes(e.initiatorType))
		.map((e) => e.name);
	const manifest = (window as { __reactRouterManifest?: RouterManifest }).__reactRouterManifest;
	const routes = manifest
		? [manifest.entry, ...Object.values(manifest.routes)].flatMap((r) => [
				r?.module,
				// The dev server loads lazy route modules with this suffix.
				...(import.meta.env.DEV && r?.module ? [`${r.module}?import`] : []),
				...(r?.imports ?? []),
				...(r?.css ?? []),
			])
		: [];
	const code = [...loaded, ...routes]
		.filter((u): u is string => !!u)
		.map((u) => new URL(u, location.origin))
		.filter((u) => u.origin === location.origin && !u.pathname.startsWith("/api/") && !u.pathname.startsWith("/cdn-cgi/"))
		.map((u) => u.href);
	await Promise.all(
		[...new Set(code)].map(async (url) => {
			try {
				if (await cache.match(url, { ignoreVary: true })) return;
				const r = await fetch(url, { credentials: "same-origin" });
				if (r.ok) await cache.put(url, r);
			} catch {
				// Best effort: one missing file shouldn't stop the rest.
			}
		}),
	);
}

/** Navigation requests from the service worker (a clicked notification), done without a reload. */
export function useServiceWorkerNavigation(navigate: (path: string) => void): void {
	useEffect(() => {
		if (!swSupported()) return;
		const onMessage = (e: MessageEvent) => {
			const path = e.data?.type === "navigate" && typeof e.data.path === "string" ? (e.data.path as string) : null;
			if (path?.startsWith("/")) navigate(path);
		};
		navigator.serviceWorker.addEventListener("message", onMessage);
		return () => navigator.serviceWorker.removeEventListener("message", onMessage);
	}, [navigate]);
}

// ---- Offline mail ---------------------------------------------------------------------

const OFFLINE_KEY = "cfw-mailbox:offline";
const offlineListeners = new Set<() => void>();

function readOffline(): boolean {
	try {
		return localStorage.getItem(OFFLINE_KEY) === "1";
	} catch {
		return false;
	}
}

/** Turns offline mail on or off for this browser. Off deletes the mail saved so far. */
export async function setOfflineMail(enabled: boolean): Promise<void> {
	const meta = await caches.open(META_CACHE);
	if (enabled) {
		await meta.put(OFFLINE_FLAG, new Response("1"));
		await primeShellCache().catch(() => {});
	}
	else {
		await meta.delete(OFFLINE_FLAG);
		await caches.delete(DATA_CACHE);
	}
	try {
		localStorage.setItem(OFFLINE_KEY, enabled ? "1" : "0");
	} catch {
		// The cache flag above is what the service worker reads.
	}
	offlineListeners.forEach((l) => l());
}

export function useOfflineMail(): boolean {
	return useSyncExternalStore(
		(l) => {
			offlineListeners.add(l);
			return () => offlineListeners.delete(l);
		},
		readOffline,
		() => false,
	);
}

/** How many of the newest Inbox conversations are kept up to date for offline reading. */
const OFFLINE_THREADS = PAGE_SIZE;

/**
 * Saves the Inbox's newest conversations for offline reading. Requests go through the
 * service worker, which keeps the answers; ones saved since their last message are skipped.
 */
export async function syncOfflineMail(mailboxId: string, signal: AbortSignal): Promise<number> {
	// What the app needs before it can show anything.
	await Promise.all(
		["/me", `/mailboxes/${mailboxId}/labels`, `/mailboxes/${mailboxId}/settings`].map((p) => fetch(apiUrl(p), { signal }).catch(() => null)),
	);
	const params = new URLSearchParams({ label: "INBOX", limit: String(PAGE_SIZE) });
	const page = await apiFetch<ThreadPage>(`/mailboxes/${mailboxId}/threads?${params}`, { signal });
	const cache = await caches.open(DATA_CACHE);
	const stale: string[] = [];
	for (const t of page.threads.slice(0, OFFLINE_THREADS)) {
		const url = new URL(apiUrl(`/mailboxes/${mailboxId}/threads/${t.id}`), location.origin).href;
		const saved = Number((await cache.match(url))?.headers.get("x-cfw-saved-at") ?? 0);
		if (saved < t.lastMessageAt) stale.push(url);
	}
	// A few at a time, to stay well inside the API's request budget.
	let done = 0;
	const worker = async () => {
		while (stale.length && !signal.aborted) {
			const url = stale.shift()!;
			const res = await fetch(url, { signal }).catch(() => null);
			if (res?.ok) done++;
		}
	};
	await Promise.all([worker(), worker(), worker()]);
	return done;
}

/** Keeps the Inbox saved while offline mail is on: now, when the connection returns, and every few minutes. */
export function useOfflineSync(mailboxId: string, live: string): void {
	const enabled = useOfflineMail();
	useEffect(() => {
		if (!enabled || !swSupported() || live !== "live") return;
		const controller = new AbortController();
		const run = () => void syncOfflineMail(mailboxId, controller.signal).catch(() => {});
		const first = setTimeout(run, 3_000);
		const every = setInterval(run, 5 * 60_000);
		return () => {
			controller.abort();
			clearTimeout(first);
			clearInterval(every);
		};
	}, [enabled, mailboxId, live]);
}

// ---- Notifications --------------------------------------------------------------------

export type PushSupport =
	| { ok: true }
	/** iPhone and iPad only deliver web notifications to apps added to the Home Screen. */
	| { ok: false; reason: "install-first" | "unsupported" | "insecure" };

export function pushSupport(): PushSupport {
	if (!swSupported()) return { ok: false, reason: "unsupported" };
	if (!window.isSecureContext) return { ok: false, reason: "insecure" };
	const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
	const standalone = matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
	if (!("PushManager" in window) || !("Notification" in window)) {
		return { ok: false, reason: ios && !standalone ? "install-first" : "unsupported" };
	}
	return { ok: true };
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
	const b64 = base64url.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((base64url.length + 3) % 4);
	return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function currentSubscription(): Promise<PushSubscription | null> {
	const reg = await navigator.serviceWorker.ready;
	return reg.pushManager.getSubscription();
}

async function rememberPushMailboxes(ids: string[]) {
	await (await caches.open(META_CACHE)).put(PUSH_MAILBOXES, new Response(JSON.stringify(ids)));
}

async function saveSubscription(sub: PushSubscription, mailboxIds: string[]): Promise<string[]> {
	const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
	const state = await apiFetch<PushSubscriptionState>("/push/subscription", {
		method: "PUT",
		body: JSON.stringify({ subscription: { endpoint: json.endpoint, keys: json.keys }, mailboxIds }),
	});
	await rememberPushMailboxes(state.mailboxIds);
	return state.mailboxIds;
}

export interface PushState {
	support: PushSupport;
	permission: NotificationPermission | "unsupported";
	/** Whether this browser is notified about this mailbox; null while checking. */
	enabled: boolean | null;
	busy: boolean;
	setEnabled: (on: boolean) => Promise<void>;
	sendTest: () => Promise<void>;
}

/** New-mail notifications for one mailbox on this browser. */
export function usePush(mailboxId: string): PushState {
	const [support] = useState<PushSupport>(() => (typeof window === "undefined" ? { ok: false, reason: "unsupported" } : pushSupport()));
	const [permission, setPermission] = useState<PushState["permission"]>(() =>
		typeof Notification === "undefined" ? "unsupported" : Notification.permission,
	);
	const [enabled, setEnabledState] = useState<boolean | null>(support.ok ? null : false);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (!support.ok) return;
		let cancelled = false;
		(async () => {
			const sub = await currentSubscription();
			if (!sub) return false;
			const state = await apiFetch<PushSubscriptionState>(`/push/subscription?endpoint=${encodeURIComponent(sub.endpoint)}`);
			return state.mailboxIds.includes(mailboxId);
		})()
			.then((on) => !cancelled && setEnabledState(on))
			.catch(() => !cancelled && setEnabledState(false));
		return () => {
			cancelled = true;
		};
	}, [support.ok, mailboxId]);

	const setEnabled = useCallback(
		async (on: boolean) => {
			setBusy(true);
			try {
				if (on) {
					const result = await Notification.requestPermission();
					setPermission(result);
					if (result !== "granted") throw new Error("Notifications are blocked for this site. Allow them in your browser's site settings.");
					const reg = await navigator.serviceWorker.ready;
					const { publicKey } = await apiFetch<PushConfig>("/push");
					let sub = await reg.pushManager.getSubscription();
					// A subscription made for another server key can't receive our pushes.
					const subKey = sub?.options.applicationServerKey;
					if (sub && subKey && !sameBytes(new Uint8Array(subKey), keyBytes(publicKey))) {
						await sub.unsubscribe();
						sub = null;
					}
					sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
					const state = await apiFetch<PushSubscriptionState>(`/push/subscription?endpoint=${encodeURIComponent(sub.endpoint)}`);
					const ids = await saveSubscription(sub, [...new Set([...state.mailboxIds, mailboxId])]);
					setEnabledState(ids.includes(mailboxId));
				} else {
					const sub = await currentSubscription();
					if (sub) {
						const state = await apiFetch<PushSubscriptionState>(`/push/subscription?endpoint=${encodeURIComponent(sub.endpoint)}`);
						const rest = state.mailboxIds.filter((id) => id !== mailboxId);
						await saveSubscription(sub, rest);
						if (!rest.length) await sub.unsubscribe();
					}
					setEnabledState(false);
				}
			} finally {
				setBusy(false);
			}
		},
		[mailboxId],
	);

	const sendTest = useCallback(async () => {
		const sub = await currentSubscription();
		if (!sub) throw new Error("Turn notifications on first");
		await apiFetch("/push/test", { method: "POST", body: JSON.stringify({ endpoint: sub.endpoint }) });
	}, []);

	return { support, permission, enabled, busy, setEnabled, sendTest };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((x, i) => x === b[i]);
}

// ---- Install ----------------------------------------------------------------------------

interface BeforeInstallPromptEvent extends Event {
	prompt: () => Promise<void>;
	userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let installEvent: BeforeInstallPromptEvent | null = null;
const installListeners = new Set<() => void>();
if (typeof window !== "undefined") {
	window.addEventListener("beforeinstallprompt", (e) => {
		e.preventDefault();
		installEvent = e as BeforeInstallPromptEvent;
		installListeners.forEach((l) => l());
	});
	window.addEventListener("appinstalled", () => {
		installEvent = null;
		installListeners.forEach((l) => l());
	});
}

/** The browser's "Install app" prompt, when it offers one; null otherwise (or once installed). */
export function useInstallPrompt(): (() => Promise<void>) | null {
	const available = useSyncExternalStore(
		(l) => {
			installListeners.add(l);
			return () => installListeners.delete(l);
		},
		() => installEvent !== null,
		() => false,
	);
	if (!available) return null;
	return async () => {
		const e = installEvent;
		if (!e) return;
		await e.prompt();
		await e.userChoice;
		installEvent = null;
		installListeners.forEach((l) => l());
	};
}
