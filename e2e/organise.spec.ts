import { deliver, expect, openMailbox, row, sidebar, test, toast } from "./fixtures";

test("snooze from the list and wake it from Snoozed", async ({ page, request, mailbox }) => {
	await deliver(request, mailbox, { subject: "Renew passport", text: "Reminder" });
	await openMailbox(page, mailbox);
	await row(page, "Renew passport").hover();
	await row(page, "Renew passport").getByRole("button", { name: "Snooze" }).click();
	await page.getByRole("menuitem", { name: "Pick date & time" }).click();
	const dialog = page.getByRole("dialog", { name: "Pick date & time" });
	await dialog.getByLabel("Date").fill("2031-01-15");
	await dialog.getByLabel("Time").fill("09:00");
	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(toast(page, /snoozed until/)).toBeVisible();
	await expect(row(page, "Renew passport")).toBeHidden();

	await sidebar(page).getByRole("link", { name: "Snoozed" }).click();
	await expect(row(page, "Renew passport")).toContainText("Jan 15");
	await row(page, "Renew passport").getByRole("checkbox").click();
	await page.getByRole("button", { name: "Unsnooze" }).click();
	await expect(row(page, "Renew passport")).toBeHidden();
	await sidebar(page).getByRole("link", { name: /^Inbox/ }).click();
	await expect(row(page, "Renew passport")).toBeVisible();
});

test("keyboard shortcuts", async ({ page, request, mailbox }) => {
	const base = Date.now();
	for (const [i, subject] of ["Third", "Second", "First"].entries()) {
		await deliver(request, mailbox, { subject: `${subject} note`, text: subject, date: new Date(base - (3 - i) * 60_000) });
	}
	await openMailbox(page, mailbox);
	await expect(page.getByRole("listitem")).toHaveCount(3);

	await page.keyboard.press("j"); // shows the cursor on the top row
	await page.keyboard.press("j");
	await page.keyboard.press("o");
	await expect(page.getByRole("heading", { name: "Second note" })).toBeVisible();
	await page.keyboard.press("j");
	await expect(page.getByRole("heading", { name: "Third note" })).toBeVisible();
	await page.keyboard.press("u");
	await page.keyboard.press("e");
	await expect(toast(page, "Conversation archived.")).toBeVisible();
	await expect(page.getByRole("listitem")).toHaveCount(2);

	await page.keyboard.press("g");
	await page.keyboard.press("a");
	await expect(page).toHaveURL(/\/all$/);
	await page.keyboard.press("?");
	await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeHidden();
	await page.keyboard.press("c");
	await expect(page.getByRole("dialog", { name: "New Message" })).toBeVisible();
	// Typing in the composer isn't taken as shortcuts.
	await page.keyboard.type("ge");
	await expect(page).toHaveURL(/\/all$/);
	await page.getByRole("button", { name: "Discard draft" }).click();
});

test("vacation responder, its banner, and End now", async ({ page, mailbox }) => {
	await openMailbox(page, mailbox);
	await page.getByRole("button", { name: "Settings" }).click();
	const settings = page.getByRole("dialog", { name: "Settings" });
	await settings.getByRole("tab", { name: "Vacation" }).click();
	await settings.getByRole("switch", { name: "Vacation responder" }).click();
	await expect(settings.getByRole("button", { name: "Save changes" })).toBeDisabled();
	await settings.getByLabel("Subject").fill("Away");
	await settings.getByLabel("Message").fill("Back next week.");
	await settings.getByRole("button", { name: "Save changes" }).click();
	const banner = page.getByRole("status").filter({ hasText: "Vacation responder is on" });
	await expect(banner).toContainText("Away");
	await banner.getByRole("button", { name: "End now" }).click();
	await expect(banner).toBeHidden();
});
