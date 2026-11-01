import { Grip, Sparkles } from "lucide-react";
import { useState } from "react";
import type { ExtensionId, ExtensionInfo } from "../../../shared/extensions";
import { Button } from "~/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { useExtensions } from "~/lib/extensions";
import { cn } from "~/lib/utils";

const ICONS: Record<ExtensionId, { icon: typeof Sparkles; className: string }> = {
	ai: { icon: Sparkles, className: "bg-gradient-to-br from-sky-500 via-violet-500 to-fuchsia-500 text-white" },
};

function status(e: ExtensionInfo) {
	if (!e.enabled) return "Off";
	return e.ready ? "On" : "Needs setup";
}

/** The apps grid in the top bar: every extension, and a way into its settings. */
export function ExtensionsLauncher({ onOpen }: { onOpen: (id: ExtensionId) => void }) {
	const [open, setOpen] = useState(false);
	const { data, isPending, isError } = useExtensions();

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<Tooltip>
				<TooltipTrigger asChild>
					<PopoverTrigger asChild>
						<Button variant="ghost" size="icon-lg" className="rounded-full" aria-label="Extensions">
							<Grip className="size-5" />
						</Button>
					</PopoverTrigger>
				</TooltipTrigger>
				<TooltipContent>Extensions</TooltipContent>
			</Tooltip>
			<PopoverContent align="end" className="w-80 rounded-3xl bg-mail-canvas p-2">
				<div className="rounded-2xl bg-mail-surface p-3">
					<h2 className="px-1 pb-2 text-sm font-medium">Extensions</h2>
					{isPending ? (
						<p className="px-1 py-6 text-center text-sm text-muted-foreground">Loading…</p>
					) : isError ? (
						<p className="px-1 py-6 text-center text-sm text-destructive">Couldn't load extensions.</p>
					) : (
						<ul className="grid grid-cols-3 gap-1">
							{data.map((e) => {
								const { icon: Icon, className } = ICONS[e.id];
								return (
									<li key={e.id}>
										<button
											type="button"
											className="flex w-full flex-col items-center gap-1.5 rounded-xl px-1 py-3 text-center hover:bg-mail-hover focus-visible:bg-mail-hover focus-visible:outline-none"
											onClick={() => {
												setOpen(false);
												onOpen(e.id);
											}}
											title={e.description}
										>
											<span className={cn("flex size-11 items-center justify-center rounded-full", className, !e.enabled && "opacity-50 grayscale")}>
												<Icon className="size-5" aria-hidden />
											</span>
											<span className="text-xs leading-tight">{e.name}</span>
											<span
												className={cn(
													"text-[11px] leading-none",
													e.enabled && e.ready ? "text-green-700 dark:text-green-400" : e.enabled ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground",
												)}
											>
												{status(e)}
											</span>
										</button>
									</li>
								);
							})}
						</ul>
					)}
				</div>
				<p className="px-3 pt-2 pb-1 text-xs text-muted-foreground">Extensions are off until you turn them on, and only run when you use them.</p>
			</PopoverContent>
		</Popover>
	);
}
