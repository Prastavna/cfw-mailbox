import { deliver, expect, test } from "./fixtures";

test("pages carry a nonce-based CSP and the usual security headers", async ({ page, mailbox }) => {
	const response = await page.goto(`/mail/${mailbox.id}/inbox`);
	const headers = response!.headers();
	const csp = headers["content-security-policy"] ?? "";
	const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
	expect(nonce).toBeTruthy();
	expect(csp).toContain("frame-ancestors 'none'");
	expect(csp).toContain("object-src 'none'");
	expect(headers["x-frame-options"]).toBe("DENY");
	expect(headers["x-content-type-options"]).toBe("nosniff");
	// Every script on the page is one the server vouched for.
	const scripts = await page.locator("script").evaluateAll((els) => els.map((e) => (e as HTMLScriptElement).nonce));
	expect(scripts.length).toBeGreaterThan(0);
	expect(scripts.every((n) => n === nonce)).toBe(true);
	await expect(page.getByRole("button", { name: "Compose" })).toBeVisible();
});

test("cross-site writes and unknown mailboxes are refused", async ({ request, mailbox }) => {
	const evil = await request.post(`/api/mailboxes/${mailbox.id}/labels`, {
		data: { name: "x" },
		headers: { Origin: "https://evil.example" },
	});
	expect(evil.status()).toBe(403);
	const form = await request.post(`/api/mailboxes/${mailbox.id}/labels`, {
		data: "name=x",
		headers: { "content-type": "application/x-www-form-urlencoded" },
	});
	expect(form.status()).toBe(415);
	expect((await request.get(`/api/mailboxes/00000000-0000-0000-0000-000000000000/labels`)).status()).toBe(404);
});

test("exports the mailbox as mbox", async ({ page, request, mailbox }) => {
	await deliver(request, mailbox, { subject: "Keep me", text: "From the archive\nline two" });
	await page.goto(`/mail/${mailbox.id}/inbox`);
	await page.getByRole("button", { name: "Settings" }).click();
	await expect(page.getByText(/1 message,/)).toBeVisible();
	const download = page.waitForEvent("download");
	await page.getByRole("link", { name: "Download all mail (.mbox)" }).click();
	const file = await download;
	expect(file.suggestedFilename()).toMatch(/^erin@e2e-.*\.mbox$/);
	const text = await (await request.get(`/api/mailboxes/${mailbox.id}/export.mbox`)).text();
	expect(text).toMatch(/^From alice@sender\.test /);
	expect(text).toContain("Subject: Keep me");
	expect(text).toContain("\n>From the archive");
});
