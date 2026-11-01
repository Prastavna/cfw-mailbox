import { Loader2, RotateCcw, Sparkles, Square, X } from "lucide-react";
import { useEffect } from "react";
import { Button } from "~/components/ui/button";
import { type AiRunState, useAiRun } from "~/lib/extensions";

/** "Summarise" for the open conversation. Runs only when clicked; forgotten when you leave the thread. */
export function useThreadSummary(mailboxId: string, threadId: string) {
	const { state, run, reset } = useAiRun();
	useEffect(() => reset, [threadId, reset]);
	return { state, summarize: () => void run(`/mailboxes/${mailboxId}/ai/summarize`, { threadId }), reset };
}

export function SummarizeButton({ state, onClick }: { state: AiRunState; onClick: () => void }) {
	const busy = state.status === "running";
	return (
		<Button variant="outline" size="sm" className="ml-auto rounded-full" onClick={onClick} disabled={busy}>
			{busy ? <Loader2 className="animate-spin" aria-hidden /> : <Sparkles className="text-violet-600 dark:text-violet-400" aria-hidden />}
			Summarise
		</Button>
	);
}

export function SummaryCard({ state, onRetry, onClose }: { state: AiRunState; onRetry: () => void; onClose: () => void }) {
	if (state.status === "idle") return null;
	const text = state.text;
	return (
		<section
			aria-label="Summary"
			aria-busy={state.status === "running"}
			className="mx-4 mb-4 rounded-2xl border border-violet-200 bg-violet-50/60 p-4 sm:ml-[72px] dark:border-violet-900 dark:bg-violet-950/30"
		>
			<header className="mb-2 flex items-center gap-2 text-sm font-medium">
				<Sparkles className="size-4 text-violet-600 dark:text-violet-400" aria-hidden />
				<span className="flex-1">Summary</span>
				{state.status === "running" ? (
					<Button variant="ghost" size="icon-sm" className="rounded-full" onClick={onClose} aria-label="Stop">
						<Square className="size-3.5" />
					</Button>
				) : (
					<Button variant="ghost" size="icon-sm" className="rounded-full" onClick={onRetry} aria-label="Summarise again">
						<RotateCcw className="size-4" />
					</Button>
				)}
				<Button variant="ghost" size="icon-sm" className="rounded-full" onClick={onClose} aria-label="Close summary">
					<X className="size-4" />
				</Button>
			</header>
			{text ? (
				<p className="text-sm leading-relaxed whitespace-pre-wrap" aria-live="polite">
					{text}
				</p>
			) : state.status === "running" ? (
				<p className="text-sm text-muted-foreground">Reading the conversation…</p>
			) : null}
			{state.status === "error" && <p className="mt-1 text-sm text-destructive">{state.error}</p>}
			{state.status === "done" && <p className="mt-3 text-xs text-muted-foreground">Written by AI. Check important details in the messages.</p>}
		</section>
	);
}
