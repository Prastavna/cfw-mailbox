import { useEffect } from "react";
import { useParams } from "react-router";
import { ThreadList } from "~/components/mail/ThreadList";
import { resolveFolder } from "~/lib/folders";
import { useMailboxContext } from "~/lib/mailbox-context";

export default function FolderRoute() {
	const { folder = "" } = useParams();
	const { mailbox, labels } = useMailboxContext();
	const resolved = resolveFolder(folder, labels);
	const unread = labels?.find((l) => l.id === resolved?.labelId)?.unread ?? 0;

	useEffect(() => {
		if (resolved) document.title = `${resolved.name}${unread ? ` (${unread})` : ""} - ${mailbox.address} - Mail`;
	}, [resolved?.name, unread, mailbox.address]);

	if (!resolved) {
		return labels ? <p className="text-muted-foreground p-10 text-center text-sm">This label doesn't exist.</p> : null;
	}
	return (
		<ThreadList
			key={`${mailbox.id}:${resolved.labelId}`}
			mailboxId={mailbox.id}
			mailboxAddress={mailbox.address}
			folderSegment={folder}
			labelId={resolved.labelId}
			folderName={resolved.name}
			labels={labels}
		/>
	);
}
