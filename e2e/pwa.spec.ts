import { deliver, expect, openMailbox, row, test, toast } from "./fixtures";

test("the app is installable", async ({ page, request, mailbox }) => {
	const manifest = await (await request.get("/manifest.webmanifest")).json();
	expect(manifest).toMatchObject({ name: "Mail", display: "standalone", start_url: "/" });
	for (const icon of manifest.icons) expect((await request.get(icon.src)).ok(), icon.src).toBe(true);

	await openMailbox(page, mailbox);
	await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
	const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
	expect(new URL(scope).pathname).toBe("/");
});

test("offline mail: read saved conversations without a connection", async ({ page, context, request, mailbox, consoleErrors }) => {
	await deliver(request, mailbox, { subject: "Boarding pass", text: "Gate 22, seat 14A" });
	await deliver(request, mailbox, { subject: "Hotel booking", text: "Check-in from 3pm" });
	await openMailbox(page, mailbox);
	await page.waitForFunction(() => !!navigator.serviceWorker.controller);

	await page.getByRole("button", { name: "Settings" }).click();
	const settings = page.getByRole("dialog", { name: "Settings" });
	await settings.getByRole("tab", { name: "This device" }).click();
	await settings.getByRole("switch", { name: "Offline mail" }).click();
	await expect(toast(page, /Offline mail is on\. 2 conversations saved/)).toBeVisible();
	await page.keyboard.press("Escape");
	// Open one conversation while online, so the dev server's unbundled thread screen is saved too
	// (a production build's screens are saved up front). The other one is only saved by the sync.
	await row(page, "Hotel booking").getByRole("link").click();
	await expect(page.getByRole("heading", { name: "Hotel booking" })).toBeVisible();
	await page.goBack();

	await context.setOffline(true);
	await page.reload();
	await expect(page.getByRole("status").filter({ hasText: "Showing mail saved on this device" })).toBeVisible({ timeout: 20_000 });
	await row(page, "Boarding pass").getByRole("link").click();
	await expect(page.getByRole("heading", { name: "Boarding pass" })).toBeVisible();
	await expect(page.getByRole("main").getByText("Gate 22, seat 14A").last()).toBeVisible();

	await context.setOffline(false);
	// Failed requests and the dropped live connection are expected while offline.
	consoleErrors.splice(0);

	// Turning it off deletes what was saved.
	await page.goto(`/mail/${mailbox.id}/inbox`);
	await page.getByRole("button", { name: "Settings" }).click();
	await settings.getByRole("tab", { name: "This device" }).click();
	await settings.getByRole("switch", { name: "Offline mail" }).click();
	await expect(toast(page, /Offline mail is off/)).toBeVisible();
	expect(await page.evaluate(async () => (await caches.keys()).includes("cfw-data-v1"))).toBe(false);
});
