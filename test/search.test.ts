import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { DraftDetail, Label, Mailbox, ThreadPage } from "../shared/api";
import { parseSearch } from "../shared/search";
import { handleInbound } from "../workers/email/inbound";
import { eml, inbound, makeMailbox, PNG } from "./helpers";

const BASE = "http://localhost";
const call = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`${BASE}${path}`, init));
const send = (path: string, body: unknown, method = "POST") =>
	call(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("query parser", () => {
	it("splits words, phrases, operators and negation", () => {
		expect(parseSearch('budget from:Alice -in:trash "launch plan" subject:"Q4 Plan"')).toEqual([
			[{ key: null, value: "budget", negate: false, phrase: false }],
			[{ key: "from", value: "alice", negate: false, phrase: false }],
			[{ key: "in", value: "trash", negate: true, phrase: false }],
			[{ key: null, value: "launch plan", negate: false, phrase: true }],
			[{ key: "subject", value: "Q4 Plan", negate: false, phrase: true }],
		]);
	});

	it("groups OR terms and ignores AND", () => {
		expect(parseSearch("invoice OR receipt AND paid").map((g) => g.map((t) => t.value))).toEqual([["invoice", "receipt"], ["paid"]]);
		expect(parseSearch("OR alone")).toEqual([[{ key: null, value: "alone", negate: false, phrase: false }]]);
	});

	it("treats unknown operators and stray syntax as text", () => {
		expect(parseSearch("http://x.test foo:bar (baz)").map((g) => g[0]!.value)).toEqual(["http://x.test", "foo:bar", "baz"]);
		expect(parseSearch('  - "" ')).toEqual([[{ key: null, value: "-", negate: false, phrase: false }]]);
	});
});

async function deliver(mb: Mailbox, opts: Omit<Parameters<typeof eml>[0], "to">) {
	const { message } = inbound(eml({ to: mb.address, ...opts }), mb.address);
	await handleInbound(message, env);
}

async function setup() {
	const mb = await makeMailbox();
	const api = `/api/mailboxes/${mb.id}`;
	await deliver(mb, {
		from: "Alice <alice@sender.test>",
		subject: "Budget review",
		messageId: "b1@x.test",
		text: "Quarterly numbers attached.",
		attachments: [{ filename: "report-q3.pdf", mimeType: "application/pdf", content: PNG }],
	});
	await deliver(mb, { from: "Carol <carol@other.test>", subject: "Re: Budget review", messageId: "b2@x.test", inReplyTo: "b1@x.test", text: "Looks fine to me." });
	await deliver(mb, { from: "Bob <bob@other.test>", subject: "Lunch plans", messageId: "l1@x.test", html: "<p>Let's get <b>ramen</b> at Café Ōsaka</p>" });
	await deliver(mb, { from: "News <news@digest.test>", subject: "Weekly digest", messageId: "d1@x.test", text: "Top stories this week" });

	const search = async (q: string) => {
		const res = await call(`${api}/threads?q=${encodeURIComponent(q)}`);
		expect(res.status, q).toBe(200);
		return (await res.json<ThreadPage>()).threads.map((t) => t.subject).sort();
	};
	const threadId = async (subject: string) =>
		(await (await call(`${api}/threads?label=ALL`)).json<ThreadPage>()).threads.find((t) => t.subject === subject)!.id;
	return { mb, api, search, threadId };
}

describe("search", () => {
	it("finds threads by words, word prefixes and phrases", async () => {
		const { search } = await setup();
		expect(await search("budget")).toEqual(["Budget review"]);
		expect(await search("quarterly")).toEqual(["Budget review"]);
		expect(await search("fine")).toEqual(["Budget review"]);
		expect(await search("rame")).toEqual(["Lunch plans"]);
		expect(await search("cafe osaka")).toEqual(["Lunch plans"]);
		expect(await search('"numbers attached"')).toEqual(["Budget review"]);
		expect(await search('"attached numbers"')).toEqual([]);
		expect(await search("nothing-like-this")).toEqual([]);
	});

	it("searches HTML-only bodies", async () => {
		const { search } = await setup();
		expect(await search("ramen")).toEqual(["Lunch plans"]);
	});

	it("supports field operators", async () => {
		const { search } = await setup();
		expect(await search("from:bob")).toEqual(["Lunch plans"]);
		expect(await search("from:carol@other.test")).toEqual(["Budget review"]);
		expect(await search("from:other.test")).toEqual(["Budget review", "Lunch plans"]);
		expect(await search("to:me")).toEqual(["Budget review", "Lunch plans", "Weekly digest"]);
		expect(await search("subject:lunch")).toEqual(["Lunch plans"]);
		expect(await search("subject:ramen")).toEqual([]);
		expect(await search("has:attachment")).toEqual(["Budget review"]);
		expect(await search("filename:report")).toEqual(["Budget review"]);
		expect(await search("filename:pdf")).toEqual(["Budget review"]);
	});

	it("combines terms with AND, OR and negation", async () => {
		const { search } = await setup();
		expect(await search("lunch OR digest")).toEqual(["Lunch plans", "Weekly digest"]);
		expect(await search("from:other.test -from:bob")).toEqual(["Budget review"]);
		expect(await search("budget from:bob")).toEqual([]);
		expect(await search("-budget -lunch")).toEqual(["Weekly digest"]);
	});

	it("filters by state, folder, label, date and size", async () => {
		const { api, search, threadId } = await setup();
		const digest = await threadId("Weekly digest");
		const lunch = await threadId("Lunch plans");
		await send(`${api}/threads/modify`, { threadIds: [lunch], removeLabelIds: ["UNREAD"], addLabelIds: ["STARRED"] });
		expect(await search("is:read")).toEqual(["Lunch plans"]);
		expect(await search("is:unread")).toEqual(["Budget review", "Weekly digest"]);
		expect(await search("is:starred")).toEqual(["Lunch plans"]);

		await send(`${api}/threads/modify`, { threadIds: [digest], addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] });
		expect(await search("digest")).toEqual([]);
		expect(await search("digest in:trash")).toEqual(["Weekly digest"]);
		expect(await search("in:anywhere digest")).toEqual(["Weekly digest"]);
		expect(await search("in:inbox")).toEqual(["Budget review", "Lunch plans"]);

		const label = await (await send(`${api}/labels`, { name: "Food Stuff" })).json<Label>();
		await send(`${api}/threads/modify`, { threadIds: [lunch], addLabelIds: [label.id] });
		expect(await search("label:food-stuff")).toEqual(["Lunch plans"]);
		expect(await search('label:"food stuff"')).toEqual(["Lunch plans"]);
		expect(await search("label:nope")).toEqual([]);

		expect(await search("newer_than:1d")).toEqual(["Budget review", "Lunch plans"]);
		expect(await search("older_than:1d")).toEqual([]);
		expect(await search("after:2000/01/01 before:2999-01-01")).toEqual(["Budget review", "Lunch plans"]);
		expect(await search("before:2000/01/01")).toEqual([]);
		expect(await search("after:not-a-date")).toEqual([]);
		expect(await search("larger:10M")).toEqual([]);
		expect(await search("smaller:10M")).toEqual(["Budget review", "Lunch plans"]);
	});

	it("keeps the index in step with drafts and deletions", async () => {
		const { api, search, threadId } = await setup();
		const draft = await (await send(`${api}/drafts`, { subject: "Secret plan", html: "<p>pineapple</p>" })).json<DraftDetail>();
		expect(await search("pineapple")).toEqual(["Secret plan"]);
		await send(`${api}/drafts/${draft.id}`, { subject: "Secret plan", html: "<p>mango</p>" }, "PUT");
		expect(await search("pineapple")).toEqual([]);
		expect(await search("mango in:drafts")).toEqual(["Secret plan"]);
		await call(`${api}/drafts/${draft.id}`, { method: "DELETE" });
		expect(await search("mango")).toEqual([]);

		const budget = await threadId("Budget review");
		await send(`${api}/threads/modify`, { threadIds: [budget], addLabelIds: ["TRASH"] });
		await send(`${api}/threads/delete`, { threadIds: [budget] });
		expect(await search("in:anywhere budget")).toEqual([]);
		expect(await search("filename:report")).toEqual([]);
	});

	it("pages through results", async () => {
		const { api } = await setup();
		const first = await (await call(`${api}/threads?q=to:me&limit=2`)).json<ThreadPage>();
		expect(first.threads).toHaveLength(2);
		const second = await (await call(`${api}/threads?q=to:me&limit=2&cursor=${first.nextCursor}`)).json<ThreadPage>();
		expect(second.threads).toHaveLength(1);
		expect(second.nextCursor).toBeNull();
	});

	it("never fails on odd input", async () => {
		const { search } = await setup();
		for (const q of ['"', "from:@", "subject:\"", '*', "NEAR(a b)", "a AND OR NOT b", "-", "''", "^budget", "budget*", "is:whatever", "has:", "{}"]) {
			await search(q);
		}
		expect(await search("   ")).toEqual([]);
	});
});

describe("advanced search form", () => {
	it("builds a query and reads it back", async () => {
		const { buildSearchQuery, searchFieldsFrom, EMPTY_SEARCH_FIELDS } = await import("../shared/search");
		const fields = {
			...EMPTY_SEARCH_FIELDS,
			from: "Alice Smith",
			subject: "plan",
			hasWords: '"launch date" OR kickoff',
			doesntHave: "draft -old",
			hasAttachment: true,
			within: "7d",
			folder: "inbox",
		};
		const q = buildSearchQuery(fields);
		expect(q).toBe('from:"Alice Smith" subject:plan "launch date" OR kickoff -draft -old has:attachment newer_than:7d in:inbox');
		expect(searchFieldsFrom(q)).toEqual({ ...fields, from: "Alice Smith", hasWords: '"launch date" OR kickoff', doesntHave: "draft old" });
		expect(buildSearchQuery(EMPTY_SEARCH_FIELDS)).toBe("");
	});
});
