import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Contact, ImportContactsResult, OtherContact, SavedContact } from "../shared/api";
import { DEFAULT_VACATION } from "../shared/api";
import { parseVCards, toVCards } from "../shared/vcard";
import { handleInbound } from "../workers/email/inbound";
import { transport } from "../workers/email/outbound";
import { eml, inbound, makeMailbox } from "./helpers";

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
		return { messageId: `<out-${outbox.length}@cfw.test>` };
	};
});
afterEach(() => {
	transport.send = realSend;
});

async function setup() {
	const mb = await makeMailbox();
	const api = `/api/mailboxes/${mb.id}`;
	const deliver = async (from: string, subject = "Hi") => {
		const { message } = inbound(eml({ to: mb.address, from, subject, messageId: `${crypto.randomUUID()}@x.test` }), mb.address);
		await handleInbound(message, env);
	};
	const create = async (body: object) => send(`${api}/address-book`, body);
	return { mb, api, deliver, create };
}

describe("address book", () => {
	it("creates, lists, edits and deletes contacts", async () => {
		const { api, create } = await setup();
		const res = await create({ name: "  Priya Shah ", emails: ["Priya@Example.com", "priya@example.com", "p.shah@work.test"], phone: "+44 20 1234", company: "Acme" });
		expect(res.status).toBe(201);
		const priya = await res.json<SavedContact>();
		expect(priya).toMatchObject({ name: "Priya Shah", emails: ["priya@example.com", "p.shah@work.test"], phone: "+44 20 1234", company: "Acme" });
		await create({ name: "Ben Ode", emails: ["ben@example.com"] });
		await create({ name: "", emails: ["zed@example.com"] });

		expect((await get<SavedContact[]>(`${api}/address-book`)).map((c) => c.name)).toEqual(["Ben Ode", "Priya Shah", ""]);
		expect((await get<SavedContact[]>(`${api}/address-book?q=acme`)).map((c) => c.name)).toEqual(["Priya Shah"]);
		expect((await get<SavedContact[]>(`${api}/address-book?q=work.test`)).map((c) => c.name)).toEqual(["Priya Shah"]);

		const edited = await send(`${api}/address-book/${priya.id}`, { ...priya, emails: ["p.shah@work.test"], notes: "Met at the conference" }, "PUT");
		expect(await edited.json()).toMatchObject({ emails: ["p.shah@work.test"], notes: "Met at the conference" });

		expect((await call(`${api}/address-book/${priya.id}`, { method: "DELETE" })).status).toBe(204);
		expect((await call(`${api}/address-book/${priya.id}`, { method: "DELETE" })).status).toBe(404);
		expect((await get<SavedContact[]>(`${api}/address-book`)).map((c) => c.name)).toEqual(["Ben Ode", ""]);
	});

	it("keeps each address with one contact, and checks input", async () => {
		const { api, create } = await setup();
		await create({ name: "Ben", emails: ["ben@example.com"] });
		const dup = await create({ name: "Benjamin", emails: ["BEN@example.com"] });
		expect(dup.status).toBe(409);
		expect((await dup.json<{ error: string }>()).error).toBe("ben@example.com is already saved as Ben");
		expect((await create({ name: "", emails: [] })).status).toBe(400);
		expect((await create({ name: "Bad", emails: ["not-an-address"] })).status).toBe(400);
		expect((await send(`${api}/address-book/nope`, { name: "X" }, "PUT")).status).toBe(404);
	});

	it("suggests saved contacts first, under their saved names, then people from your mail", async () => {
		const { mb, api, deliver, create } = await setup();
		await deliver("Pat Frequent <pat@mail.test>");
		await deliver("Pat Frequent <pat@mail.test>");
		await deliver("Paula Unsaved <paula@mail.test>");
		await create({ name: "Patricia (saved)", emails: ["patricia@home.test"] });
		await create({ name: "Pat F.", emails: ["pat@mail.test"] });

		const suggestions = await get<Contact[]>(`${api}/contacts?q=pa`);
		expect(suggestions).toEqual([
			{ name: "Pat F.", address: "pat@mail.test" },
			{ name: "Patricia (saved)", address: "patricia@home.test" },
			{ name: "Paula Unsaved", address: "paula@mail.test" },
		]);
		// Every saved address is suggested, including a contact's second one.
		await send(`${api}/address-book`, { name: "Robin", emails: ["robin@one.test", "robin@two.test"] });
		expect((await get<Contact[]>(`${api}/contacts?q=robin`)).map((c) => c.address)).toEqual(["robin@one.test", "robin@two.test"]);
		expect((await get<Contact[]>(`${api}/contacts?q=${mb.address.split("@")[0]}`)).map((c) => c.address)).not.toContain(mb.address);
	});

	it("lists other contacts: people you've corresponded with who aren't saved", async () => {
		const { api, deliver, create } = await setup();
		await deliver("Old Friend <old@mail.test>");
		await deliver("New Friend <new@mail.test>");
		await create({ name: "Saved", emails: ["new@mail.test"] });
		const others = await get<OtherContact[]>(`${api}/address-book/other`);
		expect(others.map((o) => [o.name, o.address, o.receivedCount])).toEqual([["Old Friend", "old@mail.test", 1]]);
		expect(await get<OtherContact[]>(`${api}/address-book/other?q=nobody`)).toEqual([]);
	});

	it("imports vCards from other apps and merges ones you already have", async () => {
		const { api, create } = await setup();
		await create({ name: "Ben Ode", emails: ["ben@example.com"] });
		const vcf = [
			// Google Contacts (vCard 3.0)
			"BEGIN:VCARD",
			"VERSION:3.0",
			"FN:Ada Lovelace",
			"N:Lovelace;Ada;;;",
			"EMAIL;TYPE=INTERNET;TYPE=HOME:ada@example.com",
			"EMAIL;TYPE=INTERNET;TYPE=WORK;TYPE=pref:ada@engine.test",
			"TEL;TYPE=CELL:+1 555 0100",
			"ORG:Analytical Engines;R&D",
			"NOTE:Line one\\nLine two\\, with comma",
			"END:VCARD",
			// Apple Contacts: grouped properties, folded lines
			"BEGIN:VCARD",
			"VERSION:3.0",
			"N:Ode;Ben;;;",
			"FN:Ben Ode",
			"item1.EMAIL;type=INTERNET;type=pref:ben@example.com",
			"item2.EMAIL;type=INTERNET:ben@other.test",
			"TEL;type=CELL;type=VOICE;type=pref:07700 9",
			" 00123",
			"END:VCARD",
			// Outlook (vCard 2.1, quoted-printable)
			"BEGIN:VCARD",
			"VERSION:2.1",
			"N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:M=C3=BCller;J=C3=BCrgen",
			"EMAIL;PREF;INTERNET:juergen@example.de",
			// A soft line break: the line ends in "=" and the next one continues it.
			"NOTE;ENCODING=QUOTED-PRINTABLE:Gr=C3=BC=C3=9Fe aus =",
			"Berlin",
			"END:VCARD",
			// No email address: skipped.
			"BEGIN:VCARD",
			"VERSION:3.0",
			"FN:Phone Only",
			"TEL:123",
			"END:VCARD",
		].join("\r\n");

		const res = await send(`${api}/address-book/import`, { vcf });
		expect(await res.json<ImportContactsResult>()).toEqual({ added: 2, updated: 1, skipped: 1 });
		const book = await get<SavedContact[]>(`${api}/address-book`);
		expect(book.map((c) => [c.name, c.emails, c.phone, c.company, c.notes])).toEqual([
			["Ada Lovelace", ["ada@engine.test", "ada@example.com"], "+1 555 0100", "Analytical Engines, R&D", "Line one\nLine two, with comma"],
			["Ben Ode", ["ben@example.com", "ben@other.test"], "07700 900123", "", ""],
			["Jürgen Müller", ["juergen@example.de"], "", "", "Grüße aus Berlin"],
		]);

		// Importing the same file again changes nothing.
		expect(await (await send(`${api}/address-book/import`, { vcf })).json()).toEqual({ added: 0, updated: 0, skipped: 1 });
		expect((await send(`${api}/address-book/import`, { vcf: "hello" })).status).toBe(400);
	});

	it("exports a vCard file that imports back the same", async () => {
		const { api, create } = await setup();
		await create({ name: "Zoë Ångström", emails: ["zoe@example.com", "z@work.test"], phone: "+46 8 123", company: "Nordic; Ltd", notes: "Likes long notes, ".repeat(10).trim() });
		const res = await call(`${api}/address-book.vcf`);
		expect(res.headers.get("content-type")).toBe("text/vcard; charset=utf-8");
		expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename=".*-contacts\.vcf"/);
		const text = await res.text();
		for (const line of text.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
		expect(parseVCards(text)).toEqual([
			{ name: "Zoë Ångström", emails: ["zoe@example.com", "z@work.test"], phone: "+46 8 123", company: "Nordic; Ltd", notes: "Likes long notes, ".repeat(10).trim() },
		]);
		expect(toVCards([])).toBe("");
	});

	it("deletes several contacts at once", async () => {
		const { api, create } = await setup();
		const a = await (await create({ name: "A", emails: ["a@x.test"] })).json<SavedContact>();
		const b = await (await create({ name: "B", emails: ["b@x.test"] })).json<SavedContact>();
		await create({ name: "C", emails: ["c@x.test"] });
		expect(await (await send(`${api}/address-book/delete`, { contactIds: [a.id, b.id] })).json()).toEqual({ deleted: 2 });
		expect((await get<SavedContact[]>(`${api}/address-book`)).map((c) => c.name)).toEqual(["C"]);
	});

	it("lets the vacation responder answer saved contacts when it's limited to contacts", async () => {
		const { api, deliver, create } = await setup();
		await send(`${api}/settings`, { vacation: { ...DEFAULT_VACATION, enabled: true, message: "Away", contactsOnly: true } }, "PATCH");
		await deliver("Stranger <stranger@mail.test>", "One");
		expect(outbox).toHaveLength(0);
		await create({ name: "Friend", emails: ["friend@mail.test"] });
		await deliver("Friend <friend@mail.test>", "Two");
		expect(outbox).toHaveLength(1);
	});
});
