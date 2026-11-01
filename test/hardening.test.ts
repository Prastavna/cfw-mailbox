import { env, exports } from "cloudflare:workers";
import { createExecutionContext, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DraftDetail, MailboxUsage, ThreadPage } from "../shared/api";
import { api } from "../workers/api";
import { handleInbound } from "../workers/email/inbound";
import { fromLine, mboxrdEscaper } from "../workers/email/mbox";
import { buildMime, encodeHeaderText } from "../workers/email/mime";
import { transport } from "../workers/email/outbound";
import { parseMessage } from "../workers/email/parse";
import { getMailbox, STORAGE_LIMITS } from "../workers/mailbox/MailboxDO";
import { eml, inbound, makeMailbox, PNG } from "./helpers";

const BASE = "http://localhost";
const call = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`${BASE}${path}`, init));
const send = (path: string, body: unknown, method = "POST") =>
	call(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const encode = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Runs bytes through the escaper split into the given chunk sizes. */
async function escape(input: string, chunkSize: number): Promise<string> {
	const bytes = encode(input);
	const chunks: Uint8Array[] = [];
	for (let i = 0; i < bytes.length; i += chunkSize) chunks.push(bytes.slice(i, i + chunkSize));
	const source = new ReadableStream<Uint8Array>({
		start(c) {
			for (const ch of chunks) c.enqueue(ch);
			c.close();
		},
	});
	return decode(await readAll(source.pipeThrough(mboxrdEscaper())));
}

describe("mboxrd", () => {
	const message = "Subject: x\r\n\r\nFrom the start\r\n>From quoted\r\nnot From here\r\n>>From deeper\r\nFromage\r\nFrom";
	const expected = "Subject: x\r\n\r\n>From the start\r\n>>From quoted\r\nnot From here\r\n>>>From deeper\r\nFromage\r\nFrom\n\n";

	it("quotes From lines whatever the chunk boundaries", async () => {
		for (const size of [1, 2, 3, 5, 7, 13, 1000]) expect(await escape(message, size), `chunks of ${size}`).toBe(expected);
	});

	it("ends every message with a blank line", async () => {
		expect(await escape("a\n", 4)).toBe("a\n\n");
		expect(await escape("a", 4)).toBe("a\n\n");
		expect(await escape("", 4)).toBe("\n");
	});

	it("writes asctime separator lines in UTC", () => {
		expect(fromLine("alice@x.test", Date.UTC(2026, 10, 1, 9, 5, 3))).toBe("From alice@x.test Sun Nov  1 09:05:03 2026\n");
		expect(fromLine("", 0)).toBe("From MAILER-DAEMON Thu Jan  1 00:00:00 1970\n");
	});
});

describe("buildMime", () => {
	it("round-trips through the parser", async () => {
		const raw = buildMime({
			from: { name: "Zoë Example", address: "zoe@x.test" },
			to: [{ name: 'Bob "B" Smith', address: "bob@y.test" }],
			cc: [],
			bcc: [{ name: "", address: "hidden@y.test" }],
			replyTo: [],
			subject: "Grüße — a long subject line that needs more than one encoded word to fit",
			date: Date.UTC(2026, 9, 30, 12),
			messageId: "m1@x.test",
			inReplyTo: "p@y.test",
			references: ["r@y.test", "p@y.test"],
			text: "Hallo\nWelt",
			html: "<p>Hallo <b>Welt</b></p>",
			attachments: [
				{ filename: "bild.png", mimeType: "image/png", disposition: "inline", contentId: "img1", content: PNG },
				{ filename: "Bericht März.pdf", mimeType: "application/pdf", disposition: "attachment", contentId: null, content: encode("%PDF") },
			],
		});
		const parsed = await parseMessage(raw);
		expect(parsed.from).toEqual({ name: "Zoë Example", address: "zoe@x.test" });
		expect(parsed.to).toEqual([{ name: 'Bob "B" Smith', address: "bob@y.test" }]);
		expect(parsed.subject).toBe("Grüße — a long subject line that needs more than one encoded word to fit");
		expect(parsed.messageId).toBe("m1@x.test");
		expect(parsed.references).toEqual(["r@y.test", "p@y.test"]);
		expect(parsed.sentAt).toBe(Date.UTC(2026, 9, 30, 12));
		expect(parsed.text?.trim()).toBe("Hallo\nWelt");
		expect(parsed.html).toContain("<b>Welt</b>");
		expect(parsed.attachments.map((a) => [a.filename, a.disposition, a.contentId])).toEqual([
			["bild.png", "inline", "img1"],
			["Bericht März.pdf", "attachment", null],
		]);
		expect(parsed.attachments[0]!.content).toEqual(PNG);
		const lines = decode(raw).split("\r\n");
		expect(lines.every((l) => l.length <= 998)).toBe(true);
		expect(encodeHeaderText("plain")).toBe("plain");
	});
});

describe("mbox export", () => {
	const realSend = transport.send;
	beforeEach(() => {
		transport.send = async () => ({ messageId: "<out-1@cfw.test>" });
	});
	afterEach(() => {
		transport.send = realSend;
	});

	it("streams received and sent mail, with labels, and leaves drafts out", async () => {
		const mb = await makeMailbox();
		const path = `/api/mailboxes/${mb.id}`;
		const { message } = inbound(
			eml({ to: mb.address, subject: "Cheese", messageId: "in-1@x.test", text: "From the dairy\n>From the farm\nbye" }),
			mb.address,
		);
		await handleInbound(message, env);
		await send(`${path}/settings`, { undoSendSeconds: 0 }, "PATCH");
		const draft = await (await send(`${path}/drafts`, { to: [{ name: "Bob", address: "bob@else.test" }], subject: "Report", html: "<p>See attached</p>" })).json<DraftDetail>();
		await call(`${path}/drafts/${draft.id}/attachments?filename=chart.png`, { method: "POST", headers: { "content-type": "image/png" }, body: PNG });
		expect((await call(`${path}/drafts/${draft.id}/send`, { method: "POST" })).status).toBe(200);
		await runDurableObjectAlarm(getMailbox(env, mb.id));
		await send(`${path}/drafts`, { subject: "Unsent idea", html: "<p>secret draft</p>" });
		const inbox = (await (await call(`${path}/threads?label=INBOX`)).json<ThreadPage>()).threads[0]!;
		await send(`${path}/threads/modify`, { threadIds: [inbox.id], addLabelIds: ["STARRED"] });

		const res = await call(`${path}/export.mbox`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/mbox");
		expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="me@d.*\.mbox"/);
		const mbox = await res.text();

		const messages = mbox.split(/^From \S+ \w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}\n/m).slice(1);
		expect(messages).toHaveLength(2);
		expect(mbox).not.toContain("secret draft");

		const [received, sent] = messages as [string, string];
		expect(received).toMatch(/^X-Mailbox-Labels: .*STARRED|^X-Mailbox-Labels: .*Starred/i);
		expect(received).toContain("\n>From the dairy\n>>From the farm\nbye");

		// Sent mail has no raw copy, so it's rebuilt from what's stored.
		const unescaped = sent.replace(/^X-Mailbox-Labels: .*\r\n/, "").replace(/^>(>*From )/gm, "$1");
		const parsed = await parseMessage(encode(unescaped));
		expect(parsed.subject).toBe("Report");
		expect(parsed.messageId).toBe("out-1@cfw.test");
		expect(parsed.to).toEqual([{ name: "Bob", address: "bob@else.test" }]);
		expect(parsed.html).toContain("See attached");
		expect(parsed.attachments.map((a) => a.filename)).toEqual(["chart.png"]);
		expect(parsed.attachments[0]!.content).toEqual(PNG);
	});

	it("is an empty file for an empty mailbox", async () => {
		const mb = await makeMailbox();
		const res = await call(`/api/mailboxes/${mb.id}/export.mbox`);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("");
	});
});

describe("limits", () => {
	it("refuses oversized JSON bodies", async () => {
		const mb = await makeMailbox();
		const res = await send(`/api/mailboxes/${mb.id}/drafts`, { subject: "x", html: "y".repeat(1_100_000) });
		expect(res.status).toBe(413);
	});

	it("answers 429 with Retry-After when a budget is spent", async () => {
		const denied = { limit: async () => ({ success: false }) } as RateLimit;
		const ctx = createExecutionContext();
		const res = await api.fetch(new Request(`${BASE}/api/me`), { ...env, API_LIMITER: denied }, ctx);
		expect(res.status).toBe(429);
		expect(res.headers.get("retry-after")).toBe("60");

		const mb = await makeMailbox();
		const heavy = await api.fetch(
			new Request(`${BASE}/api/mailboxes/${mb.id}/export.mbox`),
			{ ...env, HEAVY_LIMITER: denied },
			createExecutionContext(),
		);
		expect(heavy.status).toBe(429);
	});

	it("reports usage and bounces new mail once the mailbox is full", async () => {
		const mb = await makeMailbox();
		const path = `/api/mailboxes/${mb.id}`;
		await handleInbound(inbound(eml({ to: mb.address, subject: "one", messageId: "u1@x.test", text: "hello" }), mb.address).message, env);
		const usage = await (await call(`${path}/usage`)).json<MailboxUsage>();
		expect(usage.messages).toBe(1);
		expect(usage.messageBytes).toBeGreaterThan(0);
		expect(usage.databaseBytes).toBeGreaterThan(0);

		const saved = STORAGE_LIMITS.databaseBytes;
		STORAGE_LIMITS.databaseBytes = 1;
		try {
			const { message, rejected } = inbound(eml({ to: mb.address, subject: "two", messageId: "u2@x.test" }), mb.address);
			await handleInbound(message, env);
			expect(rejected).toEqual(["Mailbox is full"]);
		} finally {
			STORAGE_LIMITS.databaseBytes = saved;
		}
		const all = await (await call(`${path}/threads?label=ALL`)).json<ThreadPage>();
		expect(all.threads.map((t) => t.subject)).toEqual(["one"]);
		const listed = await env.BUCKET.list({ prefix: `mailboxes/${mb.id}/` });
		expect(listed.objects).toHaveLength(1);
	});
});

describe("security headers", () => {
	it("are on every response", async () => {
		const res = await call("/api/health");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("x-frame-options")).toBe("DENY");
		expect(res.headers.get("referrer-policy")).toBe("same-origin");
		expect(res.headers.get("strict-transport-security")).toBeNull();
		const https = await exports.default.fetch(new Request("https://mail.example.test/api/health"));
		expect(https.headers.get("strict-transport-security")).toContain("max-age=");
	});

	it("keep the stricter policy of untrusted content", async () => {
		const mb = await makeMailbox();
		const res = await call(`/api/mailboxes/${mb.id}/messages/nope/raw`);
		expect(res.headers.get("x-frame-options")).toBe("DENY");
	});
});
