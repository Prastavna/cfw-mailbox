import { CloudOff } from "lucide-react";
import { useConnection } from "~/lib/connection";
import { formatListDate } from "~/lib/format";
import { useOfflineMail } from "~/lib/pwa";

/** Says when Mail is offline, and whether what's on screen is mail saved on this device. */
export function OfflineBanner({ onOpenSettings }: { onOpenSettings: () => void }) {
	const { online, savedAt } = useConnection();
	const offlineMail = useOfflineMail();
	if (online && savedAt === null) return null;

	let text: React.ReactNode;
	if (savedAt !== null) {
		text = `Can't reach the server. Showing mail saved on this device${savedAt ? ` (${formatListDate(savedAt)})` : ""}.`;
	} else if (offlineMail) {
		text = "You're offline. Conversations saved on this device can still be read.";
	} else {
		text = (
			<>
				You're offline. New mail will appear when you reconnect.{" "}
				<button type="button" className="underline" onClick={onOpenSettings}>
					Read mail offline
				</button>
			</>
		);
	}
	return (
		<div role="status" className="mx-2 mb-2 flex items-center gap-2 rounded-lg bg-muted px-4 py-1.5 text-sm sm:mx-4">
			<CloudOff className="size-4 shrink-0 text-muted-foreground" aria-hidden />
			<span>{text}</span>
		</div>
	);
}
