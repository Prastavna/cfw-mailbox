import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Contact, DraftDetail, Label, MailboxSettings, MailFilter, ThreadDetail, ThreadPage } from "../shared/api";
import { DEFAULT_VACATION } from "../shared/api";
import { handleInbound } from "../workers/email/inbound";
import { transport } from "../workers/email/outbound";
import { isAutomated } from "../workers/email/parse";
import { getMailbox, RETENTION_MS } from "../workers/mailbox/MailboxDO";
import { eml, inbound, makeMailbox, PNG } from "./helpers";

const BASE = "http://localhost";
const call = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`${BASE}${path}`, init));
const send = (path: string, body: unknown, method = "POST") =>
	call(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const get = async <T>(path: string) => (await call(path)).json<T>();

let outbox: EmailMessageBuilder[] = [];
const realSend = transport.send;
beforeEach(() => {
	outbox = [];
	transport.send = async (_env, message) => {
		outbox.push(message);
		return { messageId: `<out-${outbox.length}-${crypto.randomUUID()}@cfw.test>` };
	};
});
afterEach(() => {
	transport.send = realSend;
});

async function setup() {
	const mb = await makeMailbox();
	const api = `/api/mailboxes/${mb.id}`;
	const stub = getMailbox(env, mb.id);
	const deliver = async (opts: Omit<Parameters<typeof eml>[0], "to">) => {
		const { message } = inbound(eml({ to: mb.address, ...opts }), mb.address);
		await handleInbound(message, env);
	};
	const list = async (label: string) => (await get<ThreadPage>(`${api}/threads?label=${label}`)).threads;
	const subjects = async (label: string) => (await list(label)).map((t) => t.subject).sort();
	const thread = async (subject: string) => (await list("ALL")).find((t) => t.subject === subject)!;
	const sql = (fn: (sql: SqlStorage) => void) => runInDurableObject(stub, (_i, state) => fn(state.storage.sql));
	return { mb, api, stub, deliver, list, subjects, thread, sql };
}

describe("snooze", () => {
	it("hides a conversation until its time, then brings it back unread at the top", async () => {
		const { api, stub, deliver, subjects, thread, list, sql } = await setup();
		await deliver({ subject: "Later", messageId: "s1@x.test" });
		await deliver({ subject: "Now", messageId: "s2@x.test" });
		const later = await thread("Later");
		await send(`${api}/threads/modify`, { threadIds: [later.id], removeLabelIds: ["UNREAD"] });

		const until = Date.now() + 3_600_000;
		expect((await send(`${api}/threads/snooze`, { threadIds: [later.id], until })).status).toBe(200);
		expect(await subjects("INBOX")).toEqual(["Now"]);
		const snoozed = await list("SNOOZED");
		expect(snoozed.map((t) => [t.subject, t.snoozedUntil])).toEqual([["Later", until]]);
		// Snoozing can't be faked through label edits.
		expect((await send(`${api}/threads/modify`, { threadIds: [later.id], removeLabelIds: ["SNOOZED"] })).status).toBe(400);

		await sql((s) => s.exec("UPDATE snoozes SET until = 0"));
		await runDurableObjectAlarm(stub);
		const inbox = await list("INBOX");
		expect(inbox.map((t) => t.subject)).toEqual(["Later", "Now"]);
		expect(inbox[0]).toMatchObject({ unread: true, snoozedUntil: null });
		expect(await subjects("SNOOZED")).toEqual([]);
	});

	it("ends early on unsnooze, on new mail, or when moved", async () => {
		const { api, deliver, subjects, thread } = await setup();
		await deliver({ subject: "A", messageId: "a1@x.test" });
		await deliver({ subject: "B", messageId: "b1@x.test" });
		await deliver({ subject: "C", messageId: "c1@x.test" });
		const [a, b, c] = [await thread("A"), await thread("B"), await thread("C")];
		const until = Date.now() + 86_400_000;
		await send(`${api}/threads/snooze`, { threadIds: [a.id, b.id, c.id], until });
		expect(await subjects("SNOOZED")).toEqual(["A", "B", "C"]);

		await send(`${api}/threads/unsnooze`, { threadIds: [a.id] });
		await deliver({ subject: "Re: B", messageId: "b2@x.test", inReplyTo: "b1@x.test" });
		await send(`${api}/threads/modify`, { threadIds: [c.id], addLabelIds: ["TRASH"] });
		expect(await subjects("SNOOZED")).toEqual([]);
		expect(await subjects("INBOX")).toEqual(["A", "B"]);
		expect((await send(`${api}/threads/snooze`, { threadIds: [a.id], until: Date.now() - 1 })).status).toBe(400);
	});
});

describe("emptying Trash and Spam", () => {
	it("deletes messages 30 days after they were binned, with their files", async () => {
		const { api, stub, deliver, subjects, thread, sql } = await setup();
		await deliver({ subject: "Old", messageId: "o1@x.test", attachments: [{ filename: "a.png", mimeType: "image/png", content: PNG }] });
		await deliver({ subject: "Recent", messageId: "r1@x.test" });
		await deliver({ subject: "Junk", messageId: "j1@x.test" });
		const old = await thread("Old");
		const detail = await get<ThreadDetail>(`${api}/threads/${old.id}`);
		const attachment = detail.messages[0]!.attachments[0]!;
		await send(`${api}/threads/modify`, { threadIds: [old.id, (await thread("Recent")).id], addLabelIds: ["TRASH"] });
		await send(`${api}/threads/modify`, { threadIds: [(await thread("Junk")).id], addLabelIds: ["SPAM"] });

		// The alarm is armed for when the oldest one expires.
		const alarm = await runInDurableObject(stub, (_i, state) => state.storage.getAlarm());
		expect(alarm).toBeGreaterThan(Date.now() + RETENTION_MS - 60_000);

		await sql((s) => {
			s.exec(
				"UPDATE message_labels SET added_at = ? WHERE label_id IN ('TRASH', 'SPAM') AND message_id IN (SELECT id FROM messages WHERE subject IN ('Old', 'Junk'))",
				Date.now() - RETENTION_MS - 1000,
			);
		});
		await runDurableObjectAlarm(stub);
		expect(await subjects("TRASH")).toEqual(["Recent"]);
		expect(await subjects("SPAM")).toEqual([]);
		expect((await call(`${api}/threads/${old.id}`)).status).toBe(404);
		expect((await call(`${api}/messages/${detail.messages[0]!.id}/attachments/${attachment.id}`)).status).toBe(404);
	});
});

describe("contacts", () => {
	it("suggests people you've written to first, then people who wrote to you", async () => {
		const { mb, api, deliver } = await setup();
		await send(`${api}/settings`, { undoSendSeconds: 0 }, "PATCH");
		await deliver({ from: "Bea Newsletter <bea@news.test>", subject: "x", messageId: "n1@x.test" });
		await deliver({ from: "Alice Smith <alice@acme.test>", subject: "y", messageId: "a1@x.test" });
		const draft = await (await send(`${api}/drafts`, { to: [{ name: "Bob Brown", address: "bob@acme.test" }], subject: "Hi" })).json<DraftDetail>();
		await send(`${api}/drafts/${draft.id}/send`, {});

		const suggest = async (q: string) => (await get<Contact[]>(`${api}/contacts?q=${encodeURIComponent(q)}`)).map((c) => c.address);
		expect(await suggest("b")).toEqual(["bob@acme.test", "bea@news.test"]);
		expect(await suggest("smi")).toEqual(["alice@acme.test"]);
		expect(await suggest("acme")).toEqual(["bob@acme.test", "alice@acme.test"]);
		expect(await suggest("%")).toEqual([]);
		expect(await suggest("")).toContain("bob@acme.test");
		expect(await suggest(mb.address.slice(0, 3))).not.toContain(mb.address);
	});
});

describe("filters", () => {
	it("applies matching filters to incoming mail", async () => {
		const { api, deliver, subjects, thread } = await setup();
		const label = await (await send(`${api}/labels`, { name: "News" })).json<Label>();
		const res = await send(`${api}/filters`, {
			query: "from:news.test",
			actions: { archive: true, markRead: true, labelId: label.id },
		});
		expect(res.status).toBe(201);
		await send(`${api}/filters`, { query: 'subject:"win a prize"', actions: { trash: true } });

		await deliver({ from: "news@news.test", subject: "Issue 1", messageId: "i1@x.test" });
		await deliver({ from: "friend@x.test", subject: "Hello", messageId: "h1@x.test" });
		await deliver({ from: "spammy@x.test", subject: "Win a prize now", messageId: "w1@x.test" });
		expect(await subjects("INBOX")).toEqual(["Hello"]);
		expect(await subjects(label.id)).toEqual(["Issue 1"]);
		expect(await subjects("TRASH")).toEqual(["Win a prize now"]);
		expect((await thread("Issue 1")).unread).toBe(false);

		const filters = await get<MailFilter[]>(`${api}/filters`);
		expect(filters.map((f) => f.query)).toEqual(["from:news.test", 'subject:"win a prize"']);
		expect((await call(`${api}/filters/${filters[0]!.id}`, { method: "DELETE" })).status).toBe(204);
		await deliver({ from: "news@news.test", subject: "Issue 2", messageId: "i2@x.test" });
		expect(await subjects("INBOX")).toEqual(["Hello", "Issue 2"]);
	});

	it("can apply to existing mail, and validates", async () => {
		const { api, deliver, subjects } = await setup();
		await deliver({ from: "a@shop.test", subject: "Receipt 1", messageId: "r1@x.test" });
		await deliver({ from: "a@shop.test", subject: "Receipt 2", messageId: "r2@x.test" });
		const res = await send(`${api}/filters`, { query: "from:shop.test", actions: { star: true }, applyToExisting: true });
		expect(await res.json()).toMatchObject({ applied: 2 });
		expect(await subjects("STARRED")).toEqual(["Receipt 1", "Receipt 2"]);

		expect((await send(`${api}/filters`, { query: "from:x", actions: {} })).status).toBe(400);
		expect((await send(`${api}/filters`, { query: "  ", actions: { star: true } })).status).toBe(400);
		expect((await send(`${api}/filters`, { query: "from:x", actions: { labelId: "INBOX" } })).status).toBe(400);
	});
});

describe("vacation responder", () => {
	const vacation = { ...DEFAULT_VACATION, enabled: true, message: "Away until Monday.\n\nUrgent? Call Sam." };

	it("replies once per sender, marked as an auto-reply, and never to automated mail", async () => {
		const { mb, api, deliver } = await setup();
		const saved = await (await send(`${api}/settings`, { vacation }, "PATCH")).json<MailboxSettings>();
		expect(saved.vacation).toEqual(vacation);

		await deliver({ from: "Alice <alice@x.test>", subject: "Lunch?", messageId: "v1@x.test" });
		expect(outbox).toHaveLength(1);
		expect(outbox[0]).toMatchObject({
			from: { name: "Me", email: mb.address },
			to: "alice@x.test",
			subject: "Re: Lunch?",
			text: vacation.message,
			html: "<p>Away until Monday.</p><p>Urgent? Call Sam.</p>",
			headers: { "Auto-Submitted": "auto-replied", "In-Reply-To": "<v1@x.test>", References: "<v1@x.test>" },
		});

		await deliver({ from: "alice@x.test", subject: "Again", messageId: "v2@x.test" });
		await deliver({ from: "list@x.test", subject: "Digest", messageId: "v3@x.test", extraHeaders: ["List-Id: <news.x.test>"] });
		await deliver({ from: "MAILER-DAEMON@x.test", subject: "Undeliverable", messageId: "v4@x.test" });
		await deliver({ from: "bot@x.test", subject: "Ping", messageId: "v5@x.test", extraHeaders: ["Auto-Submitted: auto-generated"] });
		expect(outbox).toHaveLength(1);

		// Saving the responder again starts afresh.
		await send(`${api}/settings`, { vacation }, "PATCH");
		await deliver({ from: "alice@x.test", subject: "Third", messageId: "v6@x.test" });
		expect(outbox).toHaveLength(2);
	});

	it("respects the date window, contacts-only, and being off", async () => {
		const { api, deliver } = await setup();
		await send(`${api}/settings`, { vacation: { ...vacation, startAt: Date.now() + 86_400_000 } }, "PATCH");
		await deliver({ from: "a@x.test", subject: "1", messageId: "w1@x.test" });
		await send(`${api}/settings`, { vacation: { ...vacation, contactsOnly: true } }, "PATCH");
		await deliver({ from: "b@x.test", subject: "2", messageId: "w2@x.test" });
		await send(`${api}/settings`, { vacation: { ...vacation, enabled: false } }, "PATCH");
		await deliver({ from: "c@x.test", subject: "3", messageId: "w3@x.test" });
		expect(outbox).toHaveLength(0);

		expect((await send(`${api}/settings`, { vacation: { ...vacation, message: " " } }, "PATCH")).status).toBe(400);
		expect((await send(`${api}/settings`, { vacation: { ...vacation, startAt: 10, endAt: 5 } }, "PATCH")).status).toBe(400);
	});

	it("recognises automated mail", () => {
		const h = (headers: Record<string, string>) => (k: string) => headers[k] ?? null;
		expect(isAutomated(h({}), "alice@x.test", "text/plain")).toBe(false);
		expect(isAutomated(h({ "auto-submitted": "no" }), "alice@x.test", null)).toBe(false);
		expect(isAutomated(h({ precedence: "bulk" }), "alice@x.test", null)).toBe(true);
		expect(isAutomated(h({ "list-unsubscribe": "<mailto:x>" }), "alice@x.test", null)).toBe(true);
		expect(isAutomated(h({}), "no-reply@x.test", null)).toBe(true);
		expect(isAutomated(h({}), "noreplyalice@x.test", null)).toBe(false);
		expect(isAutomated(h({}), "x@x.test", "multipart/report; report-type=delivery-status")).toBe(true);
	});
});
