import { test as base, expect, type APIRequestContext, type Page } from "@playwright/test";

export { expect };

export interface TestMailbox {
	id: string;
	address: string;
	domain: string;
}

export interface Mail {
	from?: string;
	subject: string;
	text?: string;
	html?: string;
	messageId?: string;
	inReplyTo?: string;
	date?: Date;
	attachments?: { filename: string; mimeType: string; content: Buffer; contentId?: string }[];
}

const CRLF = "\r\n";
let counter = 0;

/** A raw RFC 5322 message, like the ones Email Routing hands the Worker. */
export function rawMessage(to: string, mail: Mail): string {
	const id = mail.messageId ?? `e2e-${Date.now()}-${++counter}@sender.test`;
	const headers = [
		`From: ${mail.from ?? "Alice Sender <alice@sender.test>"}`,
		`To: ${to}`,
		`Subject: ${mail.subject}`,
		`Date: ${(mail.date ?? new Date()).toUTCString()}`,
		`Message-ID: <${id}>`,
		...(mail.inReplyTo ? [`In-Reply-To: <${mail.inReplyTo}>`, `References: <${mail.inReplyTo}>`] : []),
		"MIME-Version: 1.0",
	];
	const part = (type: string, body: string) => `Content-Type: ${type}; charset=utf-8${CRLF}Content-Transfer-Encoding: 8bit${CRLF}${CRLF}${body}`;
	const parts: string[] = [];
	if (mail.text !== undefined || mail.html === undefined) parts.push(part("text/plain", mail.text ?? ""));
	if (mail.html !== undefined) parts.push(part("text/html", mail.html));
	for (const a of mail.attachments ?? []) {
		parts.push(
			[
				`Content-Type: ${a.mimeType}; name="${a.filename}"`,
				`Content-Disposition: ${a.contentId ? "inline" : "attachment"}; filename="${a.filename}"`,
				...(a.contentId ? [`Content-ID: <${a.contentId}>`] : []),
				"Content-Transfer-Encoding: base64",
				"",
				(a.content.toString("base64").match(/.{1,76}/g) ?? []).join(CRLF),
			].join(CRLF),
		);
	}
	const boundary = `e2e-${++counter}`;
	return (
		`${headers.join(CRLF)}${CRLF}Content-Type: multipart/mixed; boundary="${boundary}"${CRLF}${CRLF}` +
		parts.map((p) => `--${boundary}${CRLF}${p}${CRLF}`).join("") +
		`--${boundary}--${CRLF}`
	);
}

export async function deliver(request: APIRequestContext, mailbox: TestMailbox, mail: Mail): Promise<void> {
	const from = (mail.from ?? "alice@sender.test").match(/<([^>]+)>/)?.[1] ?? mail.from ?? "alice@sender.test";
	const res = await request.post(`/cdn-cgi/handler/email?from=${encodeURIComponent(from)}&to=${encodeURIComponent(mailbox.address)}`, {
		data: rawMessage(mailbox.address, mail),
		headers: { "content-type": "message/rfc822" },
	});
	expect(res.ok(), `delivering "${mail.subject}": ${res.status()} ${await res.text()}`).toBe(true);
}

/**
 * Console errors that aren't the email sandbox doing its job: blocking remote content, and
 * refusing the scripts Playwright itself tries to run in sandboxed frames.
 */
function isUnexpected(text: string): boolean {
	return !/Content Security Policy|Blocked script execution in 'about:srcdoc'/.test(text);
}

export const test = base.extend<{ mailbox: TestMailbox; consoleErrors: string[] }>({
	mailbox: async ({ request, page }, use) => {
		const me = await (await request.get("/api/me")).json();
		if (!me.isAdmin) throw new Error(`The dev user (${me.email}) must be in ADMIN_EMAILS to create test mailboxes`);
		const domain = `e2e-${crypto.randomUUID().slice(0, 8)}.test`;
		expect((await request.post("/api/admin/domains", { data: { domain } })).status()).toBe(201);
		const res = await request.post("/api/admin/mailboxes", { data: { address: `erin@${domain}`, displayName: "Erin Example" } });
		expect(res.status()).toBe(201);
		const created = await res.json();
		// No undo-send window, so sends are immediate unless a test asks for one.
		await request.patch(`/api/mailboxes/${created.id}/settings`, { data: { undoSendSeconds: 0 } });
		await use({ id: created.id, address: created.address, domain });
		// Leave the app first, so it doesn't refetch a mailbox that's being deleted.
		await page.goto("about:blank");
		await request.delete(`/api/admin/mailboxes/${created.id}`);
		await request.delete(`/api/admin/domains/${domain}`);
	},
	consoleErrors: [
		async ({ page }, use) => {
			const errors: string[] = [];
			page.on("console", (m) => {
				if (m.type() !== "error" || !isUnexpected(m.text())) return;
				const url = m.location().url;
				errors.push(url && m.text().startsWith("Failed to load resource") ? `${m.text()}: ${url}` : m.text());
			});
			page.on("pageerror", (e) => errors.push(`Uncaught: ${e.message}`));
			await use(errors);
			expect(errors, "console errors").toEqual([]);
		},
		{ auto: true },
	],
});

export const row = (page: Page, subject: string | RegExp) => page.getByRole("listitem").filter({ hasText: subject });
export const toast = (page: Page, text: string | RegExp) => page.locator("[data-sonner-toast]").filter({ hasText: text });
export const sidebar = (page: Page) => page.getByRole("navigation", { name: "Folders" });

/** Opens a folder of the test mailbox once the app is ready. */
export async function openMailbox(page: Page, mailbox: TestMailbox, folder = "inbox") {
	await page.goto(`/mail/${mailbox.id}/${folder}`);
	await expect(page.getByRole("list").or(page.getByText(/is empty|No conversations/))).toBeVisible({ timeout: 30_000 });
}

/** Waits until new mail is pushed to the page. */
export async function waitForLive(page: Page) {
	await expect(page.getByRole("status", { name: /Live updates: live/ })).toBeAttached({ timeout: 20_000 });
}
