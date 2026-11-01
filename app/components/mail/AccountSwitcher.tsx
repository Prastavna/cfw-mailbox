import { Check } from "lucide-react";
import { useNavigate } from "react-router";
import type { MailboxAccess, Me } from "../../../shared/api";
import { Avatar, AvatarFallback } from "~/components/ui/avatar";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { avatarColor, initial } from "~/lib/format";

function MailboxAvatar({ mailbox, size = "default" }: { mailbox: MailboxAccess; size?: "default" | "sm" }) {
	return (
		<Avatar className={size === "sm" ? "size-7" : "size-8"}>
			<AvatarFallback
				className="text-sm font-medium text-white"
				style={{ backgroundColor: avatarColor(mailbox.address) }}
			>
				{initial({ name: mailbox.displayName, address: mailbox.address })}
			</AvatarFallback>
		</Avatar>
	);
}

/** Header avatar menu: switch between the mailboxes this user can open, grouped by domain. */
export function AccountSwitcher({ me, current }: { me: Me; current: MailboxAccess }) {
	const navigate = useNavigate();
	const domains = [...new Set(me.mailboxes.map((m) => m.domain))];

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				className="rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
				aria-label={`Account: ${current.address}. Switch mailbox`}
			>
				<MailboxAvatar mailbox={current} />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-80">
				<DropdownMenuLabel className="flex flex-col gap-0.5 py-2">
					<span className="text-muted-foreground text-xs font-normal">Signed in as</span>
					<span className="truncate">{me.email}</span>
				</DropdownMenuLabel>
				{domains.map((domain) => (
					<DropdownMenuGroup key={domain}>
						<DropdownMenuSeparator />
						<DropdownMenuLabel className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
							{domain}
						</DropdownMenuLabel>
						{me.mailboxes
							.filter((m) => m.domain === domain)
							.map((m) => (
								<DropdownMenuItem key={m.id} onSelect={() => navigate(`/mail/${m.id}/inbox`)} className="gap-3">
									<MailboxAvatar mailbox={m} size="sm" />
									<span className="flex min-w-0 flex-1 flex-col">
										<span className="truncate font-medium">{m.displayName}</span>
										<span className="text-muted-foreground truncate text-xs">{m.address}</span>
									</span>
									{m.id === current.id && <Check className="size-4" aria-label="Current mailbox" />}
								</DropdownMenuItem>
							))}
					</DropdownMenuGroup>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
