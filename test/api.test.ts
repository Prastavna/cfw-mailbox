import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Me, Mailbox } from "../shared/api";
import { authenticate } from "../workers/auth/access";
import { getMailbox } from "../workers/mailbox/MailboxDO";
import { getRegistry } from "../workers/registry/RegistryDO";

const BASE = "http://localhost";

function call(path: string, init?: RequestInit) {
	return exports.default.fetch(new Request(`${BASE}${path}`, init));
}

function post(path: string, body: unknown, method = "POST") {
	return call(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("health and auth", () => {
	it("serves /api/health without auth", async () => {
		const res = await call("/api/health");
		expect(res.status).toBe(200);
	});

	it("identifies the dev user as admin", async () => {
		const res = await call("/api/me");
		expect(res.status).toBe(200);
		const me = await res.json<Me>();
		expect(me).toMatchObject({ email: "admin@example.test", isAdmin: true, mailboxes: [] });
	});

	it("refuses dev auth on a non-local host", async () => {
		const req = new Request("https://mail.example.com/api/me");
		await expect(authenticate(req, env)).rejects.toThrow(/only allowed on localhost/);
	});

	it("requires an Access token in access mode", async () => {
		const accessEnv = { ...env, AUTH_MODE: "access", ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "aud" };
		await expect(authenticate(new Request(`${BASE}/api/me`), accessEnv)).rejects.toThrow(/Missing Cloudflare Access token/);
	});

	it("fails closed when Access isn't configured", async () => {
		const accessEnv = { ...env, AUTH_MODE: "access", ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" };
		await expect(authenticate(new Request(`${BASE}/api/me`), accessEnv)).rejects.toThrow(/not configured/);
	});

	it("rejects a forged Access token", async () => {
		const accessEnv = { ...env, AUTH_MODE: "access", ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "aud" };
		const req = new Request(`${BASE}/api/me`, { headers: { "Cf-Access-Jwt-Assertion": "not.a.jwt" } });
		await expect(authenticate(req, accessEnv)).rejects.toThrow(/Invalid or expired/);
	});
});

describe("admin: domains and mailboxes", () => {
	it("creates a domain, a mailbox and lists it for the owner", async () => {
		expect((await post("/api/admin/domains", { domain: "Example.COM" })).status).toBe(201);
		expect((await post("/api/admin/domains", { domain: "example.com" })).status).toBe(409);

		const res = await post("/api/admin/mailboxes", {
			address: "Hello@Example.com",
			displayName: "Hello",
			ownerEmail: "someone@elsewhere.test",
		});
		expect(res.status).toBe(201);
		const mailbox = await res.json<Mailbox>();
		expect(mailbox).toMatchObject({ address: "hello@example.com", domain: "example.com" });

		const registry = getRegistry(env);
		expect(await registry.mailboxesFor("someone@elsewhere.test", false)).toEqual([{ ...mailbox, role: "owner" }]);
		expect(await registry.mailboxesFor("stranger@elsewhere.test", false)).toEqual([]);
		expect((await registry.resolveAddress("HELLO@example.com"))?.id).toBe(mailbox.id);

		// A domain with mailboxes can't be removed.
		expect((await call("/api/admin/domains/example.com", { method: "DELETE" })).status).toBe(409);
	});

	it("refuses mailboxes on unknown domains and bad input", async () => {
		expect((await post("/api/admin/mailboxes", { address: "a@nowhere.test", displayName: "A" })).status).toBe(400);
		expect((await post("/api/admin/mailboxes", { address: "not-an-address", displayName: "A" })).status).toBe(400);
		expect((await post("/api/admin/domains", { domain: "bad domain" })).status).toBe(400);
	});

	it("manages members and enforces per-mailbox access", async () => {
		await post("/api/admin/domains", { domain: "team.test" });
		const mailbox = await (await post("/api/admin/mailboxes", { address: "ops@team.test", displayName: "Ops" })).json<Mailbox>();

		expect((await post(`/api/admin/mailboxes/${mailbox.id}/members`, { email: "Bob@team.test", role: "member" }, "PUT")).status).toBe(200);
		const registry = getRegistry(env);
		expect(await registry.roleFor(mailbox.id, "bob@team.test", false)).toBe("member");
		expect(await registry.roleFor(mailbox.id, "eve@team.test", false)).toBeNull();

		expect((await call(`/api/admin/mailboxes/${mailbox.id}/members/bob@team.test`, { method: "DELETE" })).status).toBe(204);
		expect(await registry.roleFor(mailbox.id, "bob@team.test", false)).toBeNull();
	});
});

describe("mailbox storage", () => {
	it("seeds Gmail-style system labels", async () => {
		const ids = (await getMailbox(env, crypto.randomUUID()).listLabels()).map((l) => l.id);
		expect(ids).toEqual(expect.arrayContaining(["INBOX", "SENT", "DRAFT", "SPAM", "TRASH", "STARRED", "IMPORTANT", "UNREAD"]));
	});

	it("hides mailboxes the user can't access", async () => {
		expect((await call(`/api/mailboxes/${crypto.randomUUID()}/labels`)).status).toBe(404);
	});
});
