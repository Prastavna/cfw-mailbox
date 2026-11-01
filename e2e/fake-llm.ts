import { createServer, type Server } from "node:http";

/**
 * A stand-in for an OpenAI-compatible provider, so the AI Assistant's end-to-end tests go
 * through the real code path (settings, key handling, streaming, tools) without a real key.
 * Answers are scripted from the request: what the system prompt asks for, and, in the chat,
 * which tools have run so far.
 */
export const FAKE_LLM_PORT = Number(process.env.E2E_LLM_PORT ?? 5181);
export const FAKE_LLM_URL = `http://127.0.0.1:${FAKE_LLM_PORT}/v1`;
export const FAKE_LLM_MODEL = "fake-model";

type Message = { role: string; content?: string | { type: string; text?: string }[] | null; tool_calls?: unknown[] };
type ChatRequest = { messages: Message[]; stream?: boolean; tools?: { function: { name: string } }[] };

const text = (m: Message | undefined) => (typeof m?.content === "string" ? m.content : (m?.content ?? []).map((p) => p.text ?? "").join(""));

type Reply = { content: string } | { tool: string; args: unknown };

function reply(req: ChatRequest): Reply {
	const system = text(req.messages.find((m) => m.role === "system"));
	const user = text([...req.messages].reverse().find((m) => m.role === "user"));
	if (req.tools?.length) {
		const toolResults = req.messages.filter((m) => m.role === "tool").map(text);
		if (toolResults.length === 0) return { tool: "search_mail", args: { query: "invoice" } };
		if (toolResults.length === 1) {
			const threadId = /"threadId":"([^"]+)"/.exec(toolResults[0]!)?.[1];
			return threadId ? { tool: "read_thread", args: { threadId } } : { content: "I couldn't find any invoices." };
		}
		const total = /total is (\$[\d,]+(?:\.\d+)?)/.exec(toolResults[1]!)?.[1] ?? "unknown";
		return { content: `The invoice total is ${total}, from Ops.` };
	}
	if (/summarise email conversations/i.test(system)) return { content: "Ann needs the Q3 numbers by Friday.\n- Reply with the spreadsheet" };
	if (/write emails on behalf/i.test(system)) return { content: "Hi Ann,\n\nThursday works for me. See you then.\n\nBest" };
	if (/rewrite text/i.test(system)) return { content: "Thanks so much!" };
	if (/word OK/.test(user)) return { content: "OK" };
	return { content: "I'm a fake model." };
}

function chunk(delta: object, finish: string | null = null) {
	return `data: ${JSON.stringify({ id: "chatcmpl-fake", object: "chat.completion.chunk", created: 0, model: FAKE_LLM_MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

export function startFakeLlm(): Promise<Server> {
	const server = createServer((req, res) => {
		if (req.method === "GET" && req.url === "/v1/models") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ object: "list", data: [{ id: FAKE_LLM_MODEL, object: "model" }, { id: "fake-model-large", object: "model" }] }));
			return;
		}
		if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
			res.writeHead(404).end();
			return;
		}
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const request = JSON.parse(body) as ChatRequest;
			const r = reply(request);
			if (!request.stream) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						id: "chatcmpl-fake",
						object: "chat.completion",
						created: 0,
						model: FAKE_LLM_MODEL,
						choices: [{ index: 0, message: { role: "assistant", content: "content" in r ? r.content : "" }, finish_reason: "stop" }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					}),
				);
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			if ("content" in r) {
				res.write(chunk({ role: "assistant", content: "" }));
				for (const piece of r.content.split(/(?<= )/)) res.write(chunk({ content: piece }));
				res.write(chunk({}, "stop"));
			} else {
				res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${r.tool}`, type: "function", function: { name: r.tool, arguments: JSON.stringify(r.args) } }] }));
				res.write(chunk({}, "tool_calls"));
			}
			res.end("data: [DONE]\n\n");
		});
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(FAKE_LLM_PORT, "127.0.0.1", () => resolve(server));
	});
}
