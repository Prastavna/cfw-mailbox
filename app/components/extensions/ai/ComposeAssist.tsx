import type { Editor } from "@tiptap/react";
import { ArrowUp, Loader2, RotateCcw, Sparkles, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AI_LIMITS, REWRITE_MODES, type RewriteMode } from "../../../../shared/extensions";
import { Button } from "~/components/ui/button";
import { textToHtml, useAiRun } from "~/lib/extensions";
import { cn } from "~/lib/utils";

interface ComposeAssistProps {
	editor: Editor;
	mailboxId: string;
	/** The message being replied to or forwarded. */
	parentMessageId?: string;
	subject: string;
	to: string[];
	onClose: () => void;
}

interface Target {
	from: number;
	to: number;
	text: string;
}

/**
 * "Help me write" in the composer. With text selected it rewrites the selection; otherwise it
 * writes from a description. Either way the result is shown first, and only goes into the
 * message when you insert it.
 */
export function ComposeAssist({ editor, mailboxId, parentMessageId, subject, to, onClose }: ComposeAssistProps) {
	// What to replace, fixed when the panel opens: the selection, or the cursor position.
	const [target] = useState<Target>(() => {
		const { from, to, empty } = editor.state.selection;
		return { from, to: empty ? from : to, text: empty ? "" : editor.state.doc.textBetween(from, to, "\n\n").trim() };
	});
	const rewriting = target.text.length > 0;
	const [prompt, setPrompt] = useState("");
	const { state, run, cancel, reset } = useAiRun();
	const last = useRef<() => void>(() => {});
	const input = useRef<HTMLTextAreaElement>(null);
	useEffect(() => input.current?.focus(), []);

	const write = () => {
		const instructions = prompt.trim();
		if (!instructions) return;
		const current = editor.getText().trim();
		last.current = () =>
			void run(`/mailboxes/${mailboxId}/ai/write`, {
				instructions,
				parentMessageId,
				subject: subject || undefined,
				to: to.length ? to : undefined,
				current: current ? current.slice(0, AI_LIMITS.rewriteChars) : undefined,
			});
		last.current();
	};
	const rewrite = (mode?: RewriteMode) => {
		const instructions = prompt.trim();
		if (!mode && !instructions) return;
		last.current = () => void run("/extensions/ai/rewrite", { text: target.text, mode, instructions: mode ? undefined : instructions });
		last.current();
	};
	const submit = () => (rewriting ? rewrite() : write());

	const apply = () => {
		if (state.status !== "done") return;
		const html = textToHtml(state.text);
		const range = rewriting ? { from: target.from, to: target.to } : target.from;
		editor.chain().focus().insertContentAt(range, html).run();
		onClose();
	};

	const busy = state.status === "running";
	const tooLong = target.text.length > AI_LIMITS.rewriteChars;

	return (
		<div
			className="mx-3 mb-2 rounded-xl border border-violet-200 bg-violet-50/60 p-2 text-sm dark:border-violet-900 dark:bg-violet-950/30"
			role="group"
			aria-label={rewriting ? "Rewrite with AI" : "Help me write"}
			onKeyDown={(e) => {
				if (e.key === "Escape") {
					e.preventDefault();
					e.stopPropagation();
					onClose();
				}
			}}
		>
			<div className="flex items-center gap-2 px-1 pb-1.5 text-xs font-medium text-violet-800 dark:text-violet-300">
				<Sparkles className="size-3.5" aria-hidden />
				<span className="flex-1">{rewriting ? "Rewrite the selected text" : parentMessageId ? "Help me write a reply" : "Help me write"}</span>
				<button type="button" className="rounded-full p-0.5 hover:bg-foreground/10" onClick={onClose} aria-label="Close AI assistant">
					<X className="size-3.5" />
				</button>
			</div>

			{state.status === "idle" || state.status === "error" ? (
				<>
					{rewriting && (
						<div className="flex flex-wrap gap-1 px-1 pb-2">
							{(Object.keys(REWRITE_MODES) as RewriteMode[]).map((mode) => (
								<Button key={mode} type="button" variant="outline" size="xs" className="rounded-full bg-background" onClick={() => rewrite(mode)} disabled={tooLong}>
									{REWRITE_MODES[mode]}
								</Button>
							))}
						</div>
					)}
					<div className="flex items-end gap-1 rounded-lg border bg-background px-2 py-1 focus-within:ring-2 focus-within:ring-violet-300">
						<textarea
							ref={input}
							rows={rewriting ? 1 : 2}
							maxLength={AI_LIMITS.instructionsChars}
							className="max-h-32 min-h-8 flex-1 resize-none bg-transparent py-1 text-sm outline-none placeholder:text-muted-foreground"
							placeholder={
								rewriting ? "Or describe a change, e.g. “translate to Spanish”" : parentMessageId ? "e.g. “Thank them and say Thursday works”" : "e.g. “Invite the team to Friday's launch party”"
							}
							value={prompt}
							onChange={(e) => setPrompt(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
									e.preventDefault();
									e.stopPropagation();
									submit();
								}
							}}
						/>
						<Button type="button" size="icon-sm" className="mb-0.5 rounded-full" onClick={submit} disabled={!prompt.trim() || tooLong} aria-label={rewriting ? "Rewrite" : "Write"}>
							<ArrowUp />
						</Button>
					</div>
					{tooLong && <p className="px-1 pt-1.5 text-xs text-destructive">Select less text: at most {AI_LIMITS.rewriteChars.toLocaleString()} characters.</p>}
					{state.status === "error" && (
						<p role="alert" className="px-1 pt-1.5 text-xs text-destructive">
							{state.error}
						</p>
					)}
				</>
			) : (
				<>
					<div
						className={cn("max-h-48 overflow-y-auto rounded-lg border bg-background px-3 py-2 whitespace-pre-wrap", busy && !state.text && "text-muted-foreground")}
						aria-live="polite"
						aria-busy={busy}
					>
						{state.text || "Writing…"}
					</div>
					<div className="flex items-center gap-1 pt-2">
						{busy ? (
							<Button type="button" variant="outline" size="sm" className="rounded-full" onClick={cancel}>
								<Square className="size-3" aria-hidden /> Stop
							</Button>
						) : (
							<>
								<Button type="button" size="sm" className="rounded-full" onClick={apply}>
									{rewriting ? "Replace" : "Insert"}
								</Button>
								<Button type="button" variant="ghost" size="sm" className="rounded-full" onClick={() => last.current()}>
									<RotateCcw aria-hidden /> Retry
								</Button>
								<Button type="button" variant="ghost" size="sm" className="rounded-full" onClick={reset}>
									Edit request
								</Button>
							</>
						)}
						{busy && <Loader2 className="ml-auto size-4 animate-spin text-muted-foreground" aria-hidden />}
					</div>
				</>
			)}
		</div>
	);
}
