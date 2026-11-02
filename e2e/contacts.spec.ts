import { deliver, expect, openMailbox, row, sidebar, test, toast } from "./fixtures";

test("save a sender, manage contacts, import and export", async ({ page, request, mailbox, consoleErrors }) => {
	await deliver(request, mailbox, { from: "Dana Ross <dana@sender.test>", subject: "Kickoff notes", text: "See you Monday" });
	await deliver(request, mailbox, { from: "Omar Unsaved <omar@sender.test>", subject: "Hello", text: "Hi" });
	await openMailbox(page, mailbox);

	// From a message: More → Add to contacts, prefilled with the sender.
	await row(page, "Kickoff notes").getByRole("link").click();
	await page.getByRole("button", { name: "More", exact: true }).click();
	await page.getByRole("menuitem", { name: "Add Dana Ross to contacts" }).click();
	const dialog = page.getByRole("dialog", { name: "New contact" });
	await expect(dialog.getByLabel("Name")).toHaveValue("Dana Ross");
	await expect(dialog.getByLabel("Email", { exact: true })).toHaveValue("dana@sender.test");
	await dialog.getByLabel("Company").fill("Ross & Co");
	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(toast(page, "Dana Ross added to contacts.")).toBeVisible();
	await page.getByRole("button", { name: "More", exact: true }).click();
	await expect(page.getByRole("menuitem", { name: "Edit contact" })).toBeVisible();
	await page.keyboard.press("Escape");

	// The Contacts page.
	await sidebar(page).getByRole("link", { name: "Contacts" }).click();
	const contacts = page.getByRole("list", { name: "Contacts" });
	await expect(contacts.getByRole("listitem", { name: "Dana Ross" })).toContainText("Ross & Co");

	await page.getByRole("tab", { name: "Other contacts" }).click();
	const others = page.getByRole("list", { name: "Other contacts" });
	await expect(others.getByRole("listitem")).toHaveCount(1);
	await others.getByRole("button", { name: "Add Omar Unsaved to contacts" }).click();
	await page.getByRole("dialog", { name: "New contact" }).getByRole("button", { name: "Save" }).click();
	await expect(toast(page, "Omar Unsaved added to contacts.")).toBeVisible();
	await expect(page.getByText("Nobody yet.")).toBeVisible();
	await page.getByRole("tab", { name: "Contacts", exact: true }).click();

	// Create, with two addresses; the same address can't be saved twice.
	await page.getByRole("button", { name: "Create contact" }).click();
	const create = page.getByRole("dialog", { name: "New contact" });
	await create.getByLabel("Name").fill("Bea Two-Addresses");
	await create.getByLabel("Email", { exact: true }).fill("bea@home.test");
	await create.getByRole("button", { name: "Add email" }).click();
	await create.getByLabel("Email 2").fill("dana@sender.test");
	await create.getByRole("button", { name: "Save" }).click();
	await expect(create.getByRole("alert")).toHaveText("dana@sender.test is already saved as Dana Ross");
	// The browser logs the refused request; that one is expected.
	consoleErrors.splice(0, consoleErrors.length, ...consoleErrors.filter((e) => !/409 \(Conflict\).*address-book$/.test(e)));
	await create.getByLabel("Email 2").fill("bea@work.test");
	await create.getByRole("button", { name: "Save" }).click();
	await expect(contacts.getByRole("listitem", { name: "Bea Two-Addresses" })).toContainText("bea@home.test +1");

	// Search, then email a contact.
	await page.getByLabel("Search contacts").fill("ross");
	await expect(contacts.getByRole("listitem")).toHaveCount(1);
	await contacts.getByRole("button", { name: "Email Dana Ross" }).click();
	const compose = page.getByRole("dialog", { name: "New Message" });
	await expect(compose).toContainText("Dana Ross");
	await page.getByRole("button", { name: "Discard draft" }).click();
	await page.getByLabel("Search contacts").fill("");

	// Saved names are suggested when writing.
	await page.getByRole("button", { name: "Compose" }).click();
	await page.getByRole("combobox", { name: "To recipients" }).pressSequentially("bea");
	await expect(page.getByRole("listbox", { name: "Suggested recipients" }).getByRole("option", { name: /Bea Two-Addresses/ })).toHaveCount(2);
	await page.getByRole("button", { name: "Discard draft" }).click();

	// Import a vCard file.
	await page.getByRole("button", { name: "Import and export" }).click();
	const chooser = page.waitForEvent("filechooser");
	await page.getByRole("menuitem", { name: "Import (.vcf)" }).click();
	await (await chooser).setFiles({
		name: "contacts.vcf",
		mimeType: "text/vcard",
		buffer: Buffer.from("BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Imported Ivy\r\nEMAIL:ivy@import.test\r\nTEL:555-0101\r\nEND:VCARD\r\n"),
	});
	await expect(toast(page, "Contacts imported: 1 added.")).toBeVisible();
	await expect(contacts.getByRole("listitem", { name: "Imported Ivy" })).toContainText("555-0101");

	// Export.
	await page.getByRole("button", { name: "Import and export" }).click();
	const download = page.waitForEvent("download");
	await page.getByRole("menuitem", { name: "Export (.vcf)" }).click();
	const file = await (await download).path();
	const text = await import("node:fs/promises").then((fs) => fs.readFile(file!, "utf8"));
	expect(text.match(/BEGIN:VCARD/g)).toHaveLength(4);
	expect(text).toContain("EMAIL;TYPE=INTERNET,PREF:ivy@import.test");

	// Edit, then delete.
	await contacts.getByRole("listitem", { name: "Imported Ivy" }).getByRole("button", { name: "Edit Imported Ivy" }).click();
	const edit = page.getByRole("dialog", { name: "Edit contact" });
	await edit.getByLabel("Name").fill("Ivy Imported");
	await edit.getByRole("button", { name: "Save" }).click();
	await expect(toast(page, "Contact saved.")).toBeVisible();
	await contacts.getByRole("listitem", { name: "Ivy Imported" }).getByRole("checkbox").click();
	await contacts.getByRole("listitem", { name: "Omar Unsaved" }).getByRole("checkbox").click();
	await page.getByRole("button", { name: "Delete 2" }).click();
	await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
	await expect(toast(page, "2 contacts deleted.")).toBeVisible();
	await expect(contacts.getByRole("listitem")).toHaveCount(2);
});
