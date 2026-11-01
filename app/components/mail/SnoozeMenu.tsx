import { Clock } from "lucide-react";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import { Label as FieldLabel } from "~/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { presetTime, snoozeLabel, snoozePresets } from "~/lib/snooze";
import { cn } from "~/lib/utils";

const pad = (n: number) => String(n).padStart(2, "0");
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

interface SnoozeMenuProps {
	/** Called with the chosen time (ms) and a human label for the toast. */
	onSnooze: (until: number, label: string) => void;
	/** Smaller trigger for row hover actions. */
	compact?: boolean;
	/** Controlled open state, so a keyboard shortcut can open it. */
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
}

/** "Snooze until…" menu with Gmail's presets and a custom date and time. */
export function SnoozeMenu({ onSnooze, compact, open, onOpenChange }: SnoozeMenuProps) {
	const [picking, setPicking] = useState(false);
	const [presets, setPresets] = useState(() => snoozePresets());
	const tomorrow = new Date(Date.now() + 86_400_000);
	const [date, setDate] = useState(localDate(tomorrow));
	const [time, setTime] = useState("08:00");
	const custom = new Date(`${date}T${time}`);
	const customValid = !Number.isNaN(custom.getTime()) && custom.getTime() > Date.now();

	return (
		<>
			<DropdownMenu
				open={open}
				onOpenChange={(o) => {
					if (o) setPresets(snoozePresets());
					onOpenChange?.(o);
				}}
			>
				<Tooltip>
					<TooltipTrigger asChild>
						<DropdownMenuTrigger asChild>
							<Button
								variant="ghost"
								size={compact ? "icon-sm" : "icon"}
								className="rounded-full"
								aria-label="Snooze"
								onClick={(e) => e.stopPropagation()}
							>
								<Clock className={cn(compact ? "size-[18px]" : "size-4")} />
							</Button>
						</DropdownMenuTrigger>
					</TooltipTrigger>
					<TooltipContent>Snooze</TooltipContent>
				</Tooltip>
				<DropdownMenuContent align="start" className="w-64" onClick={(e) => e.stopPropagation()}>
					<DropdownMenuLabel>Snooze until…</DropdownMenuLabel>
					{presets.map((p) => (
						<DropdownMenuItem key={p.label} onSelect={() => onSnooze(p.until.getTime(), snoozeLabel(p.until.getTime()))}>
							<span className="flex-1">{p.label}</span>
							<span className="text-xs text-muted-foreground">{presetTime(p.until)}</span>
						</DropdownMenuItem>
					))}
					<DropdownMenuSeparator />
					<DropdownMenuItem onSelect={() => setPicking(true)}>Pick date &amp; time</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<Dialog open={picking} onOpenChange={setPicking}>
				<DialogContent className="sm:max-w-sm" onClick={(e) => e.stopPropagation()}>
					<form
						className="grid gap-4"
						onSubmit={(e) => {
							e.preventDefault();
							if (!customValid) return;
							setPicking(false);
							onSnooze(custom.getTime(), snoozeLabel(custom.getTime()));
						}}
					>
						<DialogHeader>
							<DialogTitle>Pick date &amp; time</DialogTitle>
							<DialogDescription>The conversation comes back to your inbox then.</DialogDescription>
						</DialogHeader>
						<div className="grid grid-cols-2 gap-3">
							<div className="grid gap-1.5">
								<FieldLabel htmlFor="snooze-date">Date</FieldLabel>
								<Input id="snooze-date" type="date" min={localDate(new Date())} value={date} onChange={(e) => setDate(e.target.value)} />
							</div>
							<div className="grid gap-1.5">
								<FieldLabel htmlFor="snooze-time">Time</FieldLabel>
								<Input id="snooze-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
							</div>
						</div>
						{!customValid && <p className="text-sm text-destructive">Pick a time in the future.</p>}
						<DialogFooter>
							<Button type="button" variant="ghost" onClick={() => setPicking(false)}>
								Cancel
							</Button>
							<Button type="submit" disabled={!customValid}>
								Save
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}
