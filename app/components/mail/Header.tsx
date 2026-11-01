import { Mail, Menu, Settings, Sparkles } from "lucide-react";
import { Link } from "react-router";
import type { Label, MailboxAccess, Me } from "../../../shared/api";
import type { ExtensionId } from "../../../shared/extensions";
import { ExtensionsLauncher } from "~/components/extensions/ExtensionsLauncher";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import type { LiveStatus } from "~/lib/api";
import { cn } from "~/lib/utils";
import { AccountSwitcher } from "./AccountSwitcher";
import { SearchBar } from "./SearchBar";
import type { SettingsTab } from "./SettingsDialog";

interface HeaderProps {
	me: Me;
	mailbox: MailboxAccess;
	live: LiveStatus;
	labels: Label[] | undefined;
	onToggleSidebar: () => void;
	onOpenSettings: (tab?: SettingsTab, filterQuery?: string) => void;
	onOpenExtension: (id: ExtensionId) => void;
	/** Shown when the AI Assistant is on: opens "Ask your inbox". */
	onAsk?: () => void;
}

export function Header({ me, mailbox, live, labels, onToggleSidebar, onOpenSettings, onOpenExtension, onAsk }: HeaderProps) {
	return (
		<header className="flex h-16 shrink-0 items-center gap-2 px-2 sm:px-4">
			<Button variant="ghost" size="icon-lg" className="rounded-full" onClick={onToggleSidebar} aria-label="Main menu">
				<Menu className="size-5" />
			</Button>
			<Link to={`/mail/${mailbox.id}/inbox`} className="flex items-center gap-2 pr-4 text-xl text-foreground/80 sm:w-[190px]">
				<Mail className="size-7 text-primary" aria-hidden />
				<span className="hidden sm:inline">Mail</span>
			</Link>

			<div className="flex min-w-0 flex-1 justify-center lg:justify-start">
				<SearchBar mailboxId={mailbox.id} labels={labels} onCreateFilter={(q) => onOpenSettings("filters", q)} />
			</div>

			<Tooltip>
				<TooltipTrigger asChild>
					<span
						className={cn(
							"mx-2 hidden size-2 rounded-full sm:block",
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
			<Tooltip>
				<TooltipTrigger asChild>
					<Button variant="ghost" size="icon-lg" className="rounded-full" onClick={() => onOpenSettings()} aria-label="Settings">
						<Settings className="size-5" />
					</Button>
				</TooltipTrigger>
				<TooltipContent>Settings</TooltipContent>
			</Tooltip>
			{onAsk && (
				<Tooltip>
					<TooltipTrigger asChild>
						<Button variant="ghost" size="icon-lg" className="rounded-full" onClick={onAsk} aria-label="Ask your inbox">
							<Sparkles className="size-5 text-violet-600 dark:text-violet-400" />
						</Button>
					</TooltipTrigger>
					<TooltipContent>Ask your inbox</TooltipContent>
				</Tooltip>
			)}
			<ExtensionsLauncher onOpen={onOpenExtension} />
			<AccountSwitcher me={me} current={mailbox} />
		</header>
	);
}
