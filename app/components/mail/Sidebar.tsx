import { BookUser, EllipsisVertical, Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import type { Label } from "../../../shared/api";
import { Button } from "~/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "~/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import type { MailActions } from "~/lib/actions";
import { SYSTEM_FOLDERS, UserLabelIcon } from "~/lib/folders";
import { cn } from "~/lib/utils";
import { ConfirmDialog, LabelDialog } from "./LabelDialog";

interface SidebarProps {
	mailboxId: string;
	labels: Label[] | undefined;
	collapsed: boolean;
	actions: MailActions;
	onNavigate?: () => void;
	onCompose: () => void;
}

function countFor(label: Label | undefined, mode: "unread" | "total" | "none"): number {
	if (!label || mode === "none") return 0;
	return mode === "unread" ? label.unread : label.total;
}

export function Sidebar({ mailboxId, labels, collapsed, actions, onNavigate, onCompose }: SidebarProps) {
	const userLabels = labels?.filter((l) => l.type === "user") ?? [];
	const [dialog, setDialog] = useState<{ mode: "create" } | { mode: "edit"; label: Label } | null>(null);
	const [removing, setRemoving] = useState<Label | null>(null);
	const navigate = useNavigate();
	const { folder } = useParams();

	const item = (to: string, name: string, Icon: typeof UserLabelIcon, count: number, opts: { color?: string | null; menu?: React.ReactNode } = {}) => {
		const link = (
			<NavLink
				to={to}
				onClick={onNavigate}
				className={({ isActive }) =>
					cn(
						"flex h-8 items-center gap-4 rounded-r-full pr-3 text-sm text-foreground/90 transition-colors",
						collapsed ? "w-12 justify-center rounded-full px-0" : "pl-6",
						opts.menu && !collapsed && "pr-9",
						isActive ? "bg-mail-active font-semibold text-mail-active-foreground" : "hover:bg-mail-hover",
						count > 0 && "font-semibold",
					)
				}
			>
				<Icon className="size-[18px] shrink-0" style={opts.color ? { color: opts.color, fill: opts.color } : undefined} aria-hidden />
				{!collapsed && (
					<>
						<span className="flex-1 truncate">{name}</span>
						{count > 0 && <span className="text-xs tabular-nums">{count.toLocaleString()}</span>}
					</>
				)}
				{collapsed && <span className="sr-only">{name}</span>}
			</NavLink>
		);
		if (!collapsed) {
			return (
				<div key={to} className="group relative">
					{link}
					{opts.menu}
				</div>
			);
		}
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

	const labelMenu = (label: Label) => (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon-sm"
					className="absolute top-0.5 right-1 rounded-full opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
					aria-label={`Options for ${label.name}`}
				>
					<EllipsisVertical className="size-4" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" side="right">
				<DropdownMenuItem onSelect={() => setDialog({ mode: "edit", label })}>Edit</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => setRemoving(label)} variant="destructive">
					Remove label
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);

	return (
		<nav aria-label="Folders" className={cn("flex h-full flex-col gap-1 py-2", collapsed ? "items-center px-2" : "pr-3")}>
			<div className={cn("mb-3", collapsed ? "" : "pl-2")}>
				<Button
					onClick={onCompose}
					aria-label="Compose"
					className={cn(
						"h-14 rounded-2xl bg-mail-compose text-mail-active-foreground shadow-none hover:bg-mail-compose/80 hover:shadow-md",
						collapsed ? "w-14 px-0" : "gap-3 px-5 text-sm",
					)}
				>
					<Pencil className="size-5" aria-hidden />
					{!collapsed && "Compose"}
				</Button>
			</div>

			{SYSTEM_FOLDERS.map((f) =>
				item(`/mail/${mailboxId}/${f.slug}`, f.name, f.icon, countFor(labels?.find((l) => l.id === f.labelId), f.count)),
			)}

			{!collapsed && (
				<div className="mt-4 mb-1 flex items-center justify-between pr-1 pl-6">
					<h2 className="text-sm font-medium">Labels</h2>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button variant="ghost" size="icon-sm" className="rounded-full" onClick={() => setDialog({ mode: "create" })} aria-label="Create new label">
								<Plus className="size-4" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>Create new label</TooltipContent>
					</Tooltip>
				</div>
			)}
			{userLabels.map((l) =>
				item(`/mail/${mailboxId}/${l.id}`, l.name, UserLabelIcon, l.unread, { color: l.color, menu: labelMenu(l) }),
			)}

			<div className={cn("mt-4 border-t pt-3", collapsed && "w-12")}>{item(`/mail/${mailboxId}/contacts`, "Contacts", BookUser, 0)}</div>

			<LabelDialog
				open={dialog !== null}
				onOpenChange={(open) => !open && setDialog(null)}
				label={dialog?.mode === "edit" ? dialog.label : undefined}
				onSubmit={async (input) => {
					if (dialog?.mode === "edit") await actions.updateLabel(dialog.label.id, input);
					else await actions.createLabel(input);
				}}
			/>
			<ConfirmDialog
				open={removing !== null}
				onOpenChange={(open) => !open && setRemoving(null)}
				title={`Remove "${removing?.name}"?`}
				description="The label is removed from every conversation. The conversations themselves aren't deleted."
				confirmLabel="Remove"
				onConfirm={async () => {
					const label = removing!;
					try {
						await actions.deleteLabel(label.id);
						toast(`Label "${label.name}" removed.`);
						if (folder === label.id) navigate(`/mail/${mailboxId}/inbox`);
					} catch (err) {
						toast.error(`Couldn't remove label: ${(err as Error).message}`);
					}
				}}
			/>
		</nav>
	);
}
