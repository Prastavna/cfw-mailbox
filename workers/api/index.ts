import { type Context, Hono } from "hono";
import { z } from "zod";
import {
	type Contact,
	type DraftDetail,
	type MailFilter,
	type Label,
	type MailboxRole,
	type MailboxSettings,
	type Me,
	type ModifyResult,
	SEND_LIMITS,
	type SendResult,
	type ThreadDetail,
	type ThreadPage,
	UNDO_SEND_CHOICES,
} from "../../shared/api";
import { domainOf, isValidAddress, isValidDomain } from "../../shared/address";
import { authenticate, type Identity } from "../auth/access";
import { HttpError } from "../lib/http";
import { MAX_QUERY_LENGTH } from "../../shared/search";
import { messageKeys } from "../mailbox/keys";
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
const ListThreadsQuery = z.object({
	label: z.string().min(1).max(100).default("INBOX"),
	/** A Gmail-style search; when present, `label` is ignored. */
	q: z.string().max(MAX_QUERY_LENGTH).optional(),
	/** The browser's Date#getTimezoneOffset(), for date operators. */
	tz: z.coerce.number().int().min(-1000).max(1000).default(0),
	cursor: z.string().max(200).optional(),
	limit: z.coerce.number().int().min(1).max(100).default(50),
});

const Id = z.string().min(1).max(100);
const LabelIds = z.array(Id).max(20).default([]);
const ModifyThreadsBody = z.object({
	threadIds: z.array(Id).min(1).max(500),
	addLabelIds: LabelIds,
	removeLabelIds: LabelIds,
});
const ModifyMessagesBody = z.object({
	changes: z
		.array(z.object({ messageId: Id, addLabelIds: LabelIds, removeLabelIds: LabelIds }))
		.min(1)
		.max(10_000),
});
const DeleteThreadsBody = z.object({ threadIds: z.array(Id).min(1).max(500) });
const LabelName = z
	.string()
	.trim()
	.min(1, "Label name is required")
	.max(100, "Label names can be at most 100 characters")
	.refine((n) => !/[\u0000-\u001f]/.test(n), "Label name contains invalid characters");
const LabelColor = z
	.string()
	.regex(/^#[0-9a-f]{6}$/i, "Colour must look like #1a73e8")
	.nullable();
const CreateLabelBody = z.object({ name: LabelName, color: LabelColor.default(null) });
const UpdateLabelBody = z
	.object({ name: LabelName.optional(), color: LabelColor.optional() })
	.refine((b) => b.name !== undefined || b.color !== undefined, "Nothing to update");

const Recipient = z.object({
	name: z
		.string()
		.max(200)
		.transform((n) => n.replace(/[\r\n"<>]+/g, " ").trim())
		.default(""),
	address: addressSchema,
});
const Recipients = z.array(Recipient).max(SEND_LIMITS.recipients).default([]);
/** Keeps a draft row well under the 2 MB SQLite row limit (HTML plus its text version). */
const MAX_DRAFT_HTML = 300_000;
const DraftFieldsBody = z.object({
	to: Recipients,
	cc: Recipients,
	bcc: Recipients,
	subject: z.string().max(SEND_LIMITS.subjectChars).default(""),
	html: z.string().max(MAX_DRAFT_HTML, "The message is too long").default(""),
});
const CreateDraftBody = DraftFieldsBody.extend({
	parent: z.object({ messageId: Id, kind: z.enum(["reply", "forward"]) }).optional(),
});
const Timestamp = z.number().int().min(0).max(8.64e15);
const VacationBody = z
	.object({
		enabled: z.boolean(),
		subject: z.string().max(SEND_LIMITS.subjectChars),
		message: z.string().max(20_000),
		startAt: Timestamp.nullable(),
		endAt: Timestamp.nullable(),
		contactsOnly: z.boolean(),
	})
	.refine((v) => !v.enabled || v.message.trim().length > 0, "Write a message for the vacation reply")
	.refine((v) => v.startAt === null || v.endAt === null || v.startAt <= v.endAt, "The last day is before the first day");
const SettingsBody = z.object({
	signature: z.string().max(10_000).optional(),
	vacation: VacationBody.optional(),
	undoSendSeconds: z
		.number()
		.int()
		.refine((n) => (UNDO_SEND_CHOICES as readonly number[]).includes(n), "Unsupported undo-send delay")
		.optional(),
});
const SnoozeBody = z.object({
	threadIds: z.array(Id).min(1).max(500),
	until: Timestamp,
});
const ThreadIdsBody = z.object({ threadIds: z.array(Id).min(1).max(500) });
const FilterBody = z.object({
	query: z.string().trim().min(1, "A filter needs search criteria").max(MAX_QUERY_LENGTH),
	actions: z.object({
		archive: z.boolean().default(false),
		markRead: z.boolean().default(false),
		star: z.boolean().default(false),
		important: z.boolean().default(false),
		trash: z.boolean().default(false),
		labelId: Id.nullable().default(null),
	}),
	applyToExisting: z.boolean().default(false),
});
const ContactsQuery = z.object({
	q: z.string().max(200).default(""),
	limit: z.coerce.number().int().min(1).max(20).default(8),
});

/** Uploads are read into memory; Email Service caps the whole message at 25 MiB anyway. */
const MAX_UPLOAD_BYTES = SEND_LIMITS.messageBytes;

/** Mail content is attacker-controlled: never let the browser sniff or run it on our origin. */
const UNTRUSTED_CONTENT_HEADERS = {
	"X-Content-Type-Options": "nosniff",
	"Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
	"Cache-Control": "private, max-age=3600",
};
const SAFE_INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/avif"]);

function contentDisposition(type: "inline" | "attachment", filename: string): string {
	const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
	const encoded = encodeURIComponent(filename).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
	return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

async function parseBody<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
	// Requiring JSON forces a CORS preflight for cross-site requests, which blocks form-based CSRF.
	if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
		throw new HttpError(415, "Content-Type must be application/json");
	}
	const json = await req.json().catch(() => {
		throw new HttpError(400, "Body must be JSON");
	});
	const parsed = schema.safeParse(json);
	if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => i.message).join("; "));
	return parsed.data;
}

function unwrap<T>(result: Result<T>): T {
	if (result.ok) return result.value;
	const status = { not_found: 404, conflict: 409, invalid: 400, too_large: 413, rejected: 422, unavailable: 503 } as const;
	throw new HttpError(status[result.code], result.message);
}

export const api = new Hono<AppEnv>().basePath("/api");

api.onError((err, c) => {
	if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
	console.error(err);
	return c.json({ error: "Internal error" }, 500);
});
api.notFound((c) => c.json({ error: "Not found" }, 404));

api.get("/health", (c) => c.json({ ok: true }));

// The UI is served from this same origin, so a browser request from anywhere
// else that changes state (or opens a WebSocket) is cross-site and refused.
api.use("*", async (c, next) => {
	const origin = c.req.header("Origin");
	const unsafe = c.req.method !== "GET" && c.req.method !== "HEAD";
	const websocket = c.req.header("Upgrade")?.toLowerCase() === "websocket";
	if (origin && (unsafe || websocket) && origin !== new URL(c.req.url).origin) {
		throw new HttpError(403, "Cross-origin request refused");
	}
	await next();
});

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

const mailboxStub = (c: Context<AppEnv>) => getMailbox(c.env, c.req.param("mailboxId")!);

mailbox.get("/labels", async (c) => c.json(await mailboxStub(c).listLabels()));

mailbox.post("/labels", async (c) => {
	const { name, color } = await parseBody(c.req.raw, CreateLabelBody);
	return c.json<Label>(unwrap(await mailboxStub(c).createLabel(name, color)), 201);
});
mailbox.patch("/labels/:labelId", async (c) => {
	unwrap(await mailboxStub(c).updateLabel(c.req.param("labelId"), await parseBody(c.req.raw, UpdateLabelBody)));
	return c.body(null, 204);
});
mailbox.delete("/labels/:labelId", async (c) => {
	unwrap(await mailboxStub(c).deleteLabel(c.req.param("labelId")));
	return c.body(null, 204);
});

mailbox.post("/threads/modify", async (c) => {
	const body = await parseBody(c.req.raw, ModifyThreadsBody);
	return c.json<ModifyResult>(unwrap(await mailboxStub(c).modifyThreads(body.threadIds, body.addLabelIds, body.removeLabelIds)));
});
mailbox.post("/messages/modify", async (c) => {
	const { changes } = await parseBody(c.req.raw, ModifyMessagesBody);
	return c.json<ModifyResult>(unwrap(await mailboxStub(c).modifyMessages(changes)));
});
mailbox.post("/threads/delete", async (c) => {
	const { threadIds } = await parseBody(c.req.raw, DeleteThreadsBody);
	return c.json(unwrap(await mailboxStub(c).deleteThreads(threadIds)));
});

mailbox.get("/threads", async (c) => {
	const q = ListThreadsQuery.safeParse(c.req.query());
	if (!q.success) throw new HttpError(400, q.error.issues.map((i) => i.message).join("; "));
	const { label, q: query, tz, cursor, limit } = q.data;
	if (query !== undefined) {
		return c.json<ThreadPage>(unwrap(await mailboxStub(c).search({ query, cursor, limit, tzOffsetMinutes: tz })));
	}
	return c.json<ThreadPage>(await mailboxStub(c).listThreads({ labelId: label, cursor, limit }));
});

mailbox.get("/threads/:threadId", async (c) => {
	const thread = await mailboxStub(c).getThread(c.req.param("threadId"));
	if (!thread) throw new HttpError(404, "Thread not found");
	return c.json<ThreadDetail>(thread);
});

mailbox.get("/messages/:messageId/attachments/:attachmentId", async (c) => {
	const meta = await mailboxStub(c).getAttachment(c.req.param("messageId"), c.req.param("attachmentId"));
	const object = meta && (await c.env.BUCKET.get(meta.r2Key));
	if (!meta || !object) throw new HttpError(404, "Attachment not found");
	// Only images may render in the page (for inline cid: images); everything else downloads.
	const inline = c.req.query("inline") === "1" && SAFE_INLINE_TYPES.has(meta.mimeType);
	return new Response(object.body, {
		headers: {
			"Content-Type": inline ? meta.mimeType : "application/octet-stream",
			"Content-Length": String(object.size),
			"Content-Disposition": contentDisposition(inline ? "inline" : "attachment", meta.filename),
			...UNTRUSTED_CONTENT_HEADERS,
		},
	});
});

mailbox.get("/messages/:messageId/raw", async (c) => {
	const key = await mailboxStub(c).getRawKey(c.req.param("messageId"));
	const object = key && (await c.env.BUCKET.get(key));
	if (!object) throw new HttpError(404, "Message not found");
	return new Response(object.body, {
		headers: { "Content-Type": "text/plain; charset=utf-8", ...UNTRUSTED_CONTENT_HEADERS },
	});
});

// ---- Organising: snooze, contacts, filters ----------------------------------

mailbox.post("/threads/snooze", async (c) => {
	const { threadIds, until } = await parseBody(c.req.raw, SnoozeBody);
	return c.json(unwrap(await mailboxStub(c).snoozeThreads(threadIds, until)));
});
mailbox.post("/threads/unsnooze", async (c) => {
	const { threadIds } = await parseBody(c.req.raw, ThreadIdsBody);
	return c.json(unwrap(await mailboxStub(c).unsnoozeThreads(threadIds)));
});

mailbox.get("/contacts", async (c) => {
	const q = ContactsQuery.safeParse(c.req.query());
	if (!q.success) throw new HttpError(400, q.error.issues.map((i) => i.message).join("; "));
	const entry = await getRegistry(c.env).getMailbox(c.req.param("mailboxId")!);
	return c.json<Contact[]>(await mailboxStub(c).listContacts(q.data.q, q.data.limit, entry ? [entry.address] : []));
});

mailbox.get("/filters", async (c) => c.json<MailFilter[]>(await mailboxStub(c).listFilters()));
mailbox.post("/filters", async (c) => {
	const { query, actions, applyToExisting } = await parseBody(c.req.raw, FilterBody);
	return c.json(unwrap(await mailboxStub(c).createFilter(query, actions, applyToExisting)), 201);
});
mailbox.delete("/filters/:filterId", async (c) => {
	unwrap(await mailboxStub(c).deleteFilter(c.req.param("filterId")));
	return c.body(null, 204);
});

// ---- Writing: drafts, attachments, sending ---------------------------------

mailbox.get("/settings", async (c) => c.json<MailboxSettings>(await mailboxStub(c).getSettings()));
mailbox.patch("/settings", async (c) => {
	return c.json<MailboxSettings>(await mailboxStub(c).updateSettings(await parseBody(c.req.raw, SettingsBody)));
});

mailbox.post("/drafts", async (c) => {
	const request = await parseBody(c.req.raw, CreateDraftBody);
	const mailboxId = c.req.param("mailboxId")!;
	const entry = await getRegistry(c.env).getMailbox(mailboxId);
	if (!entry) throw new HttpError(404, "Mailbox not found");
	const sender = { name: entry.displayName, address: entry.address };
	return c.json<DraftDetail>(unwrap(await mailboxStub(c).createDraft({ mailboxId, sender, request })), 201);
});
mailbox.get("/drafts/:draftId", async (c) => {
	const draft = await mailboxStub(c).getDraft(c.req.param("draftId"));
	if (!draft) throw new HttpError(404, "Draft not found");
	return c.json<DraftDetail>(draft);
});
mailbox.put("/drafts/:draftId", async (c) => {
	const fields = await parseBody(c.req.raw, DraftFieldsBody);
	return c.json<DraftDetail>(unwrap(await mailboxStub(c).updateDraft(c.req.param("draftId"), fields)));
});
mailbox.delete("/drafts/:draftId", async (c) => {
	unwrap(await mailboxStub(c).discardDraft(c.req.param("draftId")));
	return c.body(null, 204);
});

// The file is the raw request body; its name comes in the query string.
mailbox.post("/drafts/:draftId/attachments", async (c) => {
	const filename = (c.req.query("filename") ?? "").replace(/[\u0000-\u001f/\\]+/g, "_").trim().slice(0, 255);
	if (!filename) throw new HttpError(400, "filename is required");
	const declared = Number(c.req.header("content-length") ?? NaN);
	if (declared > MAX_UPLOAD_BYTES) throw new HttpError(413, "Attachments can be at most 25 MB");
	const body = await c.req.arrayBuffer();
	if (body.byteLength > MAX_UPLOAD_BYTES) throw new HttpError(413, "Attachments can be at most 25 MB");
	const mimeType = /^[\w.+-]+\/[\w.+-]+$/.test(c.req.header("content-type")?.split(";")[0]?.trim() ?? "")
		? c.req.header("content-type")!.split(";")[0]!.trim().toLowerCase()
		: "application/octet-stream";

	const stub = mailboxStub(c);
	const draftId = c.req.param("draftId");
	if (!(await stub.getDraft(draftId))) throw new HttpError(404, "Draft not found");
	const id = crypto.randomUUID();
	const r2Key = messageKeys(c.req.param("mailboxId")!, draftId).attachment(id);
	await c.env.BUCKET.put(r2Key, body, { httpMetadata: { contentType: mimeType } });
	const result = await stub.addDraftAttachment(draftId, {
		id,
		filename,
		mimeType,
		size: body.byteLength,
		contentId: null,
		disposition: "attachment",
		r2Key,
	});
	if (!result.ok) await c.env.BUCKET.delete(r2Key);
	return c.json(unwrap(result), 201);
});
mailbox.delete("/drafts/:draftId/attachments/:attachmentId", async (c) => {
	unwrap(await mailboxStub(c).removeDraftAttachment(c.req.param("draftId"), c.req.param("attachmentId")));
	return c.body(null, 204);
});

mailbox.post("/drafts/:draftId/send", async (c) => {
	return c.json<SendResult>(unwrap(await mailboxStub(c).sendDraft(c.req.param("draftId"))));
});
mailbox.post("/drafts/:draftId/cancel-send", async (c) => {
	return c.json<DraftDetail>(unwrap(await mailboxStub(c).cancelSend(c.req.param("draftId"))));
});

// Live updates: the mailbox Durable Object accepts the WebSocket and pushes MailboxEvents.
mailbox.get("/events", async (c) => {
	if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") throw new HttpError(426, "Expected a WebSocket upgrade");
	return mailboxStub(c).fetch(c.req.raw);
});

api.route("/mailboxes/:mailboxId", mailbox);
