import { describe, expect, it } from "vitest";
import { linkify, splitQuotedText } from "../app/lib/email-html";
import { resolveFolder, visibleLabelChips } from "../app/lib/folders";
import { formatListDate, formatSize, participantsLabel, recipientsSummary } from "../app/lib/format";
import type { Label } from "../shared/api";

const ME = "me@example.test";
const userLabel: Label = { id: "lbl-1", name: "Receipts", type: "user", color: "#f00", total: 1, unread: 0 };

describe("format", () => {
	it("formats list dates like Gmail", () => {
		const now = new Date(2026, 10, 1, 15, 0);
		expect(formatListDate(new Date(2026, 10, 1, 9, 5).getTime(), now)).toMatch(/9:05|09:05/);
		expect(formatListDate(new Date(2026, 2, 4).getTime(), now)).toMatch(/Mar|3/);
		expect(formatListDate(new Date(2024, 2, 4).getTime(), now)).toMatch(/24/);
	});

	it("names participants, using 'me' for the mailbox", () => {
		expect(participantsLabel([{ name: "Alice Smith", address: "a@x" }], ME)).toBe("Alice Smith");
		expect(participantsLabel([{ name: "Alice Smith", address: "a@x" }, { name: "", address: ME }], ME)).toBe("Alice, me");
		const many = ["a", "b", "c", "d"].map((n) => ({ name: n.toUpperCase(), address: `${n}@x` }));
		expect(participantsLabel(many, ME)).toBe("A .. C, D");
		expect(participantsLabel([], ME)).toBe("(no sender)");
		expect(recipientsSummary({ to: [{ name: "", address: ME }], cc: [{ name: "Bob B", address: "b@x" }], bcc: [] }, ME)).toBe(
			"to me, Bob",
		);
	});

	it("formats sizes", () => {
		expect([formatSize(512), formatSize(2048), formatSize(3 * 1024 * 1024)]).toEqual(["512 B", "2 KB", "3.0 MB"]);
	});
});

describe("plain-text bodies", () => {
	it("splits off quoted history", () => {
		const text = "Thanks!\n\nOn Mon, 1 Jan 2026 at 10:00, Bob <b@x> wrote:\n> hi\n> there";
		expect(splitQuotedText(text)).toEqual({ body: "Thanks!", quoted: "On Mon, 1 Jan 2026 at 10:00, Bob <b@x> wrote:\n> hi\n> there" });
		expect(splitQuotedText("reply\n\n> old\n> older\n")).toEqual({ body: "reply", quoted: "> old\n> older" });
		expect(splitQuotedText("no quotes here")).toEqual({ body: "no quotes here", quoted: null });
	});

	it("finds links without trailing punctuation", () => {
		expect(linkify("See https://example.com/a?b=1. Bye")).toEqual(["See ", { url: "https://example.com/a?b=1" }, ". Bye"]);
		expect(linkify("javascript:alert(1)")).toEqual(["javascript:alert(1)"]);
	});
});

describe("folders", () => {
	it("resolves system slugs and user label IDs", () => {
		expect(resolveFolder("inbox", [])).toEqual({ labelId: "INBOX", name: "Inbox" });
		expect(resolveFolder("drafts", [])).toEqual({ labelId: "DRAFT", name: "Drafts" });
		expect(resolveFolder("lbl-1", [userLabel])).toEqual({ labelId: "lbl-1", name: "Receipts" });
		expect(resolveFolder("INBOX", [])).toBeNull();
		expect(resolveFolder("nope", [userLabel])).toBeNull();
	});

	it("shows user-label chips and Inbox outside the inbox", () => {
		expect(visibleLabelChips(["INBOX", "UNREAD", "lbl-1"], [userLabel], "INBOX")).toEqual([
			{ id: "lbl-1", name: "Receipts", color: "#f00" },
		]);
		expect(visibleLabelChips(["INBOX", "STARRED"], [userLabel], "STARRED")).toEqual([{ id: "INBOX", name: "Inbox", color: null }]);
	});
});

describe("optimistic list membership", () => {
	it("mirrors the server's view rules", async () => {
		const { belongsTo } = await import("../app/lib/actions");
		expect(belongsTo("INBOX", ["INBOX", "UNREAD"])).toBe(true);
		expect(belongsTo("INBOX", ["UNREAD"])).toBe(false);
		expect(belongsTo("STARRED", ["STARRED", "TRASH"])).toBe(false);
		expect(belongsTo("TRASH", ["STARRED", "TRASH"])).toBe(true);
		expect(belongsTo("SPAM", ["SPAM", "TRASH"])).toBe(false);
		expect(belongsTo("ALL", ["IMPORTANT"])).toBe(true);
		expect(belongsTo("ALL", ["SPAM"])).toBe(false);
	});
});
