import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Label, Mailbox, MailboxEvent, ThreadDetail, ThreadPage } from "../shared/api";
import { handleInbound, INLINE_HTML_LIMIT, MAX_INBOUND_BYTES } from "../workers/email/inbound";
import { eml, inbound, makeMailbox, PNG } from "./helpers";

const BASE = "http://localhost";
const call = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`${BASE}${path}`, init));
const json = async <T>(path: string) => {
	const res = await call(path);
	expect(res.status, `${path} → ${res.status}`).toBe(200);
	return res.json<T>();
};

async function deliver(mailbox: Mailbox, opts: Omit<Parameters<typeof eml>[0], "to">) {
	const { message, rejected } = inbound(eml({ to: mailbox.address, ...opts }), mailbox.address);
	await handleInbound(message, env);
	expect(rejected).toEqual([]);
}

const threads = (mb: Mailbox, label = "INBOX", extra = "") =>
	json<ThreadPage>(`/api/mailboxes/${mb.id}/threads?label=${label}${extra}`);
const thread = (mb: Mailbox, id: string) => json<ThreadDetail>(`/api/mailboxes/${mb.id}/threads/${id}`);
const objectCount = async (mb: Mailbox) => (await env.BUCKET.list({ prefix: `mailboxes/${mb.id}/` })).objects.length;

describe("receiving mail", () => {
	it("stores a message in the inbox as unread", async () => {
		const mb = await makeMailbox();
		await deliver(mb, { subject: "Welcome", messageId: "m1@sender.test", text: "Hello there,\nthis is the body." });

		const page = await threads(mb);
		expect(page.nextCursor).toBeNull();
		expect(page.threads).toHaveLength(1);
		const [t] = page.threads;
		expect(t).toMatchObject({
			subject: "Welcome",
			snippet: "Hello there, this is the body.",
			messageCount: 1,
			unread: true,
			hasAttachments: false,
			labelIds: ["INBOX", "UNREAD"],
			participants: [{ name: "Alice", address: "alice@sender.test" }],
		});

		const detail = await thread(mb, t!.id);
		expect(detail.messages).toHaveLength(1);
		expect(detail.messages[0]).toMatchObject({ messageId: "m1@sender.test", subject: "Welcome", html: null });
		expect(detail.messages[0]!.text).toContain("this is the body.");

		const labels = await json<Label[]>(`/api/mailboxes/${mb.id}/labels`);
		expect(labels.find((l) => l.id === "INBOX")).toMatchObject({ total: 1, unread: 1 });
		expect(labels.find((l) => l.id === "SENT")).toMatchObject({ total: 0, unread: 0 });

		const raw = await call(`/api/mailboxes/${mb.id}/messages/${detail.messages[0]!.id}/raw`);
		expect(raw.headers.get("content-type")).toBe("text/plain; charset=utf-8");
		expect(await raw.text()).toContain("Message-ID: <m1@sender.test>");
	});

	it("rejects unknown recipients and oversized mail", async () => {
		const unknown = inbound(eml({ to: "nobody@nowhere.test" }), "nobody@nowhere.test");
		await handleInbound(unknown.message, env);
		expect(unknown.rejected).toEqual(["Unknown recipient"]);

		const mb = await makeMailbox();
		const big = inbound(eml({ to: mb.address }), mb.address);
		await handleInbound({ ...big.message, rawSize: MAX_INBOUND_BYTES + 1 }, env);
		expect(big.rejected).toEqual(["Message too large"]);
	});

	it("ignores redelivery of the same Message-ID", async () => {
		const mb = await makeMailbox();
		await deliver(mb, { messageId: "dup@sender.test", text: "once" });
		const before = await objectCount(mb);
		await deliver(mb, { messageId: "dup@sender.test", text: "once" });
		expect((await threads(mb)).threads[0]!.messageCount).toBe(1);
		expect(await objectCount(mb)).toBe(before);
	});

	it("falls back to the envelope sender and receipt time", async () => {
		const mb = await makeMailbox();
		const raw = `To: ${mb.address}\r\nSubject: bare\r\nDate: Fri, 01 Jan 2100 00:00:00 +0000\r\n\r\nhi\r\n`;
		const { message } = inbound(raw, mb.address, "Envelope@Sender.test");
		const before = Date.now();
		await handleInbound(message, env);
		const [t] = (await threads(mb)).threads;
		const [m] = (await thread(mb, t!.id)).messages;
		expect(m!.from.address).toBe("envelope@sender.test");
		// A Date header far in the future is ignored.
		expect(m!.sentAt).toBeGreaterThanOrEqual(before);
		expect(m!.sentAt).toBeLessThanOrEqual(Date.now());
	});
});

describe("threading", () => {
	it("joins replies by In-Reply-To / References", async () => {
		const mb = await makeMailbox();
		await deliver(mb, { subject: "Plans", messageId: "root@a.test", text: "First" });
		await deliver(mb, {
			from: "Bob <bob@b.test>",
			subject: "Re: Plans",
			messageId: "reply@b.test",
			inReplyTo: "root@a.test",
			references: ["root@a.test"],
			text: "Second\n\nOn Mon, 1 Jan 2026, Alice <alice@sender.test> wrote:\n> First",
		});
		await deliver(mb, { subject: "Re: Plans", messageId: "third@a.test", references: ["root@a.test", "reply@b.test"], text: "Third" });

		const page = await threads(mb);
		expect(page.threads).toHaveLength(1);
		const [t] = page.threads;
		expect(t).toMatchObject({ subject: "Plans", messageCount: 3, snippet: "Third" });
		expect(t!.participants.map((p) => p.address)).toEqual(["alice@sender.test", "bob@b.test"]);

		const detail = await thread(mb, t!.id);
		expect(detail.messages.map((m) => m.messageId)).toEqual(["root@a.test", "reply@b.test", "third@a.test"]);
		expect(detail.messages[1]!.snippet).toBe("Second");
	});

	it("files a message that arrives after its reply into the same thread", async () => {
		const mb = await makeMailbox();
		await deliver(mb, { subject: "Re: Late", messageId: "child@x.test", inReplyTo: "parent@x.test", text: "reply" });
		await deliver(mb, { subject: "Late", messageId: "parent@x.test", text: "original" });
		const page = await threads(mb);
		expect(page.threads).toHaveLength(1);
		expect(page.threads[0]!.messageCount).toBe(2);
	});

	it("threads 'Re:' replies without headers by subject, but not unrelated mail", async () => {
		const mb = await makeMailbox();
		await deliver(mb, { subject: "Invoice 42", messageId: "inv@x.test", text: "a" });
		await deliver(mb, { subject: "RE: invoice 42", messageId: "inv-reply@x.test", text: "b" });
		await deliver(mb, { subject: "Invoice 42", messageId: "inv-again@x.test", text: "c" });

		const page = await threads(mb);
		expect(page.threads.map((t) => t.messageCount).sort()).toEqual([1, 2]);
	});

	it("paginates newest first", async () => {
		const mb = await makeMailbox();
		for (const n of [1, 2, 3]) {
			await deliver(mb, { subject: `Thread ${n}`, messageId: `p${n}@x.test`, text: String(n) });
			await new Promise((r) => setTimeout(r, 2));
		}
		const first = await threads(mb, "INBOX", "&limit=2");
		expect(first.threads.map((t) => t.subject)).toEqual(["Thread 3", "Thread 2"]);
		expect(first.nextCursor).not.toBeNull();
		const second = await threads(mb, "INBOX", `&limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`);
		expect(second.threads.map((t) => t.subject)).toEqual(["Thread 1"]);
		expect(second.nextCursor).toBeNull();
	});
});

describe("bodies and attachments", () => {
	it("stores attachments in R2 and serves them safely", async () => {
		const mb = await makeMailbox();
		await deliver(mb, {
			messageId: "att@x.test",
			html: '<p>See logo <img src="cid:logo@x"></p>',
			attachments: [
				{ filename: "logo.png", mimeType: "image/png", content: PNG, contentId: "logo@x", inline: true },
				{ filename: "évil<script>.html", mimeType: "text/html", content: new TextEncoder().encode("<script>alert(1)</script>") },
			],
		});
		const [t] = (await threads(mb)).threads;
		expect(t!.hasAttachments).toBe(true);
		const [m] = (await thread(mb, t!.id)).messages;
		const [logo, doc] = m!.attachments;
		expect(logo).toMatchObject({ filename: "logo.png", disposition: "inline", contentId: "logo@x", size: PNG.byteLength });
		expect(doc).toMatchObject({ disposition: "attachment", mimeType: "text/html" });

		const base = `/api/mailboxes/${mb.id}/messages/${m!.id}/attachments`;
		const img = await call(`${base}/${logo!.id}?inline=1`);
		expect(img.headers.get("content-type")).toBe("image/png");
		expect(img.headers.get("content-disposition")).toMatch(/^inline;/);
		expect(new Uint8Array(await img.arrayBuffer())).toEqual(PNG);

		// HTML attachments never render on our origin, even when asked to.
		const html = await call(`${base}/${doc!.id}?inline=1`);
		expect(html.headers.get("content-type")).toBe("application/octet-stream");
		expect(html.headers.get("content-disposition")).toBe(
			`attachment; filename="_vil<script>.html"; filename*=UTF-8''%C3%A9vil%3Cscript%3E.html`,
		);
		expect(html.headers.get("x-content-type-options")).toBe("nosniff");
		expect(html.headers.get("content-security-policy")).toMatch(/^sandbox/);
		await html.body?.cancel();

		expect((await call(`${base}/${crypto.randomUUID()}`)).status).toBe(404);
	});

	it("keeps large HTML bodies in R2", async () => {
		const mb = await makeMailbox();
		const big = `<div>${"word ".repeat(INLINE_HTML_LIMIT / 4)}</div>`;
		await deliver(mb, { messageId: "big@x.test", html: big });
		const [t] = (await threads(mb)).threads;
		const [m] = (await thread(mb, t!.id)).messages;
		expect(m!.html?.trim()).toBe(big);
		expect(await env.BUCKET.head(`mailboxes/${mb.id}/messages/${m!.id}/body.html`)).not.toBeNull();
	});
});

describe("live updates", () => {
	it("pushes an event to open WebSockets when mail arrives", async () => {
		const mb = await makeMailbox();
		const res = await call(`/api/mailboxes/${mb.id}/events`, { headers: { Upgrade: "websocket" } });
		expect(res.status).toBe(101);
		const ws = res.webSocket!;
		ws.accept();
		const event = new Promise<MailboxEvent>((resolve) => ws.addEventListener("message", (e) => resolve(JSON.parse(e.data as string))));

		await deliver(mb, { messageId: "live@x.test", text: "ping" });
		const [t] = (await threads(mb)).threads;
		expect(await event).toEqual({ type: "threads.changed", threadIds: [t!.id] });
		ws.close();
	});

	it("closes open WebSockets when access is revoked", async () => {
		const open = async (mb: Mailbox) => {
			const res = await call(`/api/mailboxes/${mb.id}/events`, { headers: { Upgrade: "websocket" } });
			expect(res.status).toBe(101);
			const ws = res.webSocket!;
			ws.accept();
			const closed = new Promise<number>((resolve) => ws.addEventListener("close", (e) => resolve(e.code)));
			return { ws, closed };
		};
		// Removing a member closes that member's sockets.
		const mb = await makeMailbox();
		const added = await call(`/api/admin/mailboxes/${mb.id}/members`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email: "admin@example.test", role: "member" }),
		});
		expect(added.status).toBe(200);
		const member = await open(mb);
		const removed = await call(`/api/admin/mailboxes/${mb.id}/members/Admin@Example.test`, { method: "DELETE" });
		expect(removed.status).toBe(204);
		expect(await member.closed).toBe(4403);

		// Deleting a mailbox closes every socket on it.
		const other = await makeMailbox();
		const sockets = [await open(other), await open(other)];
		expect((await call(`/api/admin/mailboxes/${other.id}`, { method: "DELETE" })).status).toBe(204);
		expect(await Promise.all(sockets.map((s) => s.closed))).toEqual([4403, 4403]);
	});

	it("refuses cross-site WebSockets and non-JSON writes", async () => {
		const mb = await makeMailbox();
		const ws = await call(`/api/mailboxes/${mb.id}/events`, { headers: { Upgrade: "websocket", Origin: "https://evil.test" } });
		expect(ws.status).toBe(403);
		const form = await call("/api/admin/domains", { method: "POST", headers: { "content-type": "text/plain" }, body: '{"domain":"x.test"}' });
		expect(form.status).toBe(415);
		const cross = await call("/api/admin/domains", {
			method: "POST",
			headers: { "content-type": "application/json", Origin: "https://evil.test" },
			body: '{"domain":"x.test"}',
		});
		expect(cross.status).toBe(403);
	});
});
