import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { invertChanges, type Label, type Mailbox, type ModifyResult, type ThreadDetail, type ThreadPage } from "../shared/api";
import { handleInbound } from "../workers/email/inbound";
import { eml, inbound, makeMailbox } from "./helpers";

const BASE = "http://localhost";
const call = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`${BASE}${path}`, init));
const send = (path: string, body: unknown, method = "POST") =>
	call(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const get = async <T>(path: string) => (await call(path)).json<T>();

async function deliver(mb: Mailbox, opts: Omit<Parameters<typeof eml>[0], "to">) {
	const { message } = inbound(eml({ to: mb.address, ...opts }), mb.address);
	await handleInbound(message, env);
}

/** A mailbox with a 2-message thread ("Plans") and a 1-message thread ("Solo"). */
async function setup() {
	const mb = await makeMailbox();
	await deliver(mb, { subject: "Plans", messageId: "p1@x.test", text: "first" });
	await deliver(mb, { subject: "Re: Plans", messageId: "p2@x.test", inReplyTo: "p1@x.test", text: "second" });
	await deliver(mb, { subject: "Solo", messageId: "s1@x.test", text: "solo" });
	const { threads } = await get<ThreadPage>(`/api/mailboxes/${mb.id}/threads?label=INBOX`);
	const plans = threads.find((t) => t.subject === "Plans")!;
	const solo = threads.find((t) => t.subject === "Solo")!;
	const api = `/api/mailboxes/${mb.id}`;
	const modify = async (threadIds: string[], addLabelIds: string[] = [], removeLabelIds: string[] = []) => {
		const res = await send(`${api}/threads/modify`, { threadIds, addLabelIds, removeLabelIds });
		expect(res.status).toBe(200);
		return res.json<ModifyResult>();
	};
	const list = async (label: string) => (await get<ThreadPage>(`${api}/threads?label=${label}`)).threads.map((t) => t.subject).sort();
	const labels = () => get<Label[]>(`${api}/labels`);
	const thread = (id: string) => get<ThreadDetail>(`${api}/threads/${id}`);
	return { mb, api, plans, solo, modify, list, labels, thread };
}

describe("thread actions", () => {
	it("archives into All Mail", async () => {
		const { plans, modify, list } = await setup();
		const result = await modify([plans.id], [], ["INBOX"]);
		expect(result.threadIds).toEqual([plans.id]);
		expect(result.changes).toHaveLength(2);
		expect(await list("INBOX")).toEqual(["Solo"]);
		expect(await list("ALL")).toEqual(["Plans", "Solo"]);
		// Archiving again changes nothing.
		expect((await modify([plans.id], [], ["INBOX"])).changes).toEqual([]);
	});

	it("undo restores precisely the labels that changed", async () => {
		const { api, plans, modify, list, thread } = await setup();
		// Only the newest message is starred.
		await modify([plans.id], ["STARRED"]);
		const before = (await thread(plans.id)).messages.map((m) => m.labelIds);
		expect(before.map((l) => l.includes("STARRED"))).toEqual([false, true]);

		const archived = await modify([plans.id], [], ["INBOX", "STARRED"]);
		expect(await list("STARRED")).toEqual([]);
		const undo = await send(`${api}/messages/modify`, { changes: invertChanges(archived.changes) });
		expect(undo.status).toBe(200);
		expect((await thread(plans.id)).messages.map((m) => m.labelIds)).toEqual(before);
		expect(await list("INBOX")).toEqual(["Plans", "Solo"]);
	});

	it("marks read and unread like Gmail", async () => {
		const { plans, modify, labels, thread } = await setup();
		expect((await labels()).find((l) => l.id === "INBOX")).toMatchObject({ total: 2, unread: 2 });

		await modify([plans.id], [], ["UNREAD"]);
		expect((await thread(plans.id)).thread.unread).toBe(false);
		expect((await labels()).find((l) => l.id === "INBOX")).toMatchObject({ total: 2, unread: 1 });

		// "Mark as unread" only flags the newest message.
		await modify([plans.id], ["UNREAD"]);
		const { messages, thread: t } = await thread(plans.id);
		expect(t.unread).toBe(true);
		expect(messages.map((m) => m.labelIds.includes("UNREAD"))).toEqual([false, true]);
	});

	it("hides Trash and Spam from other views and counts", async () => {
		const { plans, solo, modify, list, labels } = await setup();
		await modify([plans.id], ["STARRED"]);
		await modify([plans.id], ["TRASH"], ["INBOX", "SPAM"]);
		await modify([solo.id], ["SPAM"], ["INBOX"]);

		expect(await list("INBOX")).toEqual([]);
		expect(await list("STARRED")).toEqual([]);
		expect(await list("ALL")).toEqual([]);
		expect(await list("TRASH")).toEqual(["Plans"]);
		expect(await list("SPAM")).toEqual(["Solo"]);
		const counts = Object.fromEntries((await labels()).map((l) => [l.id, l.total]));
		expect(counts).toMatchObject({ STARRED: 0, TRASH: 1, SPAM: 1, INBOX: 0 });

		// A trashed spam thread shows only in Trash.
		await modify([solo.id], ["TRASH"]);
		expect(await list("SPAM")).toEqual([]);
		expect((await list("TRASH")).sort()).toEqual(["Plans", "Solo"]);
	});

	it("refuses managed and unknown labels", async () => {
		const { api, plans } = await setup();
		for (const label of ["SENT", "DRAFT", "NOPE"]) {
			const res = await send(`${api}/threads/modify`, { threadIds: [plans.id], addLabelIds: [label] });
			expect(res.status, label).toBe(400);
		}
	});
});

describe("delete forever", () => {
	it("deletes only trashed or spam threads, with their R2 files", async () => {
		const { mb, api, plans, solo, modify, list } = await setup();
		const files = async () => (await env.BUCKET.list({ prefix: `mailboxes/${mb.id}/` })).objects.length;
		expect(await files()).toBe(3);

		// Not in Trash: ignored.
		let res = await send(`${api}/threads/delete`, { threadIds: [plans.id, solo.id] });
		expect(await res.json()).toEqual({ threadIds: [] });

		await modify([plans.id], ["TRASH"], ["INBOX"]);
		res = await send(`${api}/threads/delete`, { threadIds: [plans.id, solo.id] });
		expect(await res.json()).toEqual({ threadIds: [plans.id] });
		expect(await list("TRASH")).toEqual([]);
		expect(await list("INBOX")).toEqual(["Solo"]);
		expect((await call(`${api}/threads/${plans.id}`)).status).toBe(404);
		expect(await files()).toBe(1);
	});

	it("keeps messages that aren't themselves in Trash or Spam", async () => {
		const { mb, api, plans, thread } = await setup();
		const files = async () => (await env.BUCKET.list({ prefix: `mailboxes/${mb.id}/` })).objects.length;
		const [first, second] = (await thread(plans.id)).messages;
		// Only the reply is trashed, so the thread shows up in Trash too.
		const res = await send(`${api}/messages/modify`, {
			changes: [{ messageId: second!.id, addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] }],
		});
		expect(res.status).toBe(200);

		const del = await send(`${api}/threads/delete`, { threadIds: [plans.id] });
		expect(await del.json()).toEqual({ threadIds: [plans.id] });
		const left = await thread(plans.id);
		expect(left.messages.map((m) => m.id)).toEqual([first!.id]);
		expect(left.messages[0]!.labelIds).toContain("INBOX");
		expect(await files()).toBe(2);
	});
});

describe("labels", () => {
	it("creates, applies, renames and deletes user labels", async () => {
		const { api, plans, modify, list, labels } = await setup();
		const res = await send(`${api}/labels`, { name: "Receipts", color: "#1a73e8" });
		expect(res.status).toBe(201);
		const label = await res.json<Label>();

		expect((await send(`${api}/labels`, { name: "receipts" })).status).toBe(409);
		expect((await send(`${api}/labels`, { name: "Inbox" })).status).toBe(400);
		expect((await send(`${api}/labels`, { name: "x", color: "red" })).status).toBe(400);

		await modify([plans.id], [label.id]);
		expect(await list(label.id)).toEqual(["Plans"]);
		expect((await labels()).find((l) => l.id === label.id)).toMatchObject({ name: "Receipts", total: 1, unread: 1 });

		expect((await send(`${api}/labels/${label.id}`, { name: "Bills", color: null }, "PATCH")).status).toBe(204);
		expect((await labels()).find((l) => l.id === label.id)).toMatchObject({ name: "Bills", color: null });
		expect((await send(`${api}/labels/INBOX`, { name: "Mine" }, "PATCH")).status).toBe(404);

		expect((await call(`${api}/labels/${label.id}`, { method: "DELETE" })).status).toBe(204);
		expect((await labels()).some((l) => l.id === label.id)).toBe(false);
		expect(await list("INBOX")).toEqual(["Plans", "Solo"]);
	});
});
