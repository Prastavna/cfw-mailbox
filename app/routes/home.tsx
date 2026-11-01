import { Mail } from "lucide-react";
import { Navigate } from "react-router";
import { lastMailbox, useMe } from "~/lib/api";
import type { Route } from "./+types/home";

export function meta(_: Route.MetaArgs) {
	return [{ title: "Mail" }];
}

/** Sends the user to their last-used mailbox (or the first one they can open). */
export default function Home() {
	const { data: me, error, isPending } = useMe();

	if (me && me.mailboxes.length > 0) {
		const remembered = lastMailbox();
		const target = me.mailboxes.find((m) => m.id === remembered) ?? me.mailboxes[0]!;
		return <Navigate to={`/mail/${target.id}/inbox`} replace />;
	}

	return (
		<main className="flex min-h-svh flex-col items-center justify-center gap-4 bg-mail-canvas p-6 text-center">
			<Mail className="size-10 text-primary" aria-hidden />
			{isPending && <p className="text-muted-foreground">Loading your mail…</p>}
			{error && <p className="text-destructive">Couldn't sign you in: {error.message}</p>}
			{me && (
				<div className="max-w-md space-y-2">
					<p className="font-medium">Signed in as {me.email}</p>
					<p className="text-muted-foreground text-sm">
						{me.isAdmin
							? "There are no mailboxes yet. Add a domain and a mailbox through the admin API (see the README)."
							: "You don't have access to any mailboxes yet. Ask an administrator to add you."}
					</p>
				</div>
			)}
		</main>
	);
}
