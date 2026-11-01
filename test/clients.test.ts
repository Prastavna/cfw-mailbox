import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Mailbox, ThreadDetail, ThreadPage } from "../shared/api";
import { handleInbound } from "../workers/email/inbound";
import { parseMessage } from "../workers/email/parse";
import appleReply from "./fixtures/apple-mail-reply.eml?raw";
import gmailOriginal from "./fixtures/gmail-original.eml?raw";
import iso2022jp from "./fixtures/iso-2022-jp.eml?raw";
import outlookReply from "./fixtures/outlook-reply.eml?raw";
import { eml, inbound, makeMailbox, PNG } from "./helpers";

const call = (path: string) => exports.default.fetch(new Request(`http://localhost${path}`));

/** Fixtures are stored with LF line endings; mail travels with CRLF. */
const prepare = (fixture: string, to: string) => fixture.replaceAll("{{TO}}", to).replace(/\r?\n/g, "\r\n");

async function deliver(mb: Mailbox, fixture: string, from: string) {
	const { message, rejected } = inbound(prepare(fixture, mb.address), mb.address, from);
	await handleInbound(message, env);
	expect(rejected).toEqual([]);
}

async function threads(mb: Mailbox) {
	return (await (await call(`/api/mailboxes/${mb.id}/threads?label=INBOX`)).json<ThreadPage>()).threads;
}

const thread = async (mb: Mailbox, id: string) => (await call(`/api/mailboxes/${mb.id}/threads/${id}`)).json<ThreadDetail>();

describe("mail from real-world clients", () => {
	it("Gmail: quoted-printable UTF-8 and an inline image", async () => {
		const parsed = await parseMessage(new TextEncoder().encode(prepare(gmailOriginal, "me@x.test")));
		expect(parsed.from).toEqual({ name: "Renée Okafor", address: "renee.okafor@gmail.test" });
		expect(parsed.subject).toBe("Café offsite — venue photos");
		expect(parsed.text).toContain("Here’s the café for the offsite — photo below.");
		expect(parsed.text).toContain("Budget is €1,200");
		expect(parsed.html).toContain('src="cid:ii_mh8x2k4p0"');
		expect(parsed.attachments).toHaveLength(1);
		expect(parsed.attachments[0]).toMatchObject({ filename: "terrace.png", disposition: "inline", contentId: "ii_mh8x2k4p0" });
		expect(parsed.attachments[0]!.content).toEqual(PNG);
	});

	it("Outlook: windows-1252, Office HTML and winmail.dat", async () => {
		const parsed = await parseMessage(new TextEncoder().encode(prepare(outlookReply, "me@x.test")));
		expect(parsed.subject).toBe("RE: Café offsite — venue photos");
		expect(parsed.text).toContain("Looks great – I’ll book it for Thursday. “Terrace” seating please.");
		expect(parsed.text).toContain("From: Renée Okafor");
		expect(parsed.to.map((a) => a.address)).toEqual(["renee.okafor@gmail.test", "me@x.test"]);
		expect(parsed.to[0]!.name).toBe("Renée Okafor");
		expect(parsed.inReplyTo).toBe("CAJ7d+XqA1b2C3d4E5f6G7h8I9j0K@mail.gmail.test");
		expect(parsed.attachments.map((a) => [a.filename, a.mimeType])).toEqual([["winmail.dat", "application/ms-tnef"]]);
	});

	it("Apple Mail: format=flowed, RFC 2231 filenames, References only", async () => {
		const parsed = await parseMessage(new TextEncoder().encode(prepare(appleReply, "me@x.test")));
		expect(parsed.subject).toBe("Re: Café offsite — venue photos");
		expect(parsed.text).toContain("résumé for the speaker bio, as asked.");
		expect(parsed.inReplyTo).toBeNull();
		expect(parsed.references).toEqual([
			"CAJ7d+XqA1b2C3d4E5f6G7h8I9j0K@mail.gmail.test",
			"AM9PR02MB1234ABCD1234EF5678@AM9PR02MB1234.eurprd02.prod.outlook.test",
		]);
		expect(parsed.cc.map((a) => a.address)).toEqual(["me@x.test"]);
		expect(parsed.attachments.map((a) => [a.filename, a.mimeType])).toEqual([["Résumé Priya.pdf", "application/pdf"]]);
		expect(new TextDecoder().decode(parsed.attachments[0]!.content)).toMatch(/^%PDF-1\.4/);
	});

	it("ISO-2022-JP: Japanese subject split across encoded words, and body", async () => {
		const parsed = await parseMessage(new TextEncoder().encode(prepare(iso2022jp, "me@x.test")));
		expect(parsed.from).toEqual({ name: "佐藤 花子", address: "hanako.sato@example.co.test" });
		expect(parsed.subject).toBe("お知らせ：来週の定例会議について");
		expect(parsed.text).toContain("来週の定例会議は水曜日の10時からです。");
	});

	it("threads a Gmail original with Outlook and Apple Mail replies", async () => {
		const mb = await makeMailbox();
		// Delivered out of order: Apple Mail's reply arrives first.
		await deliver(mb, appleReply, "priya@icloud.test");
		await deliver(mb, gmailOriginal, "renee.okafor@gmail.test");
		await deliver(mb, outlookReply, "daniel.brandt@contoso.test");
		await deliver(mb, iso2022jp, "hanako.sato@example.co.test");

		const list = await threads(mb);
		expect(list.map((t) => [t.subject, t.messageCount])).toEqual([
			["お知らせ：来週の定例会議について", 1],
			["Café offsite — venue photos", 3],
		]);
		const cafe = list[1]!;
		expect(cafe.hasAttachments).toBe(true);
		const detail = await thread(mb, cafe.id);
		expect(detail.messages.map((m) => m.from.name)).toEqual(["Renée Okafor", "Daniel Brandt", "Priya Raman"]);

		// The inline image is served from the message, ready for cid: rewriting in the viewer.
		const original = detail.messages[0]!;
		const image = original.attachments.find((a) => a.contentId === "ii_mh8x2k4p0")!;
		expect(image.disposition).toBe("inline");
		const res = await call(`/api/mailboxes/${mb.id}/messages/${original.id}/attachments/${image.id}?inline=1`);
		expect(res.headers.get("content-type")).toBe("image/png");
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);

		// Show original returns the bytes exactly as received.
		const raw = await (await call(`/api/mailboxes/${mb.id}/messages/${original.id}/raw`)).text();
		expect(raw).toBe(prepare(gmailOriginal, mb.address));
	});

	it("joins replies that each arrived before their parent into one conversation", async () => {
		const mb = await makeMailbox();
		const send = async (o: Parameters<typeof eml>[0]) => {
			await handleInbound(inbound(eml(o), mb.address).message, env);
		};
		await send({ to: mb.address, from: "Bob <bob@x.test>", subject: "Re: Launch", messageId: "r1@x.test", inReplyTo: "root@x.test", date: "Mon, 26 Oct 2026 10:05:00 +0000" });
		await send({ to: mb.address, from: "Cat <cat@x.test>", subject: "Re: Launch", messageId: "r2@x.test", references: ["root@x.test"], date: "Mon, 26 Oct 2026 10:06:00 +0000" });
		await send({ to: mb.address, from: "Ann <ann@x.test>", subject: "Launch", messageId: "root@x.test", date: "Mon, 26 Oct 2026 10:00:00 +0000" });

		const list = await threads(mb);
		expect(list.map((t) => [t.subject, t.messageCount])).toEqual([["Launch", 3]]);
		const detail = await thread(mb, list[0]!.id);
		expect(detail.messages.map((m) => m.from.name)).toEqual(["Ann", "Bob", "Cat"]);
	});
});
