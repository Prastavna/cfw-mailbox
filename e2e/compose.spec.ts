import { deliver, expect, openMailbox, row, sidebar, test, toast } from "./fixtures";

test("write, undo send, send, and find it in Sent", async ({ page, request, mailbox }) => {
	await request.patch(`/api/mailboxes/${mailbox.id}/settings`, { data: { undoSendSeconds: 5 } });
	await openMailbox(page, mailbox);

	await page.getByRole("button", { name: "Compose" }).click();
	const compose = page.getByRole("dialog", { name: "New Message" });
	await compose.getByLabel("To recipients").fill("Bob <bob@example.net>, not-an-address,");
	await expect(compose.getByText("not-an-address")).toBeVisible();
	await compose.getByRole("button", { name: "Remove not-an-address" }).click();
	await compose.getByLabel("Subject").fill("Quarterly numbers");
	const window = page.getByRole("dialog", { name: "Quarterly numbers" });
	await window.getByRole("textbox", { name: "Message body" }).click();
	await page.keyboard.press("Control+Home");
	await page.keyboard.type("Numbers are ");
	await page.keyboard.press("Control+b");
	await page.keyboard.type("up");
	await expect(window.getByText("Draft saved")).toBeVisible({ timeout: 10_000 });

	await window.locator("input[type=file]").setInputFiles({ name: "q3.csv", mimeType: "text/csv", buffer: Buffer.from("q,v\n3,42\n") });
	await expect(window.getByText("q3.csv")).toBeVisible();
	await expect(window.getByText("Uploading…")).toBeHidden();

	await window.getByRole("button", { name: "Send", exact: true }).click();
	await toast(page, "Message sent.").getByRole("button", { name: "Undo" }).click();
	await expect(toast(page, "Sending undone.")).toBeVisible();
	await expect(window.getByText("q3.csv")).toBeVisible();

	await window.getByRole("button", { name: "Send", exact: true }).click();
	await expect(window).toBeHidden();
	await sidebar(page).getByRole("link", { name: "Sent" }).click();
	await expect(row(page, "Quarterly numbers")).toBeVisible({ timeout: 20_000 });
	await row(page, "Quarterly numbers").getByRole("link").click();
	await expect(page.frameLocator("iframe").first().locator("strong", { hasText: "up" })).toBeVisible();
	await expect(page.getByRole("region", { name: "Attachments" }).getByText("q3.csv")).toBeVisible();
});

test("reply in a conversation, then the recipient is suggested", async ({ page, request, mailbox }) => {
	await deliver(request, mailbox, { from: "Dana Lee <dana@sender.test>", subject: "Dinner?", messageId: "dinner@sender.test", text: "Friday at 7?" });
	await openMailbox(page, mailbox);
	await row(page, "Dinner?").getByRole("link").click();
	await page.getByRole("button", { name: "Reply", exact: true }).last().click();
	const reply = page.getByRole("dialog", { name: "Re: Dinner?" });
	await expect(reply).toBeVisible();
	await page.keyboard.type("Friday works.");
	await reply.getByRole("button", { name: "Send", exact: true }).click();
	await expect(page.getByText("Friday works.")).toBeVisible({ timeout: 20_000 });
	await expect(page.getByRole("heading", { name: "Dinner?" })).toBeVisible();

	await page.getByRole("button", { name: "Compose" }).click();
	const to = page.getByRole("combobox", { name: "To recipients" });
	await to.pressSequentially("dan");
	await page.getByRole("listbox", { name: "Suggested recipients" }).getByRole("option", { name: /Dana Lee/ }).click();
	await expect(page.getByRole("dialog", { name: "New Message" }).getByText("Dana Lee", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Discard draft" }).click();
});
