import { Pencil } from "lucide-react";
import { NavLink } from "react-router";
import { cn } from "~/lib/utils";
import type { Label } from "../../../shared/api";
import { SYSTEM_FOLDERS, UserLabelIcon } from "~/lib/folders";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";

interface SidebarProps {
	mailboxId: string;
	labels: Label[] | undefined;
	collapsed: boolean;
	onNavigate?: () => void;
}

function countFor(label: Label | undefined, mode: "unread" | "total" | "none"): number {
	if (!label || mode === "none") return 0;
	return mode === "unread" ? label.unread : label.total;
}

export function Sidebar({ mailboxId, labels, collapsed, onNavigate }: SidebarProps) {
	const userLabels = labels?.filter((l) => l.type === "user") ?? [];

	const item = (to: string, name: string, Icon: typeof UserLabelIcon, count: number, color?: string | null) => {
		const link = (
			<NavLink
				key={to}
				to={to}
				onClick={onNavigate}
				className={({ isActive }) =>
					cn(
						"flex h-8 items-center gap-4 rounded-r-full pr-3 text-sm text-foreground/90 transition-colors",
						collapsed ? "w-12 justify-center rounded-full px-0" : "pl-6",
						isActive
							? "bg-mail-active font-semibold text-mail-active-foreground"
							: "hover:bg-mail-hover",
						count > 0 && "font-semibold",
					)
				}
			>
				<Icon className="size-[18px] shrink-0" style={color ? { color } : undefined} aria-hidden />
				{!collapsed && (
					<>
						<span className="flex-1 truncate">{name}</span>
						{count > 0 && <span className="text-xs tabular-nums">{count.toLocaleString()}</span>}
					</>
				)}
				{collapsed && <span className="sr-only">{name}</span>}
			</NavLink>
		);
		if (!collapsed) return link;
		return (
			<Tooltip key={to}>
				{/* Wrapped: TooltipTrigger's Slot can't merge NavLink's function className. */}
				<TooltipTrigger asChild>
					<span className="block">{link}</span>
				</TooltipTrigger>
				<TooltipContent side="right">
					{name}
					{count > 0 ? ` (${count})` : ""}
				</TooltipContent>
			</Tooltip>
		);
	};

	return (
		<nav aria-label="Folders" className={cn("flex h-full flex-col gap-1 py-2", collapsed ? "items-center px-2" : "pr-3")}>
			<div className={cn("mb-3", collapsed ? "" : "pl-2")}>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							disabled
							className={cn(
								"h-14 rounded-2xl bg-mail-compose text-mail-active-foreground shadow-none hover:bg-mail-compose/80",
								collapsed ? "w-14 px-0" : "gap-3 px-5 text-sm",
							)}
						>
							<Pencil className="size-5" aria-hidden />
							{!collapsed && "Compose"}
						</Button>
					</TooltipTrigger>
					<TooltipContent side="right">Writing mail arrives in a later update</TooltipContent>
				</Tooltip>
			</div>

			{SYSTEM_FOLDERS.map((f) =>
				item(`/mail/${mailboxId}/${f.slug}`, f.name, f.icon, countFor(labels?.find((l) => l.id === f.labelId), f.count)),
			)}

			{userLabels.length > 0 && (
				<>
					{!collapsed && <h2 className="mt-4 mb-1 pl-6 text-sm font-medium">Labels</h2>}
					{userLabels.map((l) => item(`/mail/${mailboxId}/${l.id}`, l.name, UserLabelIcon, l.unread, l.color))}
				</>
			)}
		</nav>
	);
}
