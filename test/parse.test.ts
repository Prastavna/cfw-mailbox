import { describe, expect, it } from "vitest";
import {
	htmlToText,
	isReplySubject,
	makeSnippet,
	messageIds,
	normalizeSubject,
	parseAuthResults,
	parseMessage,
} from "../workers/email/parse";
import { eml, PNG } from "./helpers";

const encode = (s: string) => new TextEncoder().encode(s);

describe("parseMessage", () => {
	it("extracts headers, addresses and bodies", async () => {
		const parsed = await parseMessage(
			encode(
				eml({
					from: '"Alice A." <Alice@Sender.test>',
					to: "Me <me@example.test>, Team: bob@example.test, carol@example.test;",
					subject: "=?UTF-8?B?SMOpbGxv?= there",
					messageId: "abc@sender.test",
					inReplyTo: "parent@example.test",
					references: ["root@example.test", "parent@example.test"],
					date: "Tue, 01 Sep 2026 10:00:00 +0000",
					text: "Plain body",
					html: "<p>HTML body</p>",
					extraHeaders: ["Authentication-Results: mx.cloudflare.net; spf=pass smtp.mailfrom=x; dkim=pass header.d=x; dmarc=pass"],
				}),
			),
		);
		expect(parsed.from).toEqual({ name: "Alice A.", address: "alice@sender.test" });
		expect(parsed.to.map((a) => a.address)).toEqual(["me@example.test", "bob@example.test", "carol@example.test"]);
		expect(parsed.subject).toBe("Héllo there");
		expect(parsed.messageId).toBe("abc@sender.test");
		expect(parsed.inReplyTo).toBe("parent@example.test");
		expect(parsed.references).toEqual(["root@example.test", "parent@example.test"]);
		expect(parsed.sentAt).toBe(Date.parse("2026-09-01T10:00:00Z"));
		expect(parsed.text?.trim()).toBe("Plain body");
		expect(parsed.html).toContain("<p>HTML body</p>");
		expect(parsed.authResults).toEqual({ spf: "pass", dkim: "pass", dmarc: "pass" });
	});

	it("separates inline images from real attachments", async () => {
		const parsed = await parseMessage(
			encode(
				eml({
					to: "me@example.test",
					html: '<img src="cid:logo@x">',
					attachments: [
						{ filename: "logo.png", mimeType: "image/png", content: PNG, contentId: "logo@x", inline: true },
						{ filename: "report.pdf", mimeType: "application/pdf", content: encode("%PDF-1.4") },
					],
				}),
			),
		);
		expect(parsed.attachments.map((a) => [a.filename, a.disposition, a.contentId, a.size])).toEqual([
			["logo.png", "inline", "logo@x", PNG.byteLength],
			["report.pdf", "attachment", null, 8],
		]);
	});
});

describe("text helpers", () => {
	it("builds snippets without quoted text", () => {
		const text = "Sounds good!\n\nOn Mon, 1 Jan 2026, Bob <b@x> wrote:\n> earlier message\n> more";
		expect(makeSnippet(text, null)).toBe("Sounds good!");
		expect(makeSnippet(null, "<style>p{}</style><p>Hi&nbsp;&amp; welcome</p>")).toBe("Hi & welcome");
		expect(makeSnippet("x".repeat(300), null)).toHaveLength(200);
	});

	it("converts HTML to text", () => {
		expect(htmlToText("<div>a</div><div>b &#x263A; &lt;c&gt;</div><script>bad()</script>")).toBe("a\nb ☺ <c>");
		expect(htmlToText("<p>Free at <strong>noon</strong>? <a href=\"x\">Link</a>s</p><p>-- <br>Me</p>")).toBe("Free at noon? Links\n--\nMe");
	});

	it("converts hostile HTML in linear time", () => {
		const big = 256 * 1024;
		for (const piece of ["<script", "<!--", "<a", "<style>", "<", "<p x='"]) {
			const start = performance.now();
			htmlToText(piece.repeat(big / piece.length));
			expect(performance.now() - start, piece).toBeLessThan(1000);
		}
		expect(htmlToText("a <!-- hidden --> b <script>x</script>c <style>p{}</STYLE>d")).toBe("a b c d");
		expect(htmlToText("a <> b <c")).toBe("a <> b <c");
		expect(htmlToText("x<script>never closed")).toBe("x never closed");
	});

	it("normalises reply subjects", () => {
		expect(normalizeSubject("Re: RE: Fwd:  Quarterly   Report")).toBe("quarterly report");
		expect(normalizeSubject("AW: Hallo")).toBe("hallo");
		expect(isReplySubject("Re[2]: x")).toBe(true);
		expect(isReplySubject("Regarding x")).toBe(false);
	});

	it("parses Message-ID lists", () => {
		expect(messageIds("<a@x> <b@y>\r\n <c@z>")).toEqual(["a@x", "b@y", "c@z"]);
		expect(messageIds("bare@x")).toEqual(["bare@x"]);
		expect(messageIds(null)).toEqual([]);
	});

	it("parses Authentication-Results", () => {
		expect(parseAuthResults("mx; spf=softfail; dmarc=FAIL")).toEqual({ spf: "softfail", dkim: null, dmarc: "fail" });
		expect(parseAuthResults("mx; none")).toBeNull();
	});
});
