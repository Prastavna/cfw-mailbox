import { Mail } from "lucide-react";
import type { MailboxAccess } from "../../shared/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { useMe } from "~/lib/api";
import type { Route } from "./+types/home";

export function meta(_: Route.MetaArgs) {
	return [{ title: "Mail" }];
}

function groupByDomain(mailboxes: MailboxAccess[]) {
	const groups = new Map<string, MailboxAccess[]>();
	for (const m of mailboxes) groups.set(m.domain, [...(groups.get(m.domain) ?? []), m]);
	return [...groups.entries()];
}

/**
 * Phase 0 landing page: proves sign-in and the mailbox directory work end to
 * end. Replaced by the Gmail-style shell and account switcher in Phase 2.
 */
export default function Home() {
	const { data: me, error, isPending } = useMe();

	return (
		<main className="mx-auto flex min-h-svh max-w-xl flex-col gap-6 p-6 pt-16">
			<div className="flex items-center gap-2 text-2xl font-medium">
				<Mail className="size-7" aria-hidden />
				Mail
			</div>

			{isPending && <p className="text-muted-foreground">Loading…</p>}
			{error && <p className="text-destructive">Couldn't sign you in: {error.message}</p>}

			{me && (
				<Card>
					<CardHeader>
						<CardTitle>{me.email}</CardTitle>
						<CardDescription>
							{me.isAdmin ? "Administrator" : "User"} · {me.mailboxes.length} mailbox
							{me.mailboxes.length === 1 ? "" : "es"}
						</CardDescription>
					</CardHeader>
					<CardContent className="flex flex-col gap-4">
						{me.mailboxes.length === 0 && (
							<p className="text-muted-foreground text-sm">
								{me.isAdmin
									? "No mailboxes yet. Add a domain and a mailbox through the admin API (an admin screen comes in a later phase)."
									: "You don't have access to any mailboxes yet. Ask an administrator to add you."}
							</p>
						)}
						{groupByDomain(me.mailboxes).map(([domain, list]) => (
							<section key={domain}>
								<h2 className="text-muted-foreground mb-1 text-xs font-medium uppercase tracking-wide">{domain}</h2>
								<ul>
									{list.map((m) => (
										<li key={m.id} className="flex justify-between py-1 text-sm">
											<span>
												{m.displayName} <span className="text-muted-foreground">&lt;{m.address}&gt;</span>
											</span>
											<span className="text-muted-foreground">{m.role}</span>
										</li>
									))}
								</ul>
							</section>
						))}
					</CardContent>
				</Card>
			)}
		</main>
	);
}
