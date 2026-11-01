import { deliver, expect, openMailbox, row, test, waitForLive } from "./fixtures";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

test("reads a conversation: unread state, remote images, inline images, attachments", async ({ page, request, mailbox }) => {
	let trackerHits = 0;
	await page.route("https://tracker.example/**", (route) => {
		trackerHits++;
		return route.fulfill({ contentType: "image/png", body: PNG });
	});
	await deliver(request, mailbox, {
		from: "Bob Builder <bob@sender.test>",
		subject: "Site visit",
		messageId: "visit-1@sender.test",
		html: '<p>Plan attached. Map: <img alt="map" src="cid:map1"> Tracking: <img alt="tracker" src="https://tracker.example/pixel.gif"></p>',
		attachments: [
			{ filename: "map.png", mimeType: "image/png", content: PNG, contentId: "map1" },
			{ filename: "plan.pdf", mimeType: "application/pdf", content: Buffer.from("%PDF-1.4\n%%EOF\n") },
		],
	});
	await deliver(request, mailbox, {
		from: "Carol <carol@sender.test>",
		subject: "Re: Site visit",
		inReplyTo: "visit-1@sender.test",
		text: "Thursday works for me.",
	});

	await openMailbox(page, mailbox);
	const link = row(page, "Site visit").getByRole("link");
	await expect(link).toHaveAttribute("aria-label", /^Unread, /);
	await expect(row(page, "Site visit")).toContainText("2");
	await link.click();

	await expect(page.getByRole("heading", { name: "Site visit" })).toBeVisible();
	await expect(page.getByText("Thursday works for me.")).toBeVisible();

	// Both messages were unread, so both are open. Remote images are held back; the inline one shows.
	const frame = page.frameLocator('iframe[title="Message from Bob Builder"]');
	await expect(frame.getByAltText("map")).toBeVisible();
	await expect(page.getByText("Images are hidden to protect your privacy.")).toBeVisible();
	expect(trackerHits).toBe(0);
	await page.getByRole("button", { name: "Display images" }).click();
	await expect(page.getByText("Images are hidden to protect your privacy.")).toBeHidden();
	await expect(frame.getByAltText("tracker")).toBeVisible();
	expect(trackerHits).toBe(1);

	const attachments = page.getByRole("region", { name: "Attachments" });
	await expect(attachments.getByText("plan.pdf")).toBeVisible();
	const download = page.waitForEvent("download");
	await attachments.getByRole("link", { name: /plan\.pdf/ }).click();
	expect((await download).suggestedFilename()).toBe("plan.pdf");

	await page.getByRole("link", { name: "Back to list" }).click();
	await expect(row(page, "Site visit").getByRole("link")).not.toHaveAttribute("aria-label", /^Unread/);
});

test("new mail appears without reloading", async ({ page, request, mailbox }) => {
	await openMailbox(page, mailbox);
	await waitForLive(page);
	await expect(page.getByText("Your inbox is empty.")).toBeVisible();
	await deliver(request, mailbox, { subject: "Live one", text: "hello" });
	await expect(row(page, "Live one")).toBeVisible();
});
