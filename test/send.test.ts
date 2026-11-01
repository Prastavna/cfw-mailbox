import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DraftDetail, Mailbox, MailboxSettings, SendResult, ThreadDetail, ThreadPage } from "../shared/api";
import { handleInbound } from "../workers/email/inbound";
import { transport } from "../workers/email/outbound";
import { getMailbox } from "../workers/mailbox/MailboxDO";
import { eml, inbound, makeMailbox, PNG } from "./helpers";

const BASE = "http://localhost";
const call = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`${BASE}${path}`, init));
const send = (path: string, body: unknown, method = "POST") =>
	call(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const get = async <T>(path: string) => (await call(path)).json<T>();

/** Everything handed to Email Service during a test. */
let outbox: EmailMessageBuilder[] = [];
let failWith: { code: string; message: string } | null = null;
const realSend = transport.send;

beforeEach(() => {
	outbox = [];
	failWith = null;
	transport.send = async (_env, message) => {
		if (failWith) throw Object.assign(new Error(failWith.message), { code: failWith.code });
		outbox.push(message);
		return { messageId: `<sent-${outbox.length}@cfw.test>` };
	};
});
afterEach(() => {
	transport.send = realSend;
});

async function setup(undoSendSeconds = 0) {
	const mb = await makeMailbox();
	const api = `/api/mailboxes/${mb.id}`;
	const settings = await send(`${api}/settings`, { undoSendSeconds }, "PATCH");
	expect(settings.status).toBe(200);
	const list = async (label: string) => (await get<ThreadPage>(`${api}/threads?label=${label}`)).threads;
	const createDraft = async (body: object) => {
		const res = await send(`${api}/drafts`, body);
		expect(res.status).toBe(201);
		return res.json<DraftDetail>();
	};
	return { mb, api, list, createDraft };
}

async function deliver(mb: Mailbox, opts: Omit<Parameters<typeof eml>[0], "to">) {
	const { message } = inbound(eml({ to: mb.address, ...opts }), mb.address);
	await handleInbound(message, env);
}

describe("drafts", () => {
	it("are saved, listed under Drafts, updated and discarded", async () => {
		const { api, list, createDraft } = await setup();
		const draft = await createDraft({ to: [{ name: "Bob", address: "bob@else.test" }], subject: "Plan", html: "<p>Hi <b>Bob</b></p>" });
		expect(draft).toMatchObject({ subject: "Plan", html: "<p>Hi <b>Bob</b></p>", sendAt: null, attachments: [] });

		const drafts = await list("DRAFT");
		expect(drafts.map((t) => t.subject)).toEqual(["Plan"]);
		expect(drafts[0]!.snippet).toBe("Hi Bob");
		expect(await list("INBOX")).toEqual([]);

		const updated = await send(`${api}/drafts/${draft.id}`, { to: [], subject: "Plan v2", html: "<p>Changed</p>" }, "PUT");
		expect(updated.status).toBe(200);
		expect((await list("DRAFT"))[0]).toMatchObject({ subject: "Plan v2", snippet: "Changed" });

		expect((await call(`${api}/drafts/${draft.id}`, { method: "DELETE" })).status).toBe(204);
		expect(await list("DRAFT")).toEqual([]);
		expect(await list("ALL")).toEqual([]);
		expect((await call(`${api}/drafts/${draft.id}`)).status).toBe(404);
	});

	it("validates recipients and sizes", async () => {
		const { api } = await setup();
		expect((await send(`${api}/drafts`, { to: [{ name: "", address: "not-an-address" }] })).status).toBe(400);
		expect((await send(`${api}/drafts`, { html: "x".repeat(400_000) })).status).toBe(400);
		const tooMany = Array.from({ length: 51 }, (_, i) => ({ name: "", address: `p${i}@else.test` }));
		expect((await send(`${api}/drafts`, { to: tooMany })).status).toBe(400);
	});

	it("takes attachments as raw uploads and removes them", async () => {
		const { api, createDraft } = await setup();
		const draft = await createDraft({ subject: "Files" });
		const res = await call(`${api}/drafts/${draft.id}/attachments?filename=${encodeURIComponent("pic.png")}`, {
			method: "POST",
			headers: { "content-type": "image/png" },
			body: PNG,
		});
		expect(res.status).toBe(201);
		const att = await res.json<{ id: string; size: number; mimeType: string }>();
		expect(att).toMatchObject({ size: PNG.byteLength, mimeType: "image/png" });

		const download = await call(`${api}/messages/${draft.id}/attachments/${att.id}`);
		expect(new Uint8Array(await download.arrayBuffer())).toEqual(PNG);

		expect((await call(`${api}/drafts/${draft.id}/attachments/${att.id}`, { method: "DELETE" })).status).toBe(204);
		expect((await get<DraftDetail>(`${api}/drafts/${draft.id}`)).attachments).toEqual([]);
	});
});

describe("sending", () => {
	it("sends at once when undo is off and files the message under Sent", async () => {
		const { mb, api, list, createDraft } = await setup(0);
		const draft = await createDraft({
			to: [{ name: "Bob", address: "bob@else.test" }],
			bcc: [{ name: "", address: "hidden@else.test" }],
			subject: "Hello",
			html: "<p>Hello <i>there</i></p>",
		});
		const res = await send(`${api}/drafts/${draft.id}/send`, {});
		expect(res.status).toBe(200);
		expect(await res.json<SendResult>()).toMatchObject({ status: "sent", draftId: draft.id });

		expect(outbox).toHaveLength(1);
		expect(outbox[0]).toMatchObject({
			from: { name: "Me", email: mb.address },
			to: [{ name: "Bob", email: "bob@else.test" }],
			bcc: ["hidden@else.test"],
			subject: "Hello",
			html: "<p>Hello <i>there</i></p>",
			text: "Hello there",
		});
		expect(await list("DRAFT")).toEqual([]);
		const sent = await list("SENT");
		expect(sent.map((t) => t.subject)).toEqual(["Hello"]);
		const detail = await get<ThreadDetail>(`${api}/threads/${sent[0]!.id}`);
		expect(detail.messages[0]).toMatchObject({ messageId: "sent-1@cfw.test", hasRaw: false });
		expect(detail.messages[0]!.labelIds).toEqual(["SENT"]);
		// Already sent: can't be edited or sent again.
		expect((await send(`${api}/drafts/${draft.id}`, { subject: "x" }, "PUT")).status).toBe(409);
		expect((await send(`${api}/drafts/${draft.id}/send`, {})).status).toBe(409);
	});

	it("waits out the undo window, can be cancelled, and goes out on the alarm", async () => {
		const { mb, api, list, createDraft } = await setup(10);
		const draft = await createDraft({ to: [{ name: "", address: "bob@else.test" }], subject: "Later", html: "<p>x</p>" });
		const queued = await (await send(`${api}/drafts/${draft.id}/send`, {})).json<SendResult>();
		expect(queued.status).toBe("queued");
		expect(queued.sendAt).toBeGreaterThan(Date.now() + 5000);
		expect(outbox).toHaveLength(0);
		expect(await list("DRAFT")).toEqual([]);

		// Undo: back to Drafts, nothing sent even when the alarm fires.
		const cancelled = await send(`${api}/drafts/${draft.id}/cancel-send`, {});
		expect(cancelled.status).toBe(200);
		expect((await cancelled.json<DraftDetail>()).sendAt).toBeNull();
		expect((await list("DRAFT")).map((t) => t.subject)).toEqual(["Later"]);
		await runDurableObjectAlarm(getMailbox(env, mb.id));
		expect(outbox).toHaveLength(0);

		// Send again, then pretend the delay has passed.
		await send(`${api}/drafts/${draft.id}/send`, {});
		const stub = getMailbox(env, mb.id);
		await runInMailbox(stub, (sql) => sql.exec("UPDATE messages SET send_at = 0 WHERE id = ?", draft.id));
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect(outbox).toHaveLength(1);
		expect((await list("SENT")).map((t) => t.subject)).toEqual(["Later"]);
		expect((await send(`${api}/drafts/${draft.id}/cancel-send`, {})).status).toBe(409);
	});

	it("replies in the thread with In-Reply-To and References", async () => {
		const { mb, api, list, createDraft } = await setup(0);
		await deliver(mb, { subject: "Plans", messageId: "p1@x.test", text: "first" });
		await deliver(mb, { subject: "Re: Plans", messageId: "p2@x.test", inReplyTo: "p1@x.test", references: ["p1@x.test"], text: "second" });
		const [thread] = await list("INBOX");
		const detail = await get<ThreadDetail>(`${api}/threads/${thread!.id}`);
		const latest = detail.messages.at(-1)!;

		const draft = await createDraft({
			parent: { messageId: latest.id, kind: "reply" },
			to: [{ name: "Alice", address: "alice@sender.test" }],
			subject: "Re: Plans",
			html: "<p>Sounds good</p>",
		});
		expect(draft.threadId).toBe(thread!.id);
		// The thread shows up in Drafts while the reply is unsent, without counting as unread.
		expect((await list("DRAFT")).map((t) => t.id)).toEqual([thread!.id]);

		await send(`${api}/drafts/${draft.id}/send`, {});
		expect(outbox[0]!.headers).toEqual({ "In-Reply-To": "<p2@x.test>", References: "<p1@x.test> <p2@x.test>" });
		const after = await get<ThreadDetail>(`${api}/threads/${thread!.id}`);
		expect(after.messages).toHaveLength(3);
		expect(after.thread.labelIds).toContain("SENT");
		expect(after.thread.participants.map((p) => p.address)).toEqual(["alice@sender.test", mb.address]);

		// Their answer to our reply lands in the same thread.
		await deliver(mb, { subject: "Re: Plans", messageId: "p4@x.test", inReplyTo: "sent-1@cfw.test", text: "great" });
		expect((await get<ThreadDetail>(`${api}/threads/${thread!.id}`)).messages).toHaveLength(4);
	});

	it("forwards with the original attachments", async () => {
		const { mb, api, list, createDraft } = await setup(0);
		await deliver(mb, {
			subject: "Photo",
			messageId: "ph@x.test",
			text: "see attached",
			attachments: [{ filename: "a.png", mimeType: "image/png", content: PNG }],
		});
		const [thread] = await list("INBOX");
		const original = (await get<ThreadDetail>(`${api}/threads/${thread!.id}`)).messages[0]!;
		const draft = await createDraft({
			parent: { messageId: original.id, kind: "forward" },
			to: [{ name: "", address: "carol@else.test" }],
			subject: "Fwd: Photo",
		});
		expect(draft.attachments).toMatchObject([{ filename: "a.png", size: PNG.byteLength }]);
		await send(`${api}/drafts/${draft.id}/send`, {});
		const attachment = outbox[0]!.attachments![0]!;
		expect(attachment).toMatchObject({ filename: "a.png", type: "image/png", disposition: "attachment" });
		expect(new Uint8Array(attachment.content as ArrayBuffer)).toEqual(PNG);
	});

	it("returns a rejected message to Drafts with the reason", async () => {
		const { api, list, createDraft } = await setup(0);
		const draft = await createDraft({ to: [{ name: "", address: "bob@else.test" }], subject: "Nope" });
		failWith = { code: "E_SENDER_NOT_VERIFIED", message: "sender not verified" };
		const res = await send(`${api}/drafts/${draft.id}/send`, {});
		expect(res.status).toBe(422);
		expect((await res.json<{ error: string }>()).error).toMatch(/isn't set up to send/);
		expect((await list("DRAFT")).map((t) => t.subject)).toEqual(["Nope"]);
		expect((await get<DraftDetail>(`${api}/drafts/${draft.id}`)).sendError).toMatch(/isn't set up to send/);
	});

	it("keeps temporary failures in the Outbox for a retry", async () => {
		const { mb, api, list, createDraft } = await setup(0);
		const draft = await createDraft({ to: [{ name: "", address: "bob@else.test" }], subject: "Retry" });
		failWith = { code: "E_RATE_LIMIT_EXCEEDED", message: "slow down" };
		expect((await send(`${api}/drafts/${draft.id}/send`, {})).status).toBe(503);
		expect(await list("DRAFT")).toEqual([]);
		expect((await list("OUTBOX")).map((t) => t.subject)).toEqual(["Retry"]);

		failWith = null;
		const stub = getMailbox(env, mb.id);
		await runInMailbox(stub, (sql) => sql.exec("UPDATE messages SET send_at = 0 WHERE id = ?", draft.id));
		await runDurableObjectAlarm(stub);
		expect((await list("SENT")).map((t) => t.subject)).toEqual(["Retry"]);
	});

	it("refuses to send without recipients", async () => {
		const { api, createDraft } = await setup(0);
		const draft = await createDraft({ subject: "Nobody" });
		expect((await send(`${api}/drafts/${draft.id}/send`, {})).status).toBe(400);
	});
});

describe("settings", () => {
	it("stores a signature and the undo-send delay", async () => {
		const { api } = await setup(5);
		expect(await get<MailboxSettings>(`${api}/settings`)).toEqual({ signature: "", undoSendSeconds: 5 });
		const res = await send(`${api}/settings`, { signature: "Me\nCEO" }, "PATCH");
		expect(await res.json()).toEqual({ signature: "Me\nCEO", undoSendSeconds: 5 });
		expect((await send(`${api}/settings`, { undoSendSeconds: 7 }, "PATCH")).status).toBe(400);
	});
});

async function runInMailbox(stub: ReturnType<typeof getMailbox>, fn: (sql: SqlStorage) => unknown) {
	const { runInDurableObject } = await import("cloudflare:test");
	await runInDurableObject(stub, (_instance, state) => {
		fn(state.storage.sql);
	});
}
