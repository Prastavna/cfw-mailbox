import { ArrowLeft, ChevronDown, ChevronUp, EllipsisVertical, FileCode, Paperclip, Star } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
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
import { rawMessageUrl, useThread } from "~/lib/api";
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
import { AttachmentList } from "./AttachmentList";
import { EmailBody } from "./EmailBody";

interface ThreadViewProps {
	mailboxId: string;
	mailboxAddress: string;
	threadId: string;
	backHref: string;
	currentLabelId: string;
	labels: Label[] | undefined;
}

/** How many collapsed messages in the middle of a thread before they fold into "N older messages". */
const FOLD_THRESHOLD = 3;

export function ThreadView({ mailboxId, mailboxAddress, threadId, backHref, currentLabelId, labels }: ThreadViewProps) {
	const { data, isPending, isError, error } = useThread(mailboxId, threadId);
	const messages = data?.messages ?? [];

	// Gmail expands the newest message and any unread ones.
	const initiallyExpanded = useMemo(() => {
		const ids = new Set(messages.filter((m) => m.labelIds.includes("UNREAD")).map((m) => m.id));
		const last = messages.at(-1);
		if (last) ids.add(last.id);
		return ids;
	}, [messages]);
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [unfolded, setUnfolded] = useState(false);
	useEffect(() => {
		setExpanded(initiallyExpanded);
		setUnfolded(false);
	}, [threadId, initiallyExpanded]);

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
									isLast={i === messages.length - 1}
								/>
							);
						})}
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
}

function MessageCard({ mailboxId, me, message, expanded, isLast, onToggle }: MessageCardProps) {
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
						{starred && <Star className="size-4 shrink-0 fill-amber-400 text-amber-400" aria-label="Starred" />}
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button variant="ghost" size="icon-sm" className="-mt-1 rounded-full" aria-label="More">
									<EllipsisVertical className="size-4" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem asChild>
									<a href={rawMessageUrl(mailboxId, message.id)} target="_blank" rel="noopener noreferrer">
										<FileCode className="size-4" /> Show original
									</a>
								</DropdownMenuItem>
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
