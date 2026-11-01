import {
	AlertOctagon,
	Archive,
	EllipsisVertical,
	FolderInput,
	Inbox,
	Mail,
	MailOpen,
	Plus,
	Star,
	StarOff,
	Tag,
	Tags,
	Trash2,
} from "lucide-react";
import { useState } from "react";
import type { Label } from "../../../shared/api";
import { Button } from "~/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { Actions, type LabelDelta, type MailActions } from "~/lib/actions";
import { ConfirmDialog, LabelDialog } from "./LabelDialog";

export interface ActionTarget {
	id: string;
	labelIds: string[];
	unread: boolean;
}

interface ActionBarProps {
	targets: ActionTarget[];
	/** The list being viewed (INBOX, TRASH, a user label ID, ALL, …). */
	currentLabelId: string;
	labels: Label[] | undefined;
	actions: MailActions;
	/** "removed" when the targets leave the current view (archive, delete, move…). */
	onDone?: (effect: Effect) => void;
}

function IconAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button variant="ghost" size="icon" className="rounded-full" onClick={onClick} aria-label={label}>
					{children}
				</Button>
			</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}

type Effect = "removed" | "changed" | "markedUnread";

const plural = (n: number, one: string) => (n === 1 ? `Conversation ${one}.` : `${n} conversations ${one}.`);

/** Archive / spam / delete / read / move / label buttons for the selected threads or the open thread. */
export function ActionBar({ targets, currentLabelId, labels, actions, onDone }: ActionBarProps) {
	const [creatingLabel, setCreatingLabel] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const ids = targets.map((t) => t.id);
	const n = ids.length;
	const userLabels = labels?.filter((l) => l.type === "user") ?? [];
	const inTrash = currentLabelId === "TRASH";
	const inSpam = currentLabelId === "SPAM";
	const anyInInbox = targets.some((t) => t.labelIds.includes("INBOX"));
	const anyUnread = targets.some((t) => t.unread);
	const allStarred = targets.every((t) => t.labelIds.includes("STARRED"));
	const allImportant = targets.every((t) => t.labelIds.includes("IMPORTANT"));

	const run = async (delta: LabelDelta, message: string, effect: Effect) => {
		if (await actions.modify(ids, delta, { message })) onDone?.(effect);
	};

	/** Gmail's "Move to": add the target, drop the label we're viewing (if it's a folder-like one). */
	const moveTo = (target: string, name: string) => {
		if (target === "TRASH") return run(Actions.trash, plural(n, "moved to Trash"), "removed");
		if (target === "SPAM") return run(Actions.spam, plural(n, "marked as spam"), "removed");
		const leaving = currentLabelId === "INBOX" || userLabels.some((l) => l.id === currentLabelId) ? [currentLabelId] : [];
		return run(
			{ add: [target], remove: [...leaving, "TRASH", "SPAM"].filter((l) => l !== target) },
			plural(n, `moved to ${name}`),
			"removed",
		);
	};

	const toggleLabel = (label: Label, checked: boolean) =>
		actions.modify(ids, checked ? { add: [label.id] } : { remove: [label.id] }, {
			message: checked ? plural(n, `added to "${label.name}"`) : plural(n, `removed from "${label.name}"`),
		});

	const labelState = (id: string): boolean | "indeterminate" => {
		const count = targets.filter((t) => t.labelIds.includes(id)).length;
		return count === 0 ? false : count === n ? true : "indeterminate";
	};

	if (n === 0) return null;

	return (
		<div className="flex items-center gap-0.5">
			{inTrash || inSpam ? (
				<>
					{inSpam ? (
						<Button variant="ghost" size="sm" onClick={() => run(Actions.notSpam, plural(n, "moved to Inbox"), "removed")}>
							Not spam
						</Button>
					) : (
						<IconAction label="Move to Inbox" onClick={() => run(Actions.moveToInbox, plural(n, "moved to Inbox"), "removed")}>
							<Inbox className="size-4" />
						</IconAction>
					)}
					<Button variant="ghost" size="sm" onClick={() => setConfirmDelete(true)}>
						Delete forever
					</Button>
				</>
			) : (
				<>
					{anyInInbox ? (
						<IconAction label="Archive" onClick={() => run(Actions.archive, plural(n, "archived"), "removed")}>
							<Archive className="size-4" />
						</IconAction>
					) : (
						<IconAction label="Move to Inbox" onClick={() => run(Actions.moveToInbox, plural(n, "moved to Inbox"), currentLabelId === "ALL" ? "changed" : "removed")}>
							<Inbox className="size-4" />
						</IconAction>
					)}
					<IconAction label="Report spam" onClick={() => run(Actions.spam, plural(n, "marked as spam"), "removed")}>
						<AlertOctagon className="size-4" />
					</IconAction>
					<IconAction label="Delete" onClick={() => run(Actions.trash, plural(n, "moved to Trash"), "removed")}>
						<Trash2 className="size-4" />
					</IconAction>
				</>
			)}

			<span className="mx-1 h-5 w-px bg-border" aria-hidden />

			{anyUnread ? (
				<IconAction label="Mark as read" onClick={() => run(Actions.markRead, "", "changed")}>
					<MailOpen className="size-4" />
				</IconAction>
			) : (
				<IconAction label="Mark as unread" onClick={() => run(Actions.markUnread, "", "markedUnread")}>
					<Mail className="size-4" />
				</IconAction>
			)}

			<DropdownMenu>
				<Tooltip>
					<TooltipTrigger asChild>
						<DropdownMenuTrigger asChild>
							<Button variant="ghost" size="icon" className="rounded-full" aria-label="Move to">
								<FolderInput className="size-4" />
							</Button>
						</DropdownMenuTrigger>
					</TooltipTrigger>
					<TooltipContent>Move to</TooltipContent>
				</Tooltip>
				<DropdownMenuContent align="start" className="w-56">
					<DropdownMenuLabel>Move to:</DropdownMenuLabel>
					{currentLabelId !== "INBOX" && <DropdownMenuItem onSelect={() => moveTo("INBOX", "Inbox")}>Inbox</DropdownMenuItem>}
					{userLabels
						.filter((l) => l.id !== currentLabelId)
						.map((l) => (
							<DropdownMenuItem key={l.id} onSelect={() => moveTo(l.id, l.name)}>
								<Tag className="size-4" style={l.color ? { color: l.color } : undefined} /> {l.name}
							</DropdownMenuItem>
						))}
					<DropdownMenuSeparator />
					{!inSpam && <DropdownMenuItem onSelect={() => moveTo("SPAM", "Spam")}>Spam</DropdownMenuItem>}
					{!inTrash && <DropdownMenuItem onSelect={() => moveTo("TRASH", "Trash")}>Trash</DropdownMenuItem>}
				</DropdownMenuContent>
			</DropdownMenu>

			<DropdownMenu>
				<Tooltip>
					<TooltipTrigger asChild>
						<DropdownMenuTrigger asChild>
							<Button variant="ghost" size="icon" className="rounded-full" aria-label="Labels">
								<Tags className="size-4" />
							</Button>
						</DropdownMenuTrigger>
					</TooltipTrigger>
					<TooltipContent>Labels</TooltipContent>
				</Tooltip>
				<DropdownMenuContent align="start" className="w-56">
					<DropdownMenuLabel>Label as:</DropdownMenuLabel>
					{userLabels.length === 0 && <p className="text-muted-foreground px-2 py-1 text-sm">No labels yet</p>}
					{userLabels.map((l) => (
						<DropdownMenuCheckboxItem
							key={l.id}
							checked={labelState(l.id)}
							onSelect={(e) => e.preventDefault()}
							onCheckedChange={(checked) => toggleLabel(l, checked === true)}
						>
							<Tag className="size-4" style={l.color ? { color: l.color } : undefined} /> {l.name}
						</DropdownMenuCheckboxItem>
					))}
					<DropdownMenuSeparator />
					<DropdownMenuItem onSelect={() => setCreatingLabel(true)}>
						<Plus className="size-4" /> Create new
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>

			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button variant="ghost" size="icon" className="rounded-full" aria-label="More actions">
						<EllipsisVertical className="size-4" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start">
					{allImportant ? (
						<DropdownMenuItem onSelect={() => run(Actions.notImportant, plural(n, "marked as not important"), "changed")}>
							Mark as not important
						</DropdownMenuItem>
					) : (
						<DropdownMenuItem onSelect={() => run(Actions.important, plural(n, "marked as important"), "changed")}>
							Mark as important
						</DropdownMenuItem>
					)}
					{allStarred ? (
						<DropdownMenuItem onSelect={() => run(Actions.unstar, "", "changed")}>
							<StarOff className="size-4" /> Remove star
						</DropdownMenuItem>
					) : (
						<DropdownMenuItem onSelect={() => run(Actions.star, "", "changed")}>
							<Star className="size-4" /> Add star
						</DropdownMenuItem>
					)}
				</DropdownMenuContent>
			</DropdownMenu>

			<LabelDialog
				open={creatingLabel}
				onOpenChange={setCreatingLabel}
				onSubmit={async (input) => {
					const label = await actions.createLabel(input);
					await actions.modify(ids, { add: [label.id] }, { message: plural(n, `added to "${label.name}"`) });
				}}
			/>
			<ConfirmDialog
				open={confirmDelete}
				onOpenChange={setConfirmDelete}
				title="Delete forever?"
				description={`${n === 1 ? "This conversation" : `These ${n} conversations`} and ${n === 1 ? "its" : "their"} attachments will be permanently deleted. This can't be undone.`}
				confirmLabel="Delete forever"
				onConfirm={async () => {
					await actions.deleteForever(ids);
					onDone?.("removed");
				}}
			/>
		</div>
	);
}
