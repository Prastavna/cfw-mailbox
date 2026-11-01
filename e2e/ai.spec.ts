import { deliver, expect, openMailbox, row, test, toast } from "./fixtures";
import { FAKE_LLM_MODEL, FAKE_LLM_URL } from "./fake-llm";

// AI settings belong to the (single) dev user, so these tests share them and run in order.
test.describe.configure({ mode: "serial" });

test("set up the AI Assistant from the extensions menu", async ({ page, request, mailbox }) => {
	// Start from "off", with another provider, as a new user would.
	await request.put("/api/extensions/ai", { data: { enabled: false, provider: "workers-ai" } });
	await openMailbox(page, mailbox);
	await expect(page.getByRole("button", { name: "Ask your inbox" })).toBeHidden();

	await page.getByRole("button", { name: "Extensions" }).click();
	const tile = page.getByRole("button", { name: /AI Assistant/ });
	await expect(tile).toContainText("Off");
	await tile.click();

	const dialog = page.getByRole("dialog", { name: "AI Assistant" });
	await dialog.getByLabel("Provider").selectOption("openai-compatible");
	await dialog.getByLabel("Server URL").fill(FAKE_LLM_URL);
	await dialog.getByLabel("API key (optional)").fill("sk-e2e-not-a-real-key");
	await dialog.getByLabel("Model").fill(FAKE_LLM_MODEL);
	await dialog.getByRole("button", { name: "Test" }).click();
	await expect(toast(page, 'It works. OpenAI-compatible answered: "OK"')).toBeVisible();

	// The saved key is never shown again; the provider's models are listed.
	await expect(dialog.getByText("Saved key")).toBeVisible();
	await expect(dialog.getByText("2 models available")).toBeVisible();
	await dialog.getByRole("switch", { name: "Turn on AI Assistant" }).click();
	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(toast(page, "AI Assistant is on.")).toBeVisible();

	await page.getByRole("button", { name: "Extensions" }).click();
	await expect(page.getByRole("button", { name: /AI Assistant/ })).toContainText("On");
	await page.keyboard.press("Escape");
	await expect(page.getByRole("button", { name: "Ask your inbox" })).toBeVisible();
});

test.describe("with the AI Assistant on", () => {
	test.beforeEach(async ({ request }) => {
		const res = await request.put("/api/extensions/ai", {
			data: { enabled: true, provider: "openai-compatible", baseUrl: FAKE_LLM_URL, model: FAKE_LLM_MODEL, apiKey: "sk-e2e-not-a-real-key" },
		});
		expect(res.ok()).toBe(true);
	});

	test("summarise a conversation", async ({ page, request, mailbox }) => {
		await deliver(request, mailbox, { from: "Ann <ann@sender.test>", subject: "Q3 numbers", text: "Can you send the Q3 numbers by Friday?" });
		await openMailbox(page, mailbox);
		await row(page, "Q3 numbers").getByRole("link").click();
		await page.getByRole("button", { name: "Summarise" }).click();
		const summary = page.getByRole("region", { name: "Summary" });
		await expect(summary).toContainText("Ann needs the Q3 numbers by Friday.");
		await expect(summary).toContainText("Written by AI");
		await summary.getByRole("button", { name: "Close summary" }).click();
		await expect(summary).toBeHidden();
	});

	test("draft a reply, then rewrite part of it", async ({ page, request, mailbox }) => {
		await deliver(request, mailbox, { from: "Ann <ann@sender.test>", subject: "Meeting", text: "Does Thursday work?" });
		await openMailbox(page, mailbox);
		await row(page, "Meeting").getByRole("link").click();
		await page.getByRole("button", { name: "Reply", exact: true }).last().click();
		const reply = page.getByRole("dialog", { name: "Re: Meeting" });
		const body = reply.getByRole("textbox", { name: "Message body" });

		await reply.getByRole("button", { name: "Help me write" }).click();
		const assist = reply.getByRole("group", { name: "Help me write" });
		await assist.getByRole("textbox").fill("say Thursday works");
		await page.keyboard.press("Enter");
		await expect(assist).toContainText("Thursday works for me.");
		await assist.getByRole("button", { name: "Insert" }).click();
		await expect(assist).toBeHidden();
		await expect(body).toContainText("Thursday works for me. See you then.");

		// Select a paragraph and make it shorter.
		await body.getByText("Thursday works for me. See you then.").selectText();
		await reply.getByRole("button", { name: "Help me write" }).click();
		const rewrite = reply.getByRole("group", { name: "Rewrite with AI" });
		await rewrite.getByRole("button", { name: "Shorten" }).click();
		await expect(rewrite).toContainText("Thanks so much!");
		await rewrite.getByRole("button", { name: "Replace" }).click();
		await expect(body).toContainText("Thanks so much!");
		await expect(body).not.toContainText("See you then.");
		await expect(body).toContainText("Hi Ann,");
	});

	test("ask the inbox a question", async ({ page, request, mailbox }) => {
		await deliver(request, mailbox, { from: "Ops <ops@sender.test>", subject: "Invoice 42", text: "The invoice total is $1,234." });
		await deliver(request, mailbox, { from: "Bob <bob@sender.test>", subject: "Lunch", text: "Pizza?" });
		await openMailbox(page, mailbox);

		await page.getByRole("button", { name: "Ask your inbox" }).click();
		const panel = page.getByRole("dialog", { name: "Ask your inbox" });
		await panel.getByRole("textbox", { name: "Ask a question" }).fill("How much is the invoice?");
		await page.keyboard.press("Enter");
		await expect(panel).toContainText("The invoice total is $1,234, from Ops.");
		await expect(panel).toContainText("Searched invoice · 1 result");

		// The conversation it read links to the thread.
		await panel.getByRole("link", { name: "Invoice 42" }).click();
		await expect(panel).toBeHidden();
		await expect(page.getByRole("heading", { name: "Invoice 42" })).toBeVisible();
	});
});
