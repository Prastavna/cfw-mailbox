import { deliver, expect, openMailbox, row, test, toast } from "./fixtures";

test("search with operators, the options panel, and a filter made from it", async ({ page, request, mailbox }) => {
	await deliver(request, mailbox, {
		from: "Finance <finance@acme.test>",
		subject: "Budget review",
		text: "Quarterly numbers attached.",
		attachments: [{ filename: "budget.xlsx", mimeType: "application/vnd.ms-excel", content: Buffer.from("x") }],
	});
	await deliver(request, mailbox, { from: "Bob <bob@other.test>", subject: "Lunch plans", html: "<p>Ramen at <b>Café Ōsaka</b>?</p>" });
	await openMailbox(page, mailbox);

	const box = page.getByRole("searchbox", { name: "Search mail" });
	await box.fill("cafe osaka");
	await box.press("Enter");
	await expect(page).toHaveURL(/\/search\?q=cafe%20osaka$/);
	await expect(row(page, "Lunch plans")).toBeVisible();
	await expect(page.getByRole("listitem")).toHaveCount(1);

	await box.fill("has:attachment from:acme.test");
	await box.press("Enter");
	await expect(row(page, "Budget review")).toBeVisible();
	await expect(page.getByRole("listitem")).toHaveCount(1);

	await box.fill('"no such phrase"');
	await box.press("Enter");
	await expect(page.getByText("No messages matched your search.")).toBeVisible();

	await page.getByRole("button", { name: "Show search options" }).click();
	const options = page.getByRole("form", { name: "Search options" });
	await options.getByLabel("Has the words").fill("");
	await options.getByLabel("From").fill("bob@other.test");
	await options.getByRole("button", { name: "Create filter" }).click();
	const settings = page.getByRole("dialog", { name: "Settings" });
	await expect(settings.getByRole("tab", { name: "Filters", selected: true })).toBeVisible();
	await expect(settings.getByLabel("Matches")).toHaveValue("from:bob@other.test");
	await settings.getByLabel("Star it").check();
	await settings.getByLabel("Also apply filter to matching conversations").check();
	await settings.getByRole("button", { name: "Create filter" }).click();
	await expect(toast(page, "Filter created and applied to 1 conversation.")).toBeVisible();
	await page.keyboard.press("Escape");

	// The filter also runs on new mail.
	await deliver(request, mailbox, { from: "Bob <bob@other.test>", subject: "Second lunch", text: "again?" });
	await page.goto(`/mail/${mailbox.id}/starred`);
	await expect(row(page, "Second lunch")).toBeVisible();
	await expect(row(page, "Lunch plans")).toBeVisible();
});
