import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { ArrowUp, Loader2, MessageSquarePlus, Search, Sparkles, Square, TextSearch } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { AI_LIMITS, type AiThreadHit } from "../../../../shared/extensions";
import { Button } from "~/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "~/components/ui/sheet";
import { formatListDate } from "~/lib/format";
import { cn } from "~/lib/utils";

const SUGGESTIONS = ["What needs a reply from me this week?", "Summarise today's unread mail", "Find the most recent invoice or receipt"];

/** The server's errors arrive as the response body, JSON with an `error` field. */
function errorMessage(err: Error): string {
	try {
		const body = JSON.parse(err.message) as { error?: string };
		if (body.error) return body.error;
	} catch {
		// Not JSON: a network error or a message from the stream.
	}
	return err.message || "Something went wrong.";
}

interface AskInboxProps {
	mailboxId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

/**
 * "Ask your inbox": a chat that searches and reads this mailbox to answer. The conversation
 * lives in memory for this mailbox while the page is open; nothing about it is stored.
 */
export function AskInbox({ mailboxId, open, onOpenChange }: AskInboxProps) {
	const transport = useMemo(
		() => new DefaultChatTransport({ api: `/api/mailboxes/${mailboxId}/ai/chat`, body: () => ({ tz: new Date().getTimezoneOffset() }) }),
		[mailboxId],
	);
	const { messages, sendMessage, status, stop, error, setMessages, clearError } = useChat({ id: `ask-${mailboxId}`, transport });
	const [input, setInput] = useState("");
	const scroller = useRef<HTMLDivElement>(null);
	const busy = status === "submitted" || status === "streaming";

	useEffect(() => {
		scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
	}, [messages, status]);

	const send = (text: string) => {
		const t = text.trim();
		if (!t || busy) return;
		if (messages.length >= AI_LIMITS.chatMessages - 1) setMessages(messages.slice(-(AI_LIMITS.chatMessages - 3)));
		clearError();
		void sendMessage({ text: t });
		setInput("");
	};

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent side="right" className="w-full gap-0 bg-mail-surface p-0 sm:max-w-md">
				<header className="flex items-center gap-2 border-b px-4 py-3 pr-12">
					<Sparkles className="size-5 text-violet-600 dark:text-violet-400" aria-hidden />
					<div className="min-w-0 flex-1">
						<SheetTitle className="text-base">Ask your inbox</SheetTitle>
						<SheetDescription className="text-xs">Searches and reads this mailbox to answer. It can't change anything.</SheetDescription>
					</div>
					{messages.length > 0 && (
						<Button
							variant="ghost"
							size="icon-sm"
							className="rounded-full"
							aria-label="New chat"
							title="New chat"
							onClick={() => {
								void stop();
								setMessages([]);
								clearError();
							}}
						>
							<MessageSquarePlus className="size-4" />
						</Button>
					)}
				</header>

				<div ref={scroller} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4" aria-live="polite">
					{messages.length === 0 ? (
						<div className="m-auto flex max-w-xs flex-col items-center gap-3 text-center">
							<span className="flex size-12 items-center justify-center rounded-full bg-gradient-to-br from-sky-500 via-violet-500 to-fuchsia-500 text-white">
								<Sparkles className="size-6" aria-hidden />
							</span>
							<p className="text-sm text-muted-foreground">Ask about anything in this mailbox: who said what, what's due, where a file is.</p>
							<div className="flex flex-col gap-1.5 pt-1">
								{SUGGESTIONS.map((s) => (
									<button key={s} type="button" className="rounded-full border px-3 py-1.5 text-sm hover:bg-mail-hover" onClick={() => send(s)}>
										{s}
									</button>
								))}
							</div>
						</div>
					) : (
						messages.map((m) => <ChatMessage key={m.id} message={m} mailboxId={mailboxId} onNavigate={() => onOpenChange(false)} />)
					)}
					{status === "submitted" && (
						<p className="flex items-center gap-2 text-sm text-muted-foreground">
							<Loader2 className="size-4 animate-spin" aria-hidden /> Thinking…
						</p>
					)}
					{error && (
						<p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
							{errorMessage(error)}
						</p>
					)}
				</div>

				<form
					className="border-t p-3"
					onSubmit={(e) => {
						e.preventDefault();
						send(input);
					}}
				>
					<div className="flex items-end gap-1 rounded-2xl border bg-background px-3 py-1.5 focus-within:ring-2 focus-within:ring-violet-300">
						<textarea
							rows={1}
							aria-label="Ask a question"
							placeholder="Ask a question about your mail"
							maxLength={AI_LIMITS.chatChars}
							className="max-h-40 min-h-8 flex-1 resize-none bg-transparent py-1.5 text-sm outline-none placeholder:text-muted-foreground"
							value={input}
							onChange={(e) => setInput(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
									e.preventDefault();
									send(input);
								}
							}}
						/>
						{busy ? (
							<Button type="button" size="icon-sm" variant="outline" className="mb-0.5 rounded-full" onClick={() => void stop()} aria-label="Stop">
								<Square className="size-3" />
							</Button>
						) : (
							<Button type="submit" size="icon-sm" className="mb-0.5 rounded-full" disabled={!input.trim()} aria-label="Send">
								<ArrowUp />
							</Button>
						)}
					</div>
					<p className="px-2 pt-1.5 text-[11px] text-muted-foreground">AI can make mistakes. Check the conversations it links to.</p>
				</form>
			</SheetContent>
		</Sheet>
	);
}

type SearchOutput = { query: string; results: AiThreadHit[]; error?: string };
type ReadOutput = { threadId: string; subject?: string; error?: string };
type ToolPart = { type: string; state: string; input?: unknown; output?: unknown; errorText?: string; toolCallId: string };

function ChatMessage({ message, mailboxId, onNavigate }: { message: UIMessage; mailboxId: string; onNavigate: () => void }) {
	if (message.role === "user") {
		const text = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
		return <div className="ml-10 self-end rounded-2xl rounded-br-md bg-mail-active px-3.5 py-2 text-sm whitespace-pre-wrap text-mail-active-foreground">{text}</div>;
	}
	return (
		<div className="flex flex-col gap-2">
			{message.parts.map((part, i) => {
				if (part.type === "text") {
					return (
						<p key={i} className="text-sm leading-relaxed whitespace-pre-wrap">
							{part.text.replace(/\*\*(.+?)\*\*/g, "$1")}
						</p>
					);
				}
				if (part.type === "tool-search_mail" || part.type === "tool-read_thread") {
					return <ToolActivity key={i} part={part as unknown as ToolPart} mailboxId={mailboxId} onNavigate={onNavigate} />;
				}
				return null;
			})}
		</div>
	);
}

function ToolActivity({ part, mailboxId, onNavigate }: { part: ToolPart; mailboxId: string; onNavigate: () => void }) {
	const [expanded, setExpanded] = useState(false);
	const done = part.state === "output-available";
	const href = (threadId: string) => `/mail/${mailboxId}/all/${threadId}`;

	if (part.type === "tool-search_mail") {
		const query = (part.input as { query?: string } | undefined)?.query ?? "";
		const output = done ? (part.output as SearchOutput) : null;
		return (
			<div className="text-xs text-muted-foreground">
				<button
					type="button"
					className="flex items-center gap-1.5 rounded-full py-0.5 hover:text-foreground disabled:hover:text-muted-foreground"
					onClick={() => setExpanded((v) => !v)}
					disabled={!output?.results.length}
					aria-expanded={expanded}
				>
					{done ? <Search className="size-3.5" aria-hidden /> : <Loader2 className="size-3.5 animate-spin" aria-hidden />}
					<span>
						Searched <span className="font-mono">{query}</span>
						{output && (output.error ? ` · ${output.error}` : ` · ${output.results.length} result${output.results.length === 1 ? "" : "s"}`)}
					</span>
				</button>
				{expanded && output && (
					<ul className="mt-1 flex flex-col gap-0.5 border-l pl-3">
						{output.results.map((r) => (
							<li key={r.threadId}>
								<Link to={href(r.threadId)} onClick={onNavigate} className="flex gap-2 rounded px-1.5 py-1 text-foreground hover:bg-mail-hover">
									<span className={cn("min-w-0 flex-1 truncate", r.unread && "font-semibold")}>
										{r.from} — {r.subject}
									</span>
									<span className="shrink-0 text-muted-foreground">{formatListDate(Date.parse(r.date))}</span>
								</Link>
							</li>
						))}
					</ul>
				)}
			</div>
		);
	}

	const threadId = (part.input as { threadId?: string } | undefined)?.threadId;
	const output = done ? (part.output as ReadOutput) : null;
	return (
		<div className="flex items-center gap-1.5 text-xs text-muted-foreground">
			{done ? <TextSearch className="size-3.5" aria-hidden /> : <Loader2 className="size-3.5 animate-spin" aria-hidden />}
			{output?.subject && threadId ? (
				<span className="min-w-0 truncate">
					Read{" "}
					<Link to={href(threadId)} onClick={onNavigate} className="text-primary hover:underline">
						{output.subject}
					</Link>
				</span>
			) : (
				<span>{output?.error ?? "Reading a conversation…"}</span>
			)}
		</div>
	);
}
