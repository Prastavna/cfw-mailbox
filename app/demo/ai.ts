import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from "ai";
import type { ThreadDetail } from "../../shared/api";
import type { AiRewriteRequest, AiThreadHit, AiWriteRequest } from "../../shared/extensions";
import type { DemoMailbox } from "./store";

/**
 * The demo's AI Assistant: canned, offline answers built from the mail itself.
 * No model and no network are involved.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Streams text word by word, like a model would. */
export function textStream(text: string): Response {
	const words = text.split(/(?<=\s)/);
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			const enc = new TextEncoder();
			await sleep(350);
			for (const w of words) {
				controller.enqueue(enc.encode(w));
				await sleep(18);
			}
			controller.close();
		},
	});
	return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}

const firstName = (s: string) => s.split(/[\s@]/)[0] ?? s;

export function summarize(thread: ThreadDetail, me: string, canned?: string): string {
	if (canned) return canned;
	const others = thread.messages.filter((m) => m.from.address !== me);
	const people = [...new Set(others.map((m) => m.from.name || m.from.address))];
	const latest = thread.messages.at(-1)!;
	const files = thread.messages.flatMap((m) => m.attachments.filter((a) => a.disposition === "attachment").map((a) => a.filename));
	const lines = [
		`${people.length ? people.join(" and ") : "You"} ${thread.messages.length > 1 ? `exchanged ${thread.messages.length} messages` : "wrote"} about “${thread.thread.subject || "(no subject)"}”.`,
		`- Latest, from ${latest.from.name || latest.from.address}: ${latest.snippet.slice(0, 160)}`,
	];
	if (files.length) lines.push(`- Attachments: ${files.join(", ")}`);
	lines.push(/\?/.test(latest.text ?? latest.snippet) && latest.from.address !== me ? "- They're waiting on an answer from you" : "- Nothing seems to need a reply right now");
	return lines.join("\n");
}

export function write(req: AiWriteRequest, mailbox: DemoMailbox, parent?: { from: { name: string; address: string } }): string {
	const to = parent?.from.name || req.to?.[0] || "there";
	const ask = req.instructions.trim().replace(/\.$/, "");
	const me = firstName(mailbox.displayName);
	return `Hi ${firstName(to)},\n\nThanks for your message. ${ask.charAt(0).toUpperCase()}${ask.slice(1)}.\n\nLet me know if anything else would help.\n\nBest,\n${me}`;
}

export function rewrite(req: AiRewriteRequest): string {
	const text = req.text.trim();
	const sentences = text.match(/[^.!?]+[.!?]*/g)?.map((s) => s.trim()) ?? [text];
	switch (req.mode) {
		case "shorten":
			return sentences.slice(0, Math.max(1, Math.ceil(sentences.length / 2))).join(" ");
		case "elaborate":
			return `${text}\n\nTo add a little more context: I wanted to make sure we're aligned before moving ahead, and I'm happy to go over the details whenever suits you.`;
		case "formal":
			return `Dear colleague,\n\n${text.replace(/\bhey\b|\bhi\b/gi, "Hello").replace(/\bthanks\b/gi, "Thank you")}\n\nKind regards`;
		case "friendly":
			return `Hey! ${text} 😊`;
		case "proofread":
			return sentences.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(" ").replace(/\bi\b/g, "I").replace(/\s{2,}/g, " ");
		default:
			return req.instructions ? `${text}\n\n(Demo: in the real app your model would apply “${req.instructions}” here.)` : text;
	}
}

const STOP = new Set(
	"a an the and or of to in on for from with about is are was were be my me i you your any do does did have has what which who when where how there this that it its show find tell get emails email mail messages message inbox".split(" "),
);

/** "Ask your inbox": searches and reads the mailbox with the same tools the real chat has, then answers. */
export function chat(messages: UIMessage[], mailbox: DemoMailbox): Response {
	const question = [...messages].reverse().find((m) => m.role === "user")?.parts.map((p) => (p.type === "text" ? p.text : "")).join("") ?? "";
	const lower = question.toLowerCase();
	const words = lower.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
	// Lists answer with bullets; a lookup reads the best match and answers from it.
	const [query, kind]: [string, "list" | "lookup"] = /reply|waiting|respond|need/.test(lower)
		? ["in:inbox is:unread newer_than:7d", "list"]
		: /unread|today/.test(lower)
			? ["is:unread", "list"]
			: /invoice|receipt|bill|total|paid|payment/.test(lower)
				? ["invoice OR receipt", "lookup"]
				: /attach/.test(lower)
					? ["has:attachment", "list"]
					: /star/.test(lower)
						? ["is:starred", "list"]
						: [words.slice(0, 2).join(" OR ") || "in:inbox", "lookup"];
	const when = (at: number) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });

	const stream = createUIMessageStream({
		async execute({ writer }) {
			writer.write({ type: "start" });
			writer.write({ type: "start-step" });
			writer.write({ type: "tool-input-available", toolCallId: "call_search", toolName: "search_mail", input: { query } });
			await sleep(500);
			const page = mailbox.search(query, undefined, 15, new Date().getTimezoneOffset());
			const results: AiThreadHit[] = page.threads.map((t) => ({
				threadId: t.id,
				subject: t.subject || "(no subject)",
				from: t.participants.map((p) => p.name || p.address).join(", "),
				date: new Date(t.lastMessageAt).toISOString(),
				snippet: t.snippet,
				unread: t.unread,
			}));
			writer.write({ type: "tool-output-available", toolCallId: "call_search", output: { query, results } });
			writer.write({ type: "finish-step" });

			let answer: string;
			const top = page.threads[0];
			if (!top) {
				answer = `I searched for \`${query}\` and didn't find anything. Try different words, or a sender's name.`;
			} else if (kind === "list") {
				const items = page.threads.slice(0, 5).map((t) => `• ${t.subject || "(no subject)"} — ${t.participants.map((x) => x.name || x.address).join(", ")}: ${t.snippet.slice(0, 90)}${t.snippet.length > 90 ? "…" : ""}`);
				answer = `${page.threads.length} conversation${page.threads.length === 1 ? "" : "s"} to look at:\n\n${items.join("\n")}`;
			} else {
				writer.write({ type: "start-step" });
				writer.write({ type: "tool-input-available", toolCallId: "call_read", toolName: "read_thread", input: { threadId: top.id } });
				await sleep(400);
				const thread = mailbox.getThread(top.id)!;
				const content = thread.messages.map((m) => m.text ?? "").join("\n");
				writer.write({ type: "tool-output-available", toolCallId: "call_read", output: { threadId: top.id, subject: top.subject, content: content.slice(0, 2000) } });
				writer.write({ type: "finish-step" });
				const latest = thread.messages.at(-1)!;
				const total = /total(?: is)?[^$\d]{0,20}(\$[\d,]+(?:\.\d+)?)/i.exec(content)?.[1] ?? /(\$[\d,]+\.\d{2})/.exec(content)?.[1];
				answer =
					`The most recent match is “${top.subject}” from ${latest.from.name || latest.from.address} (${when(top.lastMessageAt)}).` +
					(total ? ` The total is ${total}.` : ` ${latest.snippet.slice(0, 180)}`) +
					(results.length > 1 ? `\n\nAlso related: ${results.slice(1, 4).map((r) => `“${r.subject}”`).join(", ")}.` : "");
			}
			answer += "\n\n(Demo answer, put together offline from the mail here. The real assistant uses your own AI provider.)";
			writer.write({ type: "start-step" });
			writer.write({ type: "text-start", id: "answer" });
			for (const w of answer.split(/(?<=\s)/)) {
				writer.write({ type: "text-delta", id: "answer", delta: w });
				await sleep(15);
			}
			writer.write({ type: "text-end", id: "answer" });
			writer.write({ type: "finish-step" });
			writer.write({ type: "finish" });
		},
	});
	return createUIMessageStreamResponse({ stream });
}
