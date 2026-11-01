import { type Page } from "@playwright/test";
import { deliver, expect, openMailbox, row, test } from "./fixtures";

async function expectNoSideScroll(page: Page) {
	const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
	expect(overflow, "page scrolls sideways").toBeLessThanOrEqual(0);
}

test("phone layout: list, conversation, folders, compose and settings", async ({ page, request, mailbox }) => {
	await deliver(request, mailbox, {
		from: "A Very Long Sender Name Indeed <someone.with.a.long.address@sender.test>",
		subject: "A subject that is much longer than a phone screen is wide, to check wrapping",
		text: "Body",
	});
	await openMailbox(page, mailbox);
	await expect(row(page, "A subject that is much longer")).toBeVisible();
	await expectNoSideScroll(page);

	await page.getByRole("button", { name: "Main menu" }).click();
	await page.getByRole("dialog").getByRole("link", { name: "Starred" }).click();
	await expect(page).toHaveURL(/\/starred$/);
	await page.goBack();

	await row(page, "A subject that is much longer").getByRole("link").click();
	await expect(page.getByRole("heading", { name: /A subject that is much longer/ })).toBeVisible();
	await expectNoSideScroll(page);
	await page.getByRole("link", { name: "Back to list" }).click();

	await page.getByRole("button", { name: "Settings" }).click();
	await page.getByRole("dialog", { name: "Settings" }).getByRole("tab", { name: "Filters" }).click();
	await expectNoSideScroll(page);
	await page.keyboard.press("Escape");

	await page.getByRole("button", { name: "Compose" }).click();
	await expect(page.getByRole("dialog", { name: "New Message" })).toBeVisible();
	await expectNoSideScroll(page);
});
