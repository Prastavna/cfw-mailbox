import { Hono } from "hono";
import { z } from "zod";
import type { Me, MailboxRole } from "../../shared/api";
import { domainOf, isValidAddress, isValidDomain } from "../../shared/address";
import { authenticate, type Identity } from "../auth/access";
import { HttpError } from "../lib/http";
import { getMailbox } from "../mailbox/MailboxDO";
import { getRegistry, type Result } from "../registry/RegistryDO";

type AppEnv = {
	Bindings: Env;
	Variables: { identity: Identity; role: MailboxRole };
};

const domainSchema = z.string().refine(isValidDomain, "Invalid domain");
const addressSchema = z.string().refine(isValidAddress, "Invalid email address");

const CreateMailboxBody = z.object({
	address: addressSchema,
	displayName: z.string().trim().min(1).max(100),
	ownerEmail: addressSchema.optional(),
});
const SetMemberBody = z.object({ email: addressSchema, role: z.enum(["owner", "member"]) });

async function parseBody<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
	const json = await req.json().catch(() => {
		throw new HttpError(400, "Body must be JSON");
	});
	const parsed = schema.safeParse(json);
	if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => i.message).join("; "));
	return parsed.data;
}

function unwrap<T>(result: Result<T>): T {
	if (result.ok) return result.value;
	throw new HttpError(result.code === "not_found" ? 404 : result.code === "conflict" ? 409 : 400, result.message);
}

export const api = new Hono<AppEnv>().basePath("/api");

api.onError((err, c) => {
	if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
	console.error(err);
	return c.json({ error: "Internal error" }, 500);
});
api.notFound((c) => c.json({ error: "Not found" }, 404));

api.get("/health", (c) => c.json({ ok: true }));

// Everything below requires a signed-in user.
api.use("*", async (c, next) => {
	c.set("identity", await authenticate(c.req.raw, c.env));
	await next();
});

api.get("/me", async (c) => {
	const { email, isAdmin } = c.get("identity");
	const mailboxes = await getRegistry(c.env).mailboxesFor(email, isAdmin);
	return c.json<Me>({ email, isAdmin, mailboxes });
});

// ---- Admin: domains, mailboxes, members ---------------------------------

const admin = new Hono<AppEnv>();
admin.use("*", async (c, next) => {
	if (!c.get("identity").isAdmin) throw new HttpError(403, "Admins only");
	await next();
});

admin.get("/domains", async (c) => c.json(await getRegistry(c.env).listDomains()));
admin.post("/domains", async (c) => {
	const { domain } = await parseBody(c.req.raw, z.object({ domain: domainSchema }));
	return c.json(unwrap(await getRegistry(c.env).addDomain(domain)), 201);
});
admin.delete("/domains/:domain", async (c) => {
	unwrap(await getRegistry(c.env).removeDomain(c.req.param("domain")));
	return c.body(null, 204);
});

admin.get("/mailboxes", async (c) => c.json(await getRegistry(c.env).listMailboxes()));
admin.post("/mailboxes", async (c) => {
	const body = await parseBody(c.req.raw, CreateMailboxBody);
	if (!domainOf(body.address)) throw new HttpError(400, "Invalid email address");
	return c.json(unwrap(await getRegistry(c.env).createMailbox(body)), 201);
});
admin.delete("/mailboxes/:id", async (c) => {
	// Removes the mailbox from the directory. Stored mail is purged by a later cleanup job.
	unwrap(await getRegistry(c.env).deleteMailbox(c.req.param("id")));
	return c.body(null, 204);
});

admin.get("/mailboxes/:id/members", async (c) => c.json(await getRegistry(c.env).listMembers(c.req.param("id"))));
admin.put("/mailboxes/:id/members", async (c) => {
	const { email, role } = await parseBody(c.req.raw, SetMemberBody);
	return c.json(unwrap(await getRegistry(c.env).setMember(c.req.param("id"), email, role)));
});
admin.delete("/mailboxes/:id/members/:email", async (c) => {
	unwrap(await getRegistry(c.env).removeMember(c.req.param("id"), c.req.param("email")));
	return c.body(null, 204);
});

api.route("/admin", admin);

// ---- Per-mailbox routes ---------------------------------------------------

const mailbox = new Hono<AppEnv>();
mailbox.use("*", async (c, next) => {
	const { email, isAdmin } = c.get("identity");
	const role = await getRegistry(c.env).roleFor(c.req.param("mailboxId")!, email, isAdmin);
	// 404 rather than 403, so mailbox IDs can't be probed.
	if (!role) throw new HttpError(404, "Mailbox not found");
	c.set("role", role);
	await next();
});

mailbox.get("/labels", async (c) => c.json(await getMailbox(c.env, c.req.param("mailboxId")!).listLabels()));

api.route("/mailboxes/:mailboxId", mailbox);
