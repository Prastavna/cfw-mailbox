import { useVirtualizer } from "@tanstack/react-virtual";
import { Archive, ChevronDown, Inbox, Mail, MailOpen, Paperclip, RefreshCw, Star, Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import type { Label, ThreadDetail, ThreadSummary } from "../../../shared/api";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "~/components/ui/dropdown-menu";
import { Skeleton } from "~/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { useMediaQuery } from "~/hooks/use-media-query";
import { Actions, type MailActions } from "~/lib/actions";
import { apiFetch, queryKeys, useThreads } from "~/lib/api";
import type { Composer } from "~/lib/compose-store";
import { visibleLabelChips } from "~/lib/folders";
import { formatListDate, participantsLabel } from "~/lib/format";
import { cn } from "~/lib/utils";
import { ActionBar } from "./ActionBar";

interface ThreadListProps {
	mailboxId: string;
	mailboxAddress: string;
	folderSegment: string;
	labelId: string;
	folderName: string;
	labels: Label[] | undefined;
	actions: MailActions;
	composer: Composer;
}

const ROW_HEIGHT = 40;
const ROW_HEIGHT_MOBILE = 76;

type SelectPreset = "all" | "none" | "read" | "unread" | "starred" | "unstarred";

export function ThreadList({ mailboxId, mailboxAddress, folderSegment, labelId, folderName, labels, actions, composer }: ThreadListProps) {
	const query = useThreads(mailboxId, labelId);
	const queryClient = useQueryClient();

	// A conversation that is only a draft opens in a compose window, like Gmail.
	const openDraft = async (thread: ThreadSummary) => {
		try {
			const detail = await queryClient.fetchQuery({
				queryKey: queryKeys.thread(mailboxId, thread.id),
				queryFn: () => apiFetch<ThreadDetail>(`/mailboxes/${mailboxId}/threads/${thread.id}`),
			});
			const draft = detail.messages.find((m) => m.labelIds.includes("DRAFT"));
			if (draft) composer.openDraft(draft.id, draft.subject || "New Message");
		} catch (err) {
			toast.error(`Couldn't open the draft: ${(err as Error).message}`);
		}
	};
	const threads = useMemo(() => query.data?.pages.flatMap((p) => p.threads) ?? [], [query.data]);
	const scrollRef = useRef<HTMLDivElement>(null);
	const mobile = useMediaQuery("(max-width: 767px)");
	const [selected, setSelected] = useState<Set<string>>(new Set());

	// Drop selections for threads that left the list (archived, deleted elsewhere…).
	useEffect(() => {
		setSelected((prev) => {
			const present = new Set(threads.map((t) => t.id));
			const next = new Set([...prev].filter((id) => present.has(id)));
			return next.size === prev.size ? prev : next;
		});
	}, [threads]);

	const virtualizer = useVirtualizer({
		count: threads.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => (mobile ? ROW_HEIGHT_MOBILE : ROW_HEIGHT),
		overscan: 10,
	});
	useEffect(() => virtualizer.measure(), [mobile, virtualizer]);

	// Load the next page as the user nears the bottom.
	const items = virtualizer.getVirtualItems();
	const lastIndex = items.at(-1)?.index ?? -1;
	useEffect(() => {
		if (lastIndex >= threads.length - 10 && query.hasNextPage && !query.isFetchingNextPage) query.fetchNextPage();
	}, [lastIndex, threads.length, query]);

	const selectedThreads = threads.filter((t) => selected.has(t.id));
	const allSelected = threads.length > 0 && selectedThreads.length === threads.length;

	const select = (preset: SelectPreset) => {
		const match: Record<SelectPreset, (t: ThreadSummary) => boolean> = {
			all: () => true,
			none: () => false,
			read: (t) => !t.unread,
			unread: (t) => t.unread,
			starred: (t) => t.labelIds.includes("STARRED"),
			unstarred: (t) => !t.labelIds.includes("STARRED"),
		};
		setSelected(new Set(threads.filter(match[preset]).map((t) => t.id)));
	};

	const toggle = (id: string, on: boolean) =>
		setSelected((prev) => {
			const next = new Set(prev);
			if (on) next.add(id);
			else next.delete(id);
			return next;
		});

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex h-12 shrink-0 items-center gap-1 border-b px-2">
				<div className="flex items-center rounded-md pl-2 hover:bg-mail-hover">
					<Checkbox
						checked={allSelected ? true : selectedThreads.length ? "indeterminate" : false}
						onCheckedChange={(c) => select(c === true ? "all" : "none")}
						aria-label={allSelected ? "Deselect all" : "Select all"}
						disabled={threads.length === 0}
					/>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button variant="ghost" size="icon-xs" aria-label="Select…" disabled={threads.length === 0}>
								<ChevronDown className="size-3" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start">
							{(["all", "none", "read", "unread", "starred", "unstarred"] as const).map((p) => (
								<DropdownMenuItem key={p} onSelect={() => select(p)} className="capitalize">
									{p}
								</DropdownMenuItem>
							))}
						</DropdownMenuContent>
					</DropdownMenu>
				</div>

				{selectedThreads.length > 0 ? (
					<ActionBar
						targets={selectedThreads}
						currentLabelId={labelId}
						labels={labels}
						actions={actions}
						onDone={(effect) => effect === "removed" && setSelected(new Set())}
					/>
				) : (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								className="rounded-full"
								aria-label="Refresh"
								onClick={() => query.refetch()}
								disabled={query.isFetching}
							>
								<RefreshCw className={cn("size-4", query.isFetching && "animate-spin")} />
							</Button>
						</TooltipTrigger>
						<TooltipContent>Refresh</TooltipContent>
					</Tooltip>
				)}

				<span className="text-muted-foreground ml-auto pr-2 text-xs tabular-nums">
					{selectedThreads.length > 0
						? `${selectedThreads.length} selected`
						: threads.length > 0 && `1–${threads.length}${query.hasNextPage ? " of many" : ""}`}
				</span>
			</div>

			{query.isPending ? (
				<ListSkeleton />
			) : query.isError ? (
				<p className="p-8 text-center text-sm text-destructive">Couldn't load conversations: {query.error.message}</p>
			) : threads.length === 0 ? (
				<p className="text-muted-foreground p-10 text-center text-sm">
					{labelId === "INBOX" ? "Your inbox is empty." : `No conversations in ${folderName}.`}
				</p>
			) : (
				<div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto" role="list" aria-label={`${folderName} conversations`}>
					<div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
						{items.map((item) => {
							const thread = threads[item.index]!;
							return (
								<div
									key={thread.id}
									role="listitem"
									style={{ position: "absolute", top: 0, left: 0, right: 0, height: item.size, transform: `translateY(${item.start}px)` }}
								>
									<ThreadRow
										thread={thread}
										href={`/mail/${mailboxId}/${folderSegment}/${thread.id}`}
										me={mailboxAddress}
										chips={visibleLabelChips(thread.labelIds, labels, labelId)}
										selected={selected.has(thread.id)}
										onSelect={(on) => toggle(thread.id, on)}
										labelId={labelId}
										actions={actions}
										onOpenDraft={thread.messageCount === 1 && thread.labelIds.includes("DRAFT") ? () => void openDraft(thread) : undefined}
									/>
								</div>
							);
						})}
					</div>
					{query.isFetchingNextPage && <p className="text-muted-foreground py-3 text-center text-xs">Loading more…</p>}
				</div>
			)}
		</div>
	);
}

interface RowProps {
	thread: ThreadSummary;
	href: string;
	me: string;
	chips: { id: string; name: string; color: string | null }[];
	selected: boolean;
	onSelect: (selected: boolean) => void;
	labelId: string;
	actions: MailActions;
	/** Set for draft-only conversations: clicking opens the composer instead of the thread. */
	onOpenDraft?: () => void;
}

function RowIconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					onClick={(e) => {
						e.preventDefault();
						e.stopPropagation();
						onClick();
					}}
					className="flex size-8 items-center justify-center rounded-full text-foreground/70 hover:bg-mail-hover hover:text-foreground"
					aria-label={label}
				>
					{children}
				</button>
			</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}

function ThreadRow({ thread, href, me, chips, selected, onSelect, labelId, actions, onOpenDraft }: RowProps) {
	const starred = thread.labelIds.includes("STARRED");
	const hasDraft = thread.labelIds.includes("DRAFT");
	const sending = thread.labelIds.includes("OUTBOX");
	const draftOnly = !!onOpenDraft;
	const sender = draftOnly ? "" : participantsLabel(thread.participants, me);
	const senderCell = (
		<>
			{sender}
			{!draftOnly && thread.messageCount > 1 && <span className="ml-1 text-xs font-normal text-muted-foreground">{thread.messageCount}</span>}
			{hasDraft && <span className={cn("font-normal text-destructive", !draftOnly && "ml-1")}>{draftOnly ? "Draft" : ", Draft"}</span>}
			{sending && <span className="ml-1 font-normal text-muted-foreground">Sending…</span>}
		</>
	);
	const date = formatListDate(thread.lastMessageAt);
	const subject = thread.subject || "(no subject)";
	const inTrashOrSpam = labelId === "TRASH" || labelId === "SPAM";
	const ids = [thread.id];

	const star = (
		<button
			type="button"
			onClick={(e) => {
				e.preventDefault();
				actions.modify(ids, starred ? Actions.unstar : Actions.star);
			}}
			className="flex size-6 shrink-0 items-center justify-center rounded-full hover:bg-mail-hover"
			aria-label={starred ? "Starred" : "Not starred"}
			aria-pressed={starred}
		>
			<Star className={cn("size-4", starred ? "fill-amber-400 text-amber-400" : "text-muted-foreground/60")} />
		</button>
	);

	return (
		<div
			className={cn(
				"group relative flex h-full items-center border-b text-sm transition-shadow",
				"hover:z-10 hover:shadow-[inset_1px_0_0_#dadce0,inset_-1px_0_0_#dadce0,0_1px_2px_0_rgba(60,64,67,.3),0_1px_3px_1px_rgba(60,64,67,.15)]",
				selected ? "bg-mail-active/60" : thread.unread ? "bg-mail-surface" : "bg-mail-row-read",
				thread.unread ? "font-semibold" : "text-foreground/80",
			)}
		>
			<div className="flex shrink-0 items-center gap-1 pl-2">
				<Checkbox
					checked={selected}
					onCheckedChange={(c) => onSelect(c === true)}
					aria-label={`Select conversation: ${subject}`}
					className="mx-1.5"
				/>
				<span className="hidden md:block">{star}</span>
			</div>

			<Link
				to={href}
				onClick={(e) => {
					if (!onOpenDraft || e.metaKey || e.ctrlKey || e.shiftKey) return;
					e.preventDefault();
					onOpenDraft();
				}}
				className="flex h-full min-w-0 flex-1 items-center gap-3 pr-4 pl-2 outline-none focus-visible:bg-mail-active/50"
				aria-label={`${thread.unread ? "Unread, " : ""}${draftOnly ? "Draft" : sender}${hasDraft && !draftOnly ? ", Draft" : ""}, ${subject}, ${date}`}
			>
				{/* Desktop: one line, Gmail style. */}
				<span className="hidden w-[180px] shrink-0 truncate md:block">{senderCell}</span>
				<span className="hidden min-w-0 flex-1 items-center gap-1.5 md:flex">
					{chips.map((c) => (
						<Badge
							key={c.id}
							variant="secondary"
							className="h-5 shrink-0 rounded px-1.5 text-[11px] font-normal"
							style={c.color ? { backgroundColor: c.color, color: "#fff" } : undefined}
						>
							{c.name}
						</Badge>
					))}
					<span className="truncate">
						{subject}
						<span className="font-normal text-muted-foreground"> - {thread.snippet}</span>
					</span>
				</span>
				{thread.hasAttachments && <Paperclip className="hidden size-4 shrink-0 text-muted-foreground md:block" aria-label="Has attachments" />}
				<span className={cn("hidden w-16 shrink-0 text-right text-xs tabular-nums md:block md:group-hover:invisible", !thread.unread && "font-normal")}>
					{date}
				</span>

				{/* Mobile: stacked. */}
				<span className="flex min-w-0 flex-1 flex-col gap-0.5 md:hidden">
					<span className="flex items-baseline gap-2">
						<span className="flex-1 truncate">{senderCell}</span>
						<span className={cn("shrink-0 text-xs", !thread.unread && "font-normal")}>{date}</span>
					</span>
					<span className="truncate">{subject}</span>
					<span className="flex items-center gap-2 font-normal text-muted-foreground">
						<span className="flex-1 truncate">{thread.snippet}</span>
						{thread.hasAttachments && <Paperclip className="size-3.5 shrink-0" aria-label="Has attachments" />}
					</span>
				</span>
			</Link>
			<span className="pr-2 md:hidden">{star}</span>

			{/* Gmail's hover actions replace the date. */}
			<div className="absolute top-0 right-2 hidden h-full items-center bg-inherit md:group-hover:flex">
				{!inTrashOrSpam &&
					(thread.labelIds.includes("INBOX") ? (
						<RowIconButton label="Archive" onClick={() => actions.modify(ids, Actions.archive, { message: "Conversation archived." })}>
							<Archive className="size-4" />
						</RowIconButton>
					) : (
						<RowIconButton label="Move to Inbox" onClick={() => actions.modify(ids, Actions.moveToInbox, { message: "Conversation moved to Inbox." })}>
							<Inbox className="size-4" />
						</RowIconButton>
					))}
				{!inTrashOrSpam && (
					<RowIconButton label="Delete" onClick={() => actions.modify(ids, Actions.trash, { message: "Conversation moved to Trash." })}>
						<Trash2 className="size-4" />
					</RowIconButton>
				)}
				{thread.unread ? (
					<RowIconButton label="Mark as read" onClick={() => actions.modify(ids, Actions.markRead)}>
						<MailOpen className="size-4" />
					</RowIconButton>
				) : (
					<RowIconButton label="Mark as unread" onClick={() => actions.modify(ids, Actions.markUnread)}>
						<Mail className="size-4" />
					</RowIconButton>
				)}
			</div>
		</div>
	);
}

function ListSkeleton() {
	return (
		<div className="flex flex-col" aria-busy aria-label="Loading conversations">
			{Array.from({ length: 12 }, (_, i) => (
				<div key={i} className="flex h-10 items-center gap-4 border-b px-4">
					<Skeleton className="h-3 w-40" />
					<Skeleton className="h-3 flex-1" />
					<Skeleton className="h-3 w-12" />
				</div>
			))}
		</div>
	);
}
