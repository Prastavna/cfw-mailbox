import type { UIMessage } from "ai";
import type { Me } from "../../shared/api";
import { EXTENSIONS, type ExtensionInfo } from "../../shared/extensions";
import * as ai from "./ai";
import { blobToDataUrl } from "./files";
import { HttpError } from "./store";
import type { DemoWorld } from "./world";

/**
 * The fake backend: answers the same routes as workers/api, from memory.
 * `path` is relative to the API base, e.g. "/mailboxes/abc/threads".
 */

type Handler = (ctx: { params: string[]; url: URL; request: Request; body: () => Promise<any> }) => unknown;

const json = (data: unknown, status = 200) =>
	data === undefined ? new Response(null, { status: 204 }) : new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export function createDemoServer(world: DemoWorld) {
	const routes: [method: string, pattern: RegExp, handler: Handler, status?: number][] = [];
	const on = (method: string, path: string, handler: Handler, status?: number) =>
		routes.push([method, new RegExp(`^${path.replace(/:\w+/g, "([^/]+)")}$`), handler, status]);
	const mb = (id: string | undefined) => world.mailbox(id!);

	on("GET", "/health", () => ({ ok: true }));
	on("GET", "/me", (): Me => ({ email: world.user.email, isAdmin: true, mailboxes: world.accessible() }));

	// Admin
	on("GET", "/admin/domains", () => world.domains);
	on("POST", "/admin/domains", async ({ body }) => world.addDomain((await body()).domain), 201);
	on("DELETE", "/admin/domains/:d", ({ params }) => void world.removeDomain(decodeURIComponent(params[0]!)));
	on("GET", "/admin/mailboxes", () => world.accessible().map(({ role: _, ...m }) => m));
	on("POST", "/admin/mailboxes", async ({ body }) => world.createMailbox(await body()), 201);
	on("DELETE", "/admin/mailboxes/:id", ({ params }) => void world.deleteMailbox(params[0]!));
	on("GET", "/admin/mailboxes/:id/members", ({ params }) => world.listMembers(params[0]!));
	on("PUT", "/admin/mailboxes/:id/members", async ({ params, body }) => {
		const { email, role } = await body();
		return world.setMember(params[0]!, email, role);
	});
	on("DELETE", "/admin/mailboxes/:id/members/:email", ({ params }) => void world.removeMember(params[0]!, decodeURIComponent(params[1]!)));

	// Extensions
	on("GET", "/extensions", (): ExtensionInfo[] => [{ id: "ai", ...EXTENSIONS.ai, enabled: world.ai.enabled, ready: world.isReady }]);
	on("GET", "/extensions/ai", () => world.ai);
	on("PUT", "/extensions/ai", async ({ body }) => {
		const { apiKey, ...rest } = await body();
		world.ai = { ...world.ai, ...rest };
		if (apiKey === null) Object.assign(world.ai, { hasKey: false, keyHint: null });
		else if (typeof apiKey === "string" && apiKey) Object.assign(world.ai, { hasKey: true, keyHint: apiKey.slice(-4) });
		return world.ai;
	});
	on("GET", "/extensions/ai/models", () => [
		{ id: world.ai.model || "demo-model", name: `${world.ai.model || "demo-model"} (demo)` },
		{ id: "demo-model-large", name: "demo-model-large (demo)" },
	]);
	on("POST", "/extensions/ai/test", () => ({ ok: true, reply: "OK" }));
	on("POST", "/extensions/ai/rewrite", async ({ body }) => ai.textStream(ai.rewrite(await body())));

	// Mailbox: reading and organising
	on("GET", "/mailboxes/:id/labels", ({ params }) => mb(params[0]).listLabels());
	on("POST", "/mailboxes/:id/labels", async ({ params, body }) => {
		const { name, color } = await body();
		return mb(params[0]).createLabel(String(name).trim(), color ?? null);
	}, 201);
	on("PATCH", "/mailboxes/:id/labels/:label", async ({ params, body }) => void mb(params[0]).updateLabel(params[1]!, await body()));
	on("DELETE", "/mailboxes/:id/labels/:label", ({ params }) => void mb(params[0]).deleteLabel(params[1]!));
	on("POST", "/mailboxes/:id/threads/modify", async ({ params, body }) => {
		const b = await body();
		return mb(params[0]).modifyThreads(b.threadIds, b.addLabelIds, b.removeLabelIds);
	});
	on("POST", "/mailboxes/:id/messages/modify", async ({ params, body }) => mb(params[0]).modifyMessages((await body()).changes));
	on("POST", "/mailboxes/:id/threads/delete", async ({ params, body }) => mb(params[0]).deleteThreads((await body()).threadIds));
	on("GET", "/mailboxes/:id/threads", ({ params, url }) => {
		const q = url.searchParams;
		const limit = Math.min(100, Number(q.get("limit") ?? 50));
		const cursor = q.get("cursor") ?? undefined;
		if (q.has("q")) return mb(params[0]).search(q.get("q")!, cursor, limit, Number(q.get("tz") ?? 0));
		return mb(params[0]).listThreads(q.get("label") ?? "INBOX", cursor, limit);
	});
	on("GET", "/mailboxes/:id/threads/:thread", ({ params }) => {
		const t = mb(params[0]).getThread(params[1]!);
		if (!t) throw new HttpError(404, "Thread not found");
		return t;
	});
	on("POST", "/mailboxes/:id/threads/snooze", async ({ params, body }) => {
		const b = await body();
		return mb(params[0]).snoozeThreads(b.threadIds, b.until);
	});
	on("POST", "/mailboxes/:id/threads/unsnooze", async ({ params, body }) => mb(params[0]).unsnoozeThreads((await body()).threadIds));
	on("GET", "/mailboxes/:id/contacts", ({ params, url }) => mb(params[0]).listContacts(url.searchParams.get("q") ?? "", Number(url.searchParams.get("limit") ?? 8)));
	on("GET", "/mailboxes/:id/filters", ({ params }) => mb(params[0]).filters);
	on("POST", "/mailboxes/:id/filters", async ({ params, body }) => {
		const b = await body();
		return mb(params[0]).createFilter(b.query, b.actions, !!b.applyToExisting);
	}, 201);
	on("DELETE", "/mailboxes/:id/filters/:filter", ({ params }) => void mb(params[0]).deleteFilter(params[1]!));
	on("GET", "/mailboxes/:id/settings", ({ params }) => mb(params[0]).settings);
	on("PATCH", "/mailboxes/:id/settings", async ({ params, body }) => mb(params[0]).updateSettings(await body()));
	on("GET", "/mailboxes/:id/usage", ({ params }) => mb(params[0]).usage());

	// Mailbox: writing
	on("POST", "/mailboxes/:id/drafts", async ({ params, body }) => mb(params[0]).createDraft(await body()), 201);
	on("GET", "/mailboxes/:id/drafts/:draft", ({ params }) => {
		const d = mb(params[0]).getDraft(params[1]!);
		if (!d) throw new HttpError(404, "Draft not found");
		return d;
	});
	on("PUT", "/mailboxes/:id/drafts/:draft", async ({ params, body }) => mb(params[0]).updateDraft(params[1]!, await body()));
	on("DELETE", "/mailboxes/:id/drafts/:draft", ({ params }) => void mb(params[0]).discardDraft(params[1]!));
	on("POST", "/mailboxes/:id/drafts/:draft/attachments", async ({ params, url, request }) => {
		const filename = (url.searchParams.get("filename") ?? "").trim();
		if (!filename) throw new HttpError(400, "filename is required");
		const blob = await request.blob();
		if (blob.size > 25 * 1024 * 1024) throw new HttpError(413, "Attachments can be at most 25 MB");
		const mimeType = request.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
		return mb(params[0]).addDraftAttachment(params[1]!, { filename, mimeType, dataUrl: await blobToDataUrl(blob) });
	}, 201);
	on("DELETE", "/mailboxes/:id/drafts/:draft/attachments/:att", ({ params }) => void mb(params[0]).removeDraftAttachment(params[1]!, params[2]!));
	on("POST", "/mailboxes/:id/drafts/:draft/send", ({ params }) => mb(params[0]).sendDraft(params[1]!));
	on("POST", "/mailboxes/:id/drafts/:draft/cancel-send", ({ params }) => mb(params[0]).cancelSend(params[1]!));

	// Mailbox: AI Assistant
	const requireAi = () => {
		if (!world.ai.enabled) throw new HttpError(403, "Turn on the AI Assistant first");
	};
	on("POST", "/mailboxes/:id/ai/summarize", async ({ params, body }) => {
		requireAi();
		const box = mb(params[0]);
		const { threadId } = await body();
		const thread = box.getThread(threadId);
		if (!thread) throw new HttpError(404, "Thread not found");
		return ai.textStream(ai.summarize(thread, box.address, world.summaries.get(threadId)));
	});
	on("POST", "/mailboxes/:id/ai/write", async ({ params, body }) => {
		requireAi();
		const box = mb(params[0]);
		const req = await body();
		const parent = req.parentMessageId ? box.messages.get(req.parentMessageId) : undefined;
		return ai.textStream(ai.write(req, box, parent));
	});
	on("POST", "/mailboxes/:id/ai/chat", async ({ params, body }) => {
		requireAi();
		const { messages } = (await body()) as { messages: UIMessage[] };
		return ai.chat(messages, mb(params[0]));
	});

	return async function handle(path: string, request: Request): Promise<Response> {
		const url = new URL(request.url);
		const method = request.method.toUpperCase();
		try {
			for (const [m, pattern, handler, status] of routes) {
				const match = m === method && pattern.exec(path);
				if (!match) continue;
				const result = await handler({ params: match.slice(1), url, request, body: () => request.json() });
				// Small, varied latency, so loading states look real.
				await new Promise((r) => setTimeout(r, 60 + Math.random() * 120));
				return result instanceof Response ? result : json(result, status);
			}
			return json({ error: "Not found" }, 404);
		} catch (err) {
			if (err instanceof HttpError) return json({ error: err.message }, err.status);
			console.error("[demo]", err);
			return json({ error: "Internal error" }, 500);
		}
	};
}
