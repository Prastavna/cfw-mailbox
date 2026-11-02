import type { MailboxEvent } from "../../shared/api";
import { API_BASE, setFileUrlResolver } from "~/lib/api";
import { toVCards } from "../../shared/vcard";
import { createDemoServer } from "./server";
import type { DemoMailbox, StoredMessage } from "./store";
import { DemoWorld } from "./world";

/**
 * Turns the app into a self-contained showcase: the API, the live-update
 * WebSocket and file downloads are all answered in the browser from fake data.
 * Nothing is sent anywhere, and everything resets on reload.
 */
export async function installDemo() {
	const world = new DemoWorld();
	const handle = createDemoServer(world);
	const prefix = `${API_BASE}/`;

	const realFetch = window.fetch.bind(window);
	window.fetch = async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (url.origin === location.origin && url.pathname.startsWith(prefix)) return handle(url.pathname.slice(API_BASE.length), request);
		return realFetch(input, init);
	};

	const RealWebSocket = window.WebSocket;
	const eventsPath = new RegExp(`^${API_BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/mailboxes/([^/]+)/events$`);
	window.WebSocket = function (url: string | URL, protocols?: string | string[]) {
		const match = eventsPath.exec(new URL(url, location.href).pathname);
		if (!match) return new RealWebSocket(url, protocols);
		return new DemoSocket(world.mailboxes.get(match[1]!)?.store) as unknown as WebSocket;
	} as unknown as typeof WebSocket;
	Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });

	setFileUrlResolver((path) => fileUrl(world, path));
	world.startLiveMail();
	showBanner();
}

/** Stands in for the mailbox WebSocket: delivers the store's events. */
class DemoSocket {
	readyState = 0;
	onopen: (() => void) | null = null;
	onmessage: ((e: { data: string }) => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	private unsubscribe?: () => void;

	constructor(store: DemoMailbox | undefined) {
		setTimeout(() => {
			if (!store) {
				this.readyState = 3;
				this.onclose?.();
				return;
			}
			this.readyState = 1;
			this.unsubscribe = store.subscribe((event: MailboxEvent) => this.onmessage?.({ data: JSON.stringify(event) }));
			this.onopen?.();
		}, 150);
	}

	send(data: string) {
		if (data === "ping") setTimeout(() => this.onmessage?.({ data: "pong" }), 0);
	}

	close() {
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.unsubscribe?.();
		this.onclose?.();
	}

	addEventListener() {}
	removeEventListener() {}
}

// ---- Files the browser opens directly -----------------------------------------------

const rawUrls = new Map<string, string>();
let exportUrl: string | null = null;

let vcardUrl: string | null = null;

function fileUrl(world: DemoWorld, path: string): string {
	const [route] = path.split("?");
	const parts = route!.split("/").filter(Boolean); // mailboxes, :id, …
	const box = world.mailboxes.get(parts[1] ?? "")?.store;
	if (!box) return "about:blank";

	if (parts[2] === "export.mbox") {
		if (exportUrl) URL.revokeObjectURL(exportUrl);
		const messages = [...box.messages.values()].filter((m) => !m.labels.has("DRAFT") && !m.labels.has("OUTBOX"));
		const mbox = messages
			.sort((a, b) => a.receivedAt - b.receivedAt)
			.map((m) => `From ${m.from.address} ${new Date(m.receivedAt).toUTCString()}\n${rawMessage(m).replace(/^From /gm, ">From ")}\n`)
			.join("\n");
		exportUrl = URL.createObjectURL(new Blob([mbox], { type: "application/mbox" }));
		return exportUrl;
	}

	if (parts[2] === "address-book.vcf") {
		if (vcardUrl) URL.revokeObjectURL(vcardUrl);
		vcardUrl = URL.createObjectURL(new Blob([toVCards(box.listSavedContacts())], { type: "text/vcard" }));
		return vcardUrl;
	}

	const message = box.messages.get(parts[3] ?? "");
	if (!message) return "about:blank";
	if (parts[4] === "raw") {
		let url = rawUrls.get(message.id);
		if (!url) {
			url = URL.createObjectURL(new Blob([rawMessage(message)], { type: "text/plain;charset=utf-8" }));
			rawUrls.set(message.id, url);
		}
		return url;
	}
	return message.attachments.find((a) => a.id === parts[5])?.dataUrl ?? "about:blank";
}

const addr = (list: { name: string; address: string }[]) => list.map((p) => (p.name ? `"${p.name}" <${p.address}>` : p.address)).join(", ");

function rawMessage(m: StoredMessage): string {
	const boundary = `demo-${m.id.slice(0, 8)}`;
	const headers = [
		`Authentication-Results: mx.example.com; spf=pass; dkim=pass; dmarc=pass`,
		`From: ${addr([m.from])}`,
		`To: ${addr(m.to)}`,
		...(m.cc.length ? [`Cc: ${addr(m.cc)}`] : []),
		`Subject: ${m.subject}`,
		`Date: ${new Date(m.sentAt).toUTCString()}`,
		`Message-ID: <${m.messageId ?? m.id}>`,
		"MIME-Version: 1.0",
		`Content-Type: multipart/alternative; boundary="${boundary}"`,
	];
	const parts = [`--${boundary}\nContent-Type: text/plain; charset=utf-8\n\n${m.text ?? ""}`];
	if (m.html) parts.push(`--${boundary}\nContent-Type: text/html; charset=utf-8\n\n${m.html.trim()}`);
	return `${headers.join("\n")}\n\n${parts.join("\n\n")}\n--${boundary}--\n`;
}

// ---- Banner -------------------------------------------------------------------------------

function showBanner() {
	const el = document.createElement("div");
	el.setAttribute("role", "note");
	el.style.cssText =
		"position:fixed;left:50%;bottom:12px;transform:translateX(-50%);z-index:2147483000;display:flex;align-items:center;gap:10px;" +
		"padding:6px 14px;border-radius:999px;font:500 12px/1.4 system-ui,sans-serif;background:#18181b;color:#fafafa;" +
		"box-shadow:0 4px 16px rgba(0,0,0,.25);white-space:nowrap;max-width:calc(100vw - 32px);overflow:hidden;text-overflow:ellipsis";
	const full =
		'<span>Demo with fake data. Nothing leaves your browser, and it resets on reload.</span>' +
		'<a href="https://github.com/Prastavna/cfw-mailbox" target="_blank" rel="noopener noreferrer" style="color:#fdba74;text-decoration:none">Source ↗</a>';
	const chip = '<a href="https://github.com/Prastavna/cfw-mailbox" target="_blank" rel="noopener noreferrer" title="Demo with fake data. View the source" style="color:inherit;text-decoration:none">Demo</a>';
	const shrink = () => {
		el.innerHTML = chip;
		el.style.padding = "3px 10px";
		el.style.opacity = "0.85";
	};
	el.innerHTML = full;
	// Shrinks to a small chip so it doesn't cover the composer (at once on phones).
	if (innerWidth < 640) shrink();
	else setTimeout(shrink, 12_000);
	const attach = () => document.body.appendChild(el);
	if (document.readyState !== "loading") setTimeout(attach, 500);
	else addEventListener("DOMContentLoaded", () => setTimeout(attach, 500));
}
