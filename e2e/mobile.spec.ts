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

test("swipe a conversation to archive it", async ({ page, request, mailbox }) => {
	await deliver(request, mailbox, { subject: "Swipe me away", text: "Body" });
	await deliver(request, mailbox, { subject: "Keep me", text: "Body" });
	await openMailbox(page, mailbox);
	const target = row(page, "Swipe me away").locator("[class*=touch-pan-y]");
	const box = (await target.boundingBox())!;
	const y = box.y + box.height / 2;
	const at = (x: number) => ({ pointerType: "touch", pointerId: 7, isPrimary: true, clientX: x, clientY: y, bubbles: true });
	await target.dispatchEvent("pointerdown", at(box.x + box.width - 20));
	for (const x of [box.width - 40, box.width - 120, box.width - 220, 30]) await target.dispatchEvent("pointermove", at(box.x + x));
	await target.dispatchEvent("pointerup", at(box.x + 30));

	await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Conversation archived." })).toBeVisible();
	await expect(row(page, "Swipe me away")).toBeHidden();
	await expect(row(page, "Keep me")).toBeVisible();
});
