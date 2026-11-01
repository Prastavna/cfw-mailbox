import { useVirtualizer } from "@tanstack/react-virtual";
import { Paperclip, RefreshCw, Star } from "lucide-react";
import { useEffect, useRef } from "react";
import { Link } from "react-router";
import type { Label, ThreadSummary } from "../../../shared/api";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { useMediaQuery } from "~/hooks/use-media-query";
import { useThreads } from "~/lib/api";
import { visibleLabelChips } from "~/lib/folders";
import { formatListDate, participantsLabel } from "~/lib/format";
import { cn } from "~/lib/utils";

interface ThreadListProps {
	mailboxId: string;
	mailboxAddress: string;
	folderSegment: string;
	labelId: string;
	folderName: string;
	labels: Label[] | undefined;
}

const ROW_HEIGHT = 40;
const ROW_HEIGHT_MOBILE = 76;

export function ThreadList({ mailboxId, mailboxAddress, folderSegment, labelId, folderName, labels }: ThreadListProps) {
	const query = useThreads(mailboxId, labelId);
	const threads = query.data?.pages.flatMap((p) => p.threads) ?? [];
	const scrollRef = useRef<HTMLDivElement>(null);
	const mobile = useMediaQuery("(max-width: 767px)");

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

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex h-12 shrink-0 items-center gap-1 border-b px-2">
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
				<span className="text-muted-foreground ml-auto pr-2 text-xs tabular-nums">
					{threads.length > 0 && `1–${threads.length}${query.hasNextPage ? " of many" : ""}`}
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
}

function ThreadRow({ thread, href, me, chips }: RowProps) {
	const starred = thread.labelIds.includes("STARRED");
	const sender = participantsLabel(thread.participants, me);
	const date = formatListDate(thread.lastMessageAt);
	const subject = thread.subject || "(no subject)";

	return (
		<Link
			to={href}
			className={cn(
				"group relative flex h-full items-center gap-3 border-b px-4 text-sm outline-none transition-shadow",
				"hover:z-10 hover:shadow-[inset_1px_0_0_#dadce0,inset_-1px_0_0_#dadce0,0_1px_2px_0_rgba(60,64,67,.3),0_1px_3px_1px_rgba(60,64,67,.15)]",
				"focus-visible:bg-mail-active/50",
				thread.unread ? "bg-mail-surface font-semibold" : "bg-mail-row-read text-foreground/80",
			)}
			aria-label={`${thread.unread ? "Unread, " : ""}${sender}, ${subject}, ${date}`}
		>
			<Star
				className={cn("size-4 shrink-0", starred ? "fill-amber-400 text-amber-400" : "text-transparent max-md:hidden")}
				aria-hidden
			/>

			{/* Desktop: one line, Gmail style. */}
			<span className="hidden w-[200px] shrink-0 truncate md:block">
				{sender}
				{thread.messageCount > 1 && <span className="ml-1 text-xs font-normal text-muted-foreground">{thread.messageCount}</span>}
			</span>
			<span className="hidden min-w-0 flex-1 items-center gap-1.5 md:flex">
				{chips.map((c) => (
					<Badge key={c.id} variant="secondary" className="h-5 shrink-0 rounded px-1.5 text-[11px] font-normal">
						{c.name}
					</Badge>
				))}
				<span className="truncate">
					{subject}
					<span className="font-normal text-muted-foreground"> - {thread.snippet}</span>
				</span>
			</span>
			{thread.hasAttachments && <Paperclip className="hidden size-4 shrink-0 text-muted-foreground md:block" aria-label="Has attachments" />}
			<span className={cn("hidden w-16 shrink-0 text-right text-xs tabular-nums md:block", !thread.unread && "font-normal")}>{date}</span>

			{/* Mobile: stacked. */}
			<span className="flex min-w-0 flex-1 flex-col gap-0.5 md:hidden">
				<span className="flex items-baseline gap-2">
					<span className="flex-1 truncate">
						{sender}
						{thread.messageCount > 1 && <span className="ml-1 text-xs font-normal text-muted-foreground">{thread.messageCount}</span>}
					</span>
					<span className={cn("shrink-0 text-xs", !thread.unread && "font-normal")}>{date}</span>
				</span>
				<span className="truncate">{subject}</span>
				<span className="flex items-center gap-2 font-normal text-muted-foreground">
					<span className="flex-1 truncate">{thread.snippet}</span>
					{thread.hasAttachments && <Paperclip className="size-3.5 shrink-0" aria-label="Has attachments" />}
					{starred && <Star className="size-3.5 shrink-0 fill-amber-400 text-amber-400" aria-label="Starred" />}
				</span>
			</span>
		</Link>
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
