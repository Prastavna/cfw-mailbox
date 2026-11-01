import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import type { MailboxSettings } from "../../../shared/api";
import { Button } from "~/components/ui/button";
import { apiFetch } from "~/lib/api";
import { settingsKey, useSettings } from "~/lib/compose-store";

/** Gmail's reminder that the vacation responder is on, with a way to end it. */
export function VacationBanner({ mailboxId, onOpenSettings }: { mailboxId: string; onOpenSettings: () => void }) {
	const { data } = useSettings(mailboxId);
	const queryClient = useQueryClient();
	const [ending, setEnding] = useState(false);
	const vacation = data?.vacation;
	const now = Date.now();
	if (!vacation?.enabled || (vacation.endAt !== null && vacation.endAt < now)) return null;
	const upcoming = vacation.startAt !== null && vacation.startAt > now;

	const end = async () => {
		setEnding(true);
		try {
			const saved = await apiFetch<MailboxSettings>(`/mailboxes/${mailboxId}/settings`, {
				method: "PATCH",
				body: JSON.stringify({ vacation: { ...vacation, enabled: false } }),
			});
			queryClient.setQueryData(settingsKey(mailboxId), saved);
			toast("Vacation responder turned off.");
		} catch (err) {
			toast.error(`Couldn't turn it off: ${(err as Error).message}`);
		} finally {
			setEnding(false);
		}
	};

	return (
		<div role="status" className="mx-2 mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-amber-100 px-4 py-1.5 text-sm text-amber-950 sm:mx-4 dark:bg-amber-950/60 dark:text-amber-100">
			<span className="min-w-0 flex-1 truncate">
				<span className="font-medium">{upcoming ? "Vacation responder starts " + new Date(vacation.startAt!).toLocaleDateString() : "Vacation responder is on"}</span>
				{vacation.subject && <span className="text-amber-900/80 dark:text-amber-100/80"> — {vacation.subject}</span>}
			</span>
			<Button variant="ghost" size="sm" className="h-7 hover:bg-amber-200/70 dark:hover:bg-amber-900" disabled={ending} onClick={end}>
				End now
			</Button>
			<Button variant="ghost" size="sm" className="h-7 hover:bg-amber-200/70 dark:hover:bg-amber-900" onClick={onOpenSettings}>
				Vacation settings
			</Button>
		</div>
	);
}
