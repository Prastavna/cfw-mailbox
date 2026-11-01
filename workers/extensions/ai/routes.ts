import {
	APICallError,
	convertToModelMessages,
	createUIMessageStreamResponse,
	generateText,
	isStepCount,
	type LanguageModel,
	streamText,
	toUIMessageStream,
	tool,
	type UIMessage,
} from "ai";
import { Hono } from "hono";
import { z } from "zod";
import { MAX_QUERY_LENGTH } from "../../../shared/search";
import {
	AI_LIMITS,
	AI_PROVIDER_IDS,
	type AiModelOption,
	type AiSettings,
	type AiThreadHit,
	EXTENSIONS,
	type ExtensionInfo,
	REWRITE_MODES,
	type RewriteMode,
} from "../../../shared/extensions";
import { type AppContext, type AppEnv, parseBody, rateLimit } from "../../api/common";
import { HttpError } from "../../lib/http";
import { getMailbox } from "../../mailbox/MailboxDO";
import { getRegistry } from "../../registry/RegistryDO";
import { type AiConfig, aiModels, listModels, providerName } from "./models";
import { chatInstructions, formatThread, rewritePrompt, summarizePrompt, writePrompt } from "./prompts";
import { getAiSettings, isReady, requireAiConfig, saveAiSettings } from "./settings";

const SettingsBody = z.object({
	enabled: z.boolean().optional(),
	provider: z.enum(AI_PROVIDER_IDS as [string, ...string[]]).optional() as z.ZodOptional<z.ZodType<AiSettings["provider"]>>,
	model: z.string().max(200).optional(),
	baseUrl: z.string().max(500).nullable().optional(),
	apiKey: z
		.string()
		.trim()
		.min(1, "The API key is empty")
		.max(1000)
		.refine((k) => !/\s/.test(k), "API keys don't contain spaces")
		.nullable()
		.optional(),
});
const Instructions = z.string().trim().min(1, "Say what you'd like").max(AI_LIMITS.instructionsChars);
const RewriteBody = z
	.object({
		text: z.string().trim().min(1, "Select some text first").max(AI_LIMITS.rewriteChars, "That's too much text to rewrite at once"),
		mode: z.enum(Object.keys(REWRITE_MODES) as [RewriteMode, ...RewriteMode[]]).optional(),
		instructions: Instructions.optional(),
	})
	.refine((b) => b.mode || b.instructions, "Choose how to rewrite the text");
const SummarizeBody = z.object({ threadId: z.string().min(1).max(100) });
const WriteBody = z.object({
	instructions: Instructions,
	parentMessageId: z.string().min(1).max(100).optional(),
	subject: z.string().max(1000).optional(),
	to: z.array(z.string().max(320)).max(50).optional(),
	current: z.string().max(AI_LIMITS.rewriteChars).optional(),
});
const ChatBody = z.object({
	messages: z.array(z.custom<UIMessage>((m) => typeof m === "object" && m !== null && "role" in m && "parts" in m)).min(1).max(AI_LIMITS.chatMessages, "This chat is too long. Start a new one."),
	tz: z.number().int().min(-1000).max(1000).default(0),
});

const aiBudget = (c: AppContext) => rateLimit(c.env.AI_LIMITER, c.get("identity").email);

/** Turns a provider failure into something a person can act on. */
export function describeAiError(err: unknown, config: AiConfig): HttpError {
	const name = providerName(config.provider);
	if (err instanceof HttpError) return err;
	if (APICallError.isInstance(err)) {
		const status = err.statusCode ?? 0;
		if (status === 401 || status === 403) return new HttpError(502, `${name} didn't accept your API key. Check it in AI Assistant settings.`);
		if (status === 404) return new HttpError(502, `${name} doesn't know the model "${config.model}". Choose another in AI Assistant settings.`);
		if (status === 429) return new HttpError(502, `${name} is rate limiting your key, or it's out of credit. Try again later.`);
		if (status === 400) return new HttpError(502, `${name} refused the request: ${providerMessage(err) ?? err.message}`);
		if (status >= 500) return new HttpError(502, `${name} is having problems (HTTP ${status}). Try again later.`);
		return new HttpError(502, `${name}: ${providerMessage(err) ?? err.message}`);
	}
	const message = err instanceof Error ? err.message : String(err);
	if (/fetch|network|connect|ENOTFOUND|timed? ?out/i.test(message)) return new HttpError(502, `Couldn't reach ${name}.`);
	console.error("AI request failed", err);
	return new HttpError(502, `${name} request failed: ${message.slice(0, 300)}`);
}

function providerMessage(err: APICallError): string | null {
	try {
		const body = JSON.parse(err.responseBody ?? "") as { error?: { message?: string } | string; message?: string };
		const msg = typeof body.error === "string" ? body.error : (body.error?.message ?? body.message);
		return msg ? msg.slice(0, 300) : null;
	} catch {
		return null;
	}
}

/**
 * Streams the model's text as plain text. Waits for the first words before answering, so a
 * bad key or unknown model comes back as a proper error status instead of an empty 200.
 */
async function textResponse(result: { stream: AsyncIterable<{ type: string; text?: string; error?: unknown }> }, config: AiConfig): Promise<Response> {
	const parts = result.stream[Symbol.asyncIterator]();
	/** The next piece of text, or null at the end. Errors arrive as stream parts, not throws. */
	const nextText = async (): Promise<string | null> => {
		for (;;) {
			const { value, done } = await parts.next();
			if (done) return null;
			if (value.type === "error") throw describeAiError(value.error, config);
			if (value.type === "text-delta" && value.text) return value.text;
		}
	};
	const first = await nextText();
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			if (first === null) controller.close();
			else controller.enqueue(encoder.encode(first));
		},
		// Must enqueue or close before returning, or the stream stalls.
		async pull(controller) {
			try {
				const text = await nextText();
				if (text === null) controller.close();
				else controller.enqueue(encoder.encode(text));
			} catch (err) {
				controller.error(err);
			}
		},
		async cancel() {
			await parts.return?.();
		},
	});
	return new Response(body, {
		headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
	});
}

function model(c: AppContext, config: AiConfig): LanguageModel {
	try {
		return aiModels.create(c.env, config);
	} catch (err) {
		throw describeAiError(err, config);
	}
}

const common = (c: AppContext) => ({ maxRetries: 1, abortSignal: c.req.raw.signal, onError: () => {} });

// ---- /api/extensions --------------------------------------------------------

export const extensionRoutes = new Hono<AppEnv>();

extensionRoutes.get("/", async (c) => {
	const ai = await getAiSettings(c.env, c.get("identity").email);
	return c.json<ExtensionInfo[]>([{ id: "ai", ...EXTENSIONS.ai, enabled: ai.enabled, ready: isReady(ai) }]);
});

extensionRoutes.get("/ai", async (c) => c.json<AiSettings>(await getAiSettings(c.env, c.get("identity").email)));

extensionRoutes.put("/ai", async (c) => {
	const update = await parseBody(c.req.raw, SettingsBody);
	return c.json<AiSettings>(await saveAiSettings(c.env, c.get("identity").email, update));
});

extensionRoutes.get("/ai/models", async (c) => {
	await aiBudget(c);
	const config = await requireAiConfig(c.env, c.get("identity").email, { whileDisabled: true, withoutModel: true });
	try {
		return c.json<AiModelOption[]>(await listModels(c.env, config));
	} catch (err) {
		throw describeAiError(err, config);
	}
});

/** A tiny request to check the key and model work. */
extensionRoutes.post("/ai/test", async (c) => {
	await aiBudget(c);
	const config = await requireAiConfig(c.env, c.get("identity").email, { whileDisabled: true });
	try {
		const result = await generateText({ model: model(c, config), prompt: "Reply with just the word OK.", maxOutputTokens: 200, ...common(c) });
		return c.json({ ok: true, reply: result.text.trim().slice(0, 100) });
	} catch (err) {
		throw describeAiError(err, config);
	}
});

extensionRoutes.post("/ai/rewrite", async (c) => {
	const body = await parseBody(c.req.raw, RewriteBody);
	await aiBudget(c);
	const config = await requireAiConfig(c.env, c.get("identity").email);
	return textResponse(streamText({ model: model(c, config), ...rewritePrompt(body.text, body.mode, body.instructions), ...common(c) }), config);
});

// ---- /api/mailboxes/:mailboxId/ai (after the mailbox access check) ---------------------

export const mailboxAiRoutes = new Hono<AppEnv>();

const stub = (c: AppContext) => getMailbox(c.env, c.req.param("mailboxId")!);
async function sender(c: AppContext) {
	const entry = await getRegistry(c.env).getMailbox(c.req.param("mailboxId")!);
	if (!entry) throw new HttpError(404, "Mailbox not found");
	return { name: entry.displayName, address: entry.address };
}

mailboxAiRoutes.post("/summarize", async (c) => {
	const { threadId } = await parseBody(c.req.raw, SummarizeBody);
	await aiBudget(c);
	const config = await requireAiConfig(c.env, c.get("identity").email);
	const thread = await stub(c).getThread(threadId);
	if (!thread) throw new HttpError(404, "Thread not found");
	const me = await sender(c);
	return textResponse(streamText({ model: model(c, config), ...summarizePrompt(thread, me.address), ...common(c) }), config);
});

mailboxAiRoutes.post("/write", async (c) => {
	const body = await parseBody(c.req.raw, WriteBody);
	await aiBudget(c);
	const config = await requireAiConfig(c.env, c.get("identity").email);
	let thread;
	let parent;
	if (body.parentMessageId) {
		const threadId = await stub(c).threadIdOf(body.parentMessageId);
		thread = threadId ? ((await stub(c).getThread(threadId)) ?? undefined) : undefined;
		parent = thread?.messages.find((m) => m.id === body.parentMessageId);
		if (!parent) throw new HttpError(404, "The message you're replying to no longer exists");
	}
	const prompt = writePrompt({ ...body, me: await sender(c), parent, thread });
	return textResponse(streamText({ model: model(c, config), ...prompt, ...common(c) }), config);
});

/**
 * "Ask your inbox": a chat whose tools can search and read this mailbox, and nothing else.
 * They're read-only, so a message that tries to steer the model can't make it act on mail.
 */
mailboxAiRoutes.post("/chat", async (c) => {
	const { messages, tz } = await parseBody(c.req.raw, ChatBody);
	for (const m of messages) {
		const text = m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
		if (m.role === "user" && text.length > AI_LIMITS.chatChars) throw new HttpError(413, "That message is too long");
	}
	await aiBudget(c);
	const config = await requireAiConfig(c.env, c.get("identity").email);
	const mailbox = stub(c);
	const me = await sender(c);

	const tools = {
		search_mail: tool({
			description: "Search the mailbox. Returns up to 15 conversations, newest first.",
			inputSchema: z.object({ query: z.string().min(1).max(MAX_QUERY_LENGTH).describe("Gmail-style search query") }),
			execute: async ({ query }): Promise<{ query: string; results: AiThreadHit[]; error?: string }> => {
				const page = await mailbox.search({ query, limit: 15, tzOffsetMinutes: tz });
				if (!page.ok) return { query, results: [], error: page.message };
				return {
					query,
					results: page.value.threads.map((t) => ({
						threadId: t.id,
						subject: t.subject || "(no subject)",
						from: t.participants.map((p) => p.name || p.address).join(", "),
						date: new Date(t.lastMessageAt).toISOString(),
						snippet: t.snippet,
						unread: t.unread,
					})),
				};
			},
		}),
		read_thread: tool({
			description: "Read every message in a conversation found with search_mail.",
			inputSchema: z.object({ threadId: z.string().min(1).max(100) }),
			execute: async ({ threadId }) => {
				const thread = await mailbox.getThread(threadId);
				if (!thread) return { threadId, error: "No such conversation" };
				return { threadId, subject: thread.thread.subject || "(no subject)", content: formatThread(thread) };
			},
		}),
	};

	let modelMessages;
	try {
		modelMessages = await convertToModelMessages(messages, { tools });
	} catch {
		throw new HttpError(400, "The chat history couldn't be read. Start a new chat.");
	}
	const result = streamText({
		model: model(c, config),
		instructions: chatInstructions({ me, now: new Date(), tzOffsetMinutes: tz }),
		messages: modelMessages,
		tools,
		stopWhen: isStepCount(8),
		...common(c),
	});
	return createUIMessageStreamResponse({
		stream: toUIMessageStream({ stream: result.stream, tools, onError: (err) => describeAiError(err, config).message }),
		headers: { "Cache-Control": "no-store" },
	});
});
