import { Mail, Menu, Search } from "lucide-react";
import { Link } from "react-router";
import type { MailboxAccess, Me } from "../../../shared/api";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import type { LiveStatus } from "~/lib/api";
import { cn } from "~/lib/utils";
import { AccountSwitcher } from "./AccountSwitcher";

interface HeaderProps {
	me: Me;
	mailbox: MailboxAccess;
	live: LiveStatus;
	onToggleSidebar: () => void;
}

export function Header({ me, mailbox, live, onToggleSidebar }: HeaderProps) {
	return (
		<header className="flex h-16 shrink-0 items-center gap-2 px-2 sm:px-4">
			<Button variant="ghost" size="icon-lg" className="rounded-full" onClick={onToggleSidebar} aria-label="Main menu">
				<Menu className="size-5" />
			</Button>
			<Link to={`/mail/${mailbox.id}/inbox`} className="flex items-center gap-2 pr-4 text-xl text-foreground/80 sm:w-[190px]">
				<Mail className="size-7 text-primary" aria-hidden />
				<span className="hidden sm:inline">Mail</span>
			</Link>

			<div className="flex flex-1 justify-center lg:justify-start">
				<Tooltip>
					<TooltipTrigger asChild>
						<div
							className="flex h-12 w-full max-w-[720px] items-center gap-3 rounded-full bg-mail-hover/70 px-4 text-muted-foreground dark:bg-mail-surface"
							aria-disabled
						>
							<Search className="size-5" aria-hidden />
							<span className="text-base">Search mail</span>
						</div>
					</TooltipTrigger>
					<TooltipContent>Search arrives in a later update</TooltipContent>
				</Tooltip>
			</div>

			<Tooltip>
				<TooltipTrigger asChild>
					<span
						className={cn(
							"mx-2 size-2 rounded-full",
							live === "live" ? "bg-green-500" : live === "connecting" ? "bg-amber-400" : "bg-red-500",
						)}
						aria-label={`Live updates: ${live}`}
						role="status"
					/>
				</TooltipTrigger>
				<TooltipContent>
					{live === "live" ? "New mail appears automatically" : live === "connecting" ? "Connecting…" : "Offline, retrying"}
				</TooltipContent>
			</Tooltip>
			<AccountSwitcher me={me} current={mailbox} />
		</header>
	);
}
