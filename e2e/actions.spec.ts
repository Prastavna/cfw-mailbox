import { deliver, expect, openMailbox, row, sidebar, test, toast } from "./fixtures";

test("archive with undo, star, labels, Trash and delete forever", async ({ page, request, mailbox }) => {
	for (const subject of ["Alpha report", "Bravo notes", "Charlie invoice"]) await deliver(request, mailbox, { subject, text: subject });
	await openMailbox(page, mailbox);

	await row(page, "Alpha report").getByRole("checkbox").click();
	await page.getByRole("button", { name: "Archive" }).first().click();
	await expect(row(page, "Alpha report")).toBeHidden();
	await toast(page, "Conversation archived.").getByRole("button", { name: "Undo" }).click();
	await expect(row(page, "Alpha report")).toBeVisible();

	await row(page, "Bravo notes").getByRole("button", { name: "Not starred" }).click();
	await sidebar(page).getByRole("link", { name: "Starred" }).click();
	await expect(row(page, "Bravo notes")).toBeVisible();
	await sidebar(page).getByRole("link", { name: /^Inbox/ }).click();

	await sidebar(page).getByRole("button", { name: "Create new label" }).click();
	await page.getByLabel("Label name").fill("Receipts");
	await page.getByRole("button", { name: "Create" }).click();
	await expect(sidebar(page).getByRole("link", { name: "Receipts" })).toBeVisible();
	await row(page, "Charlie invoice").getByRole("checkbox").click();
	await page.getByRole("button", { name: "Labels" }).click();
	await page.getByRole("menuitemcheckbox", { name: "Receipts" }).click();
	await page.keyboard.press("Escape");
	await expect(row(page, "Charlie invoice")).toContainText("Receipts");
	await sidebar(page).getByRole("link", { name: "Receipts" }).click();
	await expect(row(page, "Charlie invoice")).toBeVisible();

	await row(page, "Charlie invoice").getByRole("checkbox").click();
	await page.getByRole("button", { name: "Delete" }).first().click();
	await expect(row(page, "Charlie invoice")).toBeHidden();
	await sidebar(page).getByRole("link", { name: "Trash" }).click();
	await row(page, "Charlie invoice").getByRole("checkbox").click();
	await page.getByRole("button", { name: "Delete forever" }).first().click();
	await page.getByRole("dialog").getByRole("button", { name: "Delete forever" }).click();
	await expect(page.getByText("No conversations in Trash.")).toBeVisible();
});

test("report spam and move back", async ({ page, request, mailbox }) => {
	await deliver(request, mailbox, { subject: "Cheap watches", text: "buy now" });
	await openMailbox(page, mailbox);
	await row(page, "Cheap watches").getByRole("checkbox").click();
	await page.getByRole("button", { name: "Report spam" }).click();
	await expect(row(page, "Cheap watches")).toBeHidden();
	await sidebar(page).getByRole("link", { name: /^Spam/ }).click();
	await row(page, "Cheap watches").getByRole("checkbox").click();
	await page.getByRole("button", { name: "Not spam" }).click();
	await sidebar(page).getByRole("link", { name: /^Inbox/ }).click();
	await expect(row(page, "Cheap watches")).toBeVisible();
});
