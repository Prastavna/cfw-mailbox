import { describe, expect, it } from "vitest";
import {
	escapeHtml,
	initialBody,
	parseAddressList,
	prefixSubject,
	QUOTE_MARKER,
	quoteBlock,
	replyRecipients,
	splitDraftHtml,
	textToHtml,
} from "../app/lib/compose";

const ME = "me@example.test";
const a = (address: string, name = "") => ({ name, address });

describe("addresses", () => {
	it("parses typed and pasted lists", () => {
		expect(parseAddressList('Bob <Bob@X.test>, "Smith, Al" <al@y.test>; c@z.test\nmailto:d@w.test')).toEqual([
			a("bob@x.test", "Bob"),
			a("al@y.test", "Smith, Al"),
			a("c@z.test"),
			a("d@w.test"),
		]);
		expect(parseAddressList(" , ;")).toEqual([]);
	});
});

describe("replies", () => {
	const message = {
		from: a("alice@x.test", "Alice"),
		to: [a(ME), a("bob@x.test", "Bob")],
		cc: [a("carol@x.test"), a("alice@x.test")],
		replyTo: [],
		subject: "Plans",
		sentAt: Date.UTC(2026, 10, 2, 15, 4),
	};

	it("replies to the sender, or Reply-To when set", () => {
		expect(replyRecipients(message, ME, false)).toEqual({ to: [a("alice@x.test", "Alice")], cc: [] });
		expect(replyRecipients({ ...message, replyTo: [a("list@x.test")] }, ME, false).to).toEqual([a("list@x.test")]);
	});

	it("reply all includes everyone except this mailbox, without duplicates", () => {
		expect(replyRecipients(message, ME, true)).toEqual({
			to: [a("alice@x.test", "Alice"), a("bob@x.test", "Bob")],
			cc: [a("carol@x.test")],
		});
	});

	it("replying to your own message goes to its recipients", () => {
		const mine = { ...message, from: a(ME), to: [a("bob@x.test")], cc: [] };
		expect(replyRecipients(mine, ME, false)).toEqual({ to: [a("bob@x.test")], cc: [] });
	});

	it("prefixes subjects once", () => {
		expect(prefixSubject("Plans", "Re")).toBe("Re: Plans");
		expect(prefixSubject("RE: Plans", "Re")).toBe("RE: Plans");
		expect(prefixSubject("Fw: Plans", "Fwd")).toBe("Fw: Plans");
		expect(prefixSubject("Re: Plans", "Fwd")).toBe("Fwd: Re: Plans");
	});

	it("quotes the original below a marker the draft can be split on", () => {
		const quote = quoteBlock(message, "<p>hi</p>", "reply", () => "Mon, Nov 2");
		expect(quote.startsWith(QUOTE_MARKER)).toBe(true);
		expect(quote).toContain("On Mon, Nov 2, Alice &lt;");
		expect(quote).toContain("<blockquote");

		const html = `<p>Sounds good</p>${quote}`;
		expect(splitDraftHtml(html)).toEqual({ body: "<p>Sounds good</p>", quote });
		expect(splitDraftHtml("<p>x</p>")).toEqual({ body: "<p>x</p>", quote: null });
		// Replying to a reply: the quoted message carries its own quote inside ours.
		const nested = quoteBlock(message, `<p>earlier</p>${quote}`, "reply", () => "Tue");
		expect(splitDraftHtml(`<p>Again</p>${nested}`)).toEqual({ body: "<p>Again</p>", quote: nested });

		const fwd = quoteBlock(message, "<p>hi</p>", "forward", () => "Mon, Nov 2");
		expect(fwd).toContain("Forwarded message");
		expect(fwd).toContain("Cc: ");
	});
});

describe("bodies", () => {
	it("escapes and converts text", () => {
		expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
		expect(textToHtml("one\ntwo\n\nthree <b>")).toBe("<p>one<br>two</p><p>three &lt;b&gt;</p>");
	});

	it("starts with an empty line and the signature", () => {
		expect(initialBody("")).toBe("<p></p>");
		expect(initialBody("Jane\nACME <3")).toBe("<p></p><p>-- <br>Jane<br>ACME &lt;3</p>");
	});
});
