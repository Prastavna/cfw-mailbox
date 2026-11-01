import { ArrowLeft, ChevronDown, ChevronUp, EllipsisVertical, FileCode, Forward, Paperclip, Pencil, Reply, ReplyAll, Star, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { Label, MessageDetail } from "../../../shared/api";
import { Avatar, AvatarFallback } from "~/components/ui/avatar";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Skeleton } from "~/components/ui/skeleton";
import { Actions, type MailActions } from "~/lib/actions";
import { type InfiniteData, useQueryClient } from "@tanstack/react-query";
import type { ThreadPage } from "../../../shared/api";
import { queryKeys, rawMessageUrl, useThread } from "~/lib/api";
import { listCursor, useShortcuts } from "~/lib/shortcuts";
import { replyRecipients } from "~/lib/compose";
import { type Composer, draftsApi } from "~/lib/compose-store";
import { visibleLabelChips } from "~/lib/folders";
import {
	avatarColor,
	formatFullDate,
	formatListDate,
	formatMessageDate,
	fullName,
	initial,
	recipientsSummary,
} from "~/lib/format";
import { cn } from "~/lib/utils";
import { ActionBar } from "./ActionBar";
import { AttachmentList } from "./AttachmentList";
import { EmailBody } from "./EmailBody";

interface ThreadViewProps {
	mailboxId: string;
	mailboxAddress: string;
	threadId: string;
	backHref: string;
	currentLabelId: string;
	labels: Label[] | undefined;
	actions: MailActions;
	composer: Composer;
	/** The list this conversation was opened from, for j/k. */
	listKey: string;
	hrefFor: (threadId: string) => string;
}

const isUnsent = (m: MessageDetail) => m.labelIds.includes("DRAFT") || m.labelIds.includes("OUTBOX");

/** How many collapsed messages in the middle of a thread before they fold into "N older messages". */
const FOLD_THRESHOLD = 3;

export function ThreadView({ mailboxId, mailboxAddress, threadId, backHref, currentLabelId, labels, actions, composer, listKey, hrefFor }: ThreadViewProps) {
	const { data, isPending, isError, error } = useThread(mailboxId, threadId);
	const all = data?.messages ?? [];
	// Drafts (and messages waiting to send) sit below the conversation, like Gmail.
	const messages = all.filter((m) => !isUnsent(m));
	const unsent = all.filter(isUnsent);
	const lastMessage = messages.at(-1);
	const canReplyAll = !!lastMessage && replyRecipients(lastMessage, mailboxAddress, true).to.length + replyRecipients(lastMessage, mailboxAddress, true).cc.length > 1;
	const navigate = useNavigate();
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [unfolded, setUnfolded] = useState(false);
	const initialised = useRef<string | null>(null);
	const queryClient = useQueryClient();
	const [snoozeOpen, setSnoozeOpen] = useState(false);

	useEffect(() => {
		listCursor.lastThreadId = threadId;
	}, [threadId]);

	/** j/k: the next older or newer conversation in the list this one came from. */
	const step = (by: number) => {
		const pages = queryClient.getQueryData<InfiniteData<ThreadPage>>(queryKeys.threads(mailboxId, listKey))?.pages;
		const list = pages?.flatMap((p) => p.threads) ?? [];
		const i = list.findIndex((t) => t.id === threadId);
		const next = i >= 0 ? list[i + by] : undefined;
		if (next) navigate(hrefFor(next.id));
	};
	const inTrashOrSpam = currentLabelId === "TRASH" || currentLabelId === "SPAM";
	const back = (ok: boolean) => ok && navigate(backHref);
	useShortcuts(
		{
			u: () => navigate(backHref),
			j: () => step(1),
			k: () => step(-1),
			r: () => lastMessage && void composer.reply(lastMessage),
			a: () => lastMessage && void composer.reply(lastMessage, canReplyAll),
			f: () => lastMessage && void composer.forward(lastMessage),
			e: () => !inTrashOrSpam && void actions.modify([threadId], Actions.archive, { message: "Conversation archived." }).then(back),
			"#": () => currentLabelId !== "TRASH" && void actions.modify([threadId], Actions.trash, { message: "Conversation moved to Trash." }).then(back),
			"!": () => currentLabelId !== "SPAM" && void actions.modify([threadId], Actions.spam, { message: "Conversation marked as spam." }).then(back),
			s: () => data && void actions.modify([threadId], data.thread.labelIds.includes("STARRED") ? Actions.unstar : Actions.star),
			U: () => void actions.modify([threadId], Actions.markUnread).then(back),
			I: () => void actions.modify([threadId], Actions.markRead),
			b: () => !inTrashOrSpam && setSnoozeOpen(true),
		},
		1,
	);

	// Gmail expands the newest message and any unread ones, then marks the conversation read.
	useEffect(() => {
		if (!data || initialised.current === threadId) return;
		initialised.current = threadId;
		const ids = new Set(data.messages.filter((m) => m.labelIds.includes("UNREAD")).map((m) => m.id));
		const last = data.messages.filter((m) => !isUnsent(m)).at(-1);
		if (last) ids.add(last.id);
		setExpanded(ids);
		setUnfolded(false);
		if (data.thread.unread) actions.modify([threadId], Actions.markRead);
	}, [data, threadId, actions]);

	useEffect(() => {
		if (data) document.title = `${data.thread.subject || "(no subject)"} - ${mailboxAddress} - Mail`;
	}, [data, mailboxAddress]);

	const toggle = (id: string) =>
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});

	// A long run of collapsed messages after the first one folds into a single "N" row.
	const firstExpandedAfter = messages.findIndex((m, i) => i > 0 && expanded.has(m.id));
	const foldEnd = firstExpandedAfter === -1 ? messages.length - 1 : firstExpandedAfter;
	const fold = !unfolded && foldEnd - 1 > FOLD_THRESHOLD ? { from: 1, to: foldEnd } : null;

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex h-12 shrink-0 items-center gap-1 border-b px-2">
				<Button variant="ghost" size="icon" className="rounded-full" asChild>
					<Link to={backHref} aria-label="Back to list">
						<ArrowLeft className="size-4" />
					</Link>
				</Button>
				{data && (
					<ActionBar
						targets={[data.thread]}
						currentLabelId={currentLabelId}
						labels={labels}
						actions={actions}
						onDone={(effect) => effect !== "changed" && navigate(backHref)}
						snoozeOpen={snoozeOpen}
						onSnoozeOpenChange={setSnoozeOpen}
					/>
				)}
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto">
				{isPending ? (
					<ThreadSkeleton />
				) : isError ? (
					<p className="p-8 text-center text-sm text-destructive">
						{"status" in error && error.status === 404 ? "This conversation no longer exists." : `Couldn't load: ${error.message}`}
					</p>
				) : (
					<article className="pb-16">
						<header className="flex flex-wrap items-center gap-2 py-5 pr-6 pl-4 sm:pl-[72px]">
							<h1 className="text-[22px] leading-tight">{data.thread.subject || "(no subject)"}</h1>
							{visibleLabelChips(data.thread.labelIds, labels, currentLabelId).map((c) => (
								<Badge key={c.id} variant="secondary" className="rounded px-1.5 text-xs font-normal">
									{c.name}
								</Badge>
							))}
						</header>

						{messages.map((m, i) => {
							if (fold && i >= fold.from && i < fold.to) {
								if (i !== fold.from) return null;
								return (
									<button
										key="fold"
										type="button"
										onClick={() => setUnfolded(true)}
										className="relative flex h-6 w-full items-center border-y text-sm hover:bg-mail-hover"
									>
										<span className="absolute left-4 flex size-9 items-center justify-center rounded-full border bg-mail-surface text-xs sm:left-[22px]">
											{fold.to - fold.from}
										</span>
										<span className="sr-only">Show {fold.to - fold.from} older messages</span>
									</button>
								);
							}
							return (
								<MessageCard
									key={m.id}
									mailboxId={mailboxId}
									me={mailboxAddress}
									message={m}
									expanded={expanded.has(m.id)}
									onToggle={() => toggle(m.id)}
									onToggleStar={() =>
										actions.modifyMessage(m.id, m.labelIds.includes("STARRED") ? Actions.unstar : Actions.star)
									}
									onReply={(all) => void composer.reply(m, all)}
									onForward={() => void composer.forward(m)}
									isLast={i === messages.length - 1 && unsent.length === 0}
								/>
							);
						})}
						{unsent.map((m) => (
							<DraftCard key={m.id} mailboxId={mailboxId} message={m} composer={composer} />
						))}
						{lastMessage && (
							<div className="flex flex-wrap gap-2 px-4 pt-2 sm:pl-[72px]">
								<Button variant="outline" className="rounded-full px-5" onClick={() => void composer.reply(lastMessage)}>
									<Reply aria-hidden /> Reply
								</Button>
								{canReplyAll && (
									<Button variant="outline" className="rounded-full px-5" onClick={() => void composer.reply(lastMessage, true)}>
										<ReplyAll aria-hidden /> Reply all
									</Button>
								)}
								<Button variant="outline" className="rounded-full px-5" onClick={() => void composer.forward(lastMessage)}>
									<Forward aria-hidden /> Forward
								</Button>
							</div>
						)}
					</article>
				)}
			</div>
		</div>
	);
}

interface MessageCardProps {
	mailboxId: string;
	me: string;
	message: MessageDetail;
	expanded: boolean;
	isLast: boolean;
	onToggle: () => void;
	onToggleStar: () => void;
	onReply: (all: boolean) => void;
	onForward: () => void;
}

function MessageCard({ mailboxId, me, message, expanded, isLast, onToggle, onToggleStar, onReply, onForward }: MessageCardProps) {
	const [showDetails, setShowDetails] = useState(false);
	const starred = message.labelIds.includes("STARRED");
	const hasFiles = message.attachments.some((a) => a.disposition === "attachment");

	const avatar = (
		<Avatar className="size-10 shrink-0">
			<AvatarFallback className="text-base font-medium text-white" style={{ backgroundColor: avatarColor(message.from.address) }}>
				{initial(message.from)}
			</AvatarFallback>
		</Avatar>
	);

	if (!expanded) {
		return (
			<button
				type="button"
				onClick={onToggle}
				className="flex w-full items-center gap-3 border-t px-4 py-3 text-left text-sm hover:bg-mail-hover sm:gap-4"
				aria-expanded={false}
			>
				{avatar}
				<span className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-center sm:gap-4">
					<span className="shrink-0 truncate font-semibold sm:w-48">{fullName(message.from, me)}</span>
					<span className="text-muted-foreground truncate">{message.snippet}</span>
				</span>
				{hasFiles && <Paperclip className="size-4 shrink-0 text-muted-foreground" aria-label="Has attachments" />}
				<span className="text-muted-foreground shrink-0 text-xs">{formatListDate(message.sentAt)}</span>
			</button>
		);
	}

	return (
		<div className={cn("border-t px-4 pt-4", isLast ? "pb-4" : "pb-6")}>
			<div className="flex gap-3 sm:gap-4">
				{avatar}
				<div className="min-w-0 flex-1">
					<div className="flex items-start gap-2">
						<button type="button" onClick={onToggle} className="min-w-0 flex-1 text-left" aria-expanded>
							<span className="font-semibold">{fullName(message.from)}</span>
							{message.from.name && <span className="text-muted-foreground ml-1 text-xs">&lt;{message.from.address}&gt;</span>}
						</button>
						<span className="text-muted-foreground hidden shrink-0 text-xs sm:inline" title={formatFullDate(message.sentAt)}>
							{formatMessageDate(message.sentAt)}
						</span>
						<Button
							variant="ghost"
							size="icon-sm"
							className="-mt-1 rounded-full"
							onClick={onToggleStar}
							aria-label={starred ? "Starred" : "Not starred"}
							aria-pressed={starred}
						>
							<Star className={cn("size-4", starred ? "fill-amber-400 text-amber-400" : "text-muted-foreground")} />
						</Button>
						<Button variant="ghost" size="icon-sm" className="-mt-1 rounded-full" onClick={() => onReply(false)} aria-label="Reply">
							<Reply className="size-4" />
						</Button>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button variant="ghost" size="icon-sm" className="-mt-1 rounded-full" aria-label="More">
									<EllipsisVertical className="size-4" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem onSelect={() => onReply(false)}>
									<Reply className="size-4" /> Reply
								</DropdownMenuItem>
								<DropdownMenuItem onSelect={() => onReply(true)}>
									<ReplyAll className="size-4" /> Reply all
								</DropdownMenuItem>
								<DropdownMenuItem onSelect={onForward}>
									<Forward className="size-4" /> Forward
								</DropdownMenuItem>
								{message.hasRaw && (
									<DropdownMenuItem asChild>
										<a href={rawMessageUrl(mailboxId, message.id)} target="_blank" rel="noopener noreferrer">
											<FileCode className="size-4" /> Show original
										</a>
									</DropdownMenuItem>
								)}
							</DropdownMenuContent>
						</DropdownMenu>
					</div>

					<button
						type="button"
						onClick={() => setShowDetails((v) => !v)}
						className="text-muted-foreground flex items-center gap-0.5 text-xs hover:text-foreground"
						aria-expanded={showDetails}
					>
						<span className="truncate">{recipientsSummary(message, me)}</span>
						{showDetails ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
					</button>
					{showDetails && <MessageDetails message={message} />}

					<div className="mt-4">
						<EmailBody mailboxId={mailboxId} message={message} />
						<AttachmentList mailboxId={mailboxId} messageId={message.id} attachments={message.attachments} />
					</div>
				</div>
			</div>
		</div>
	);
}

/** An unsent reply in the conversation: open it in the composer or throw it away. */
function DraftCard({ mailboxId, message, composer }: { mailboxId: string; message: MessageDetail; composer: Composer }) {
	const sending = message.labelIds.includes("OUTBOX");
	const discard = async () => {
		try {
			await draftsApi.discard(mailboxId, message.id);
			toast("Draft discarded.");
		} catch (err) {
			toast.error(`Couldn't discard the draft: ${(err as Error).message}`);
		}
	};
	return (
		<div className="flex items-center gap-3 border-t px-4 py-3 text-sm sm:gap-4">
			<Avatar className="size-10 shrink-0">
				<AvatarFallback className="bg-muted text-muted-foreground">
					<Pencil className="size-4" aria-hidden />
				</AvatarFallback>
			</Avatar>
			<div className="min-w-0 flex-1">
				<span className={cn("font-medium", sending ? "text-muted-foreground" : "text-destructive")}>{sending ? "Sending…" : "Draft"}</span>
				<span className="ml-3 truncate text-muted-foreground">{message.snippet || "(no text)"}</span>
			</div>
			{!sending && (
				<>
					<Button variant="ghost" size="sm" className="rounded-full" onClick={() => composer.openDraft(message.id, message.subject)}>
						<Pencil aria-hidden /> Edit
					</Button>
					<Button variant="ghost" size="icon-sm" className="rounded-full" onClick={() => void discard()} aria-label="Discard draft">
						<Trash2 className="size-4" />
					</Button>
				</>
			)}
		</div>
	);
}

function MessageDetails({ message }: { message: MessageDetail }) {
	const list = (as: { name: string; address: string }[]) =>
		as.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ");
	const auth = message.authResults;
	const rows: [string, string][] = [
		["from", list([message.from])],
		...(message.replyTo.length ? [["reply-to", list(message.replyTo)] as [string, string]] : []),
		["to", list(message.to) || "undisclosed recipients"],
		...(message.cc.length ? [["cc", list(message.cc)] as [string, string]] : []),
		...(message.bcc.length ? [["bcc", list(message.bcc)] as [string, string]] : []),
		["date", formatFullDate(message.sentAt)],
		["subject", message.subject || "(no subject)"],
		...(auth
			? [
					[
						"security",
						[auth.spf && `SPF: ${auth.spf}`, auth.dkim && `DKIM: ${auth.dkim}`, auth.dmarc && `DMARC: ${auth.dmarc}`]
							.filter(Boolean)
							.join(" · "),
					] as [string, string],
				]
			: []),
	];
	return (
		<dl className="mt-2 grid max-w-xl grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border bg-mail-surface p-3 text-xs shadow-sm">
			{rows.map(([k, v]) => (
				<div key={k} className="contents">
					<dt className="text-muted-foreground text-right">{k}:</dt>
					<dd className="break-words">{v}</dd>
				</div>
			))}
		</dl>
	);
}

function ThreadSkeleton() {
	return (
		<div className="flex flex-col gap-6 p-6 sm:pl-[72px]" aria-busy aria-label="Loading conversation">
			<Skeleton className="h-6 w-2/3" />
			<div className="flex gap-4">
				<Skeleton className="size-10 rounded-full" />
				<div className="flex flex-1 flex-col gap-2">
					<Skeleton className="h-4 w-48" />
					<Skeleton className="h-3 w-32" />
					<Skeleton className="mt-4 h-32 w-full" />
				</div>
			</div>
		</div>
	);
}
