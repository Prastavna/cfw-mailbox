import { useEffect } from "react";
import { useParams, useSearchParams } from "react-router";
import { ThreadList } from "~/components/mail/ThreadList";
import { resolveFolder, SEARCH_SEGMENT } from "~/lib/folders";
import { useMailboxContext } from "~/lib/mailbox-context";

export default function FolderRoute() {
	const { folder = "" } = useParams();
	const [params] = useSearchParams();
	const { mailbox, labels, actions, composer } = useMailboxContext();
	const query = folder === SEARCH_SEGMENT ? (params.get("q") ?? "") : undefined;
	// Search results behave like All Mail for actions and label chips.
	const resolved = query !== undefined ? { labelId: "ALL", name: "Search results" } : resolveFolder(folder, labels);
	const unread = query === undefined ? (labels?.find((l) => l.id === resolved?.labelId)?.unread ?? 0) : 0;

	useEffect(() => {
		if (!resolved) return;
		const name = query !== undefined ? `Search results for "${query}"` : resolved.name;
		document.title = `${name}${unread ? ` (${unread})` : ""} - ${mailbox.address} - Mail`;
	}, [resolved?.name, query, unread, mailbox.address]);

	if (!resolved) {
		return labels ? <p className="text-muted-foreground p-10 text-center text-sm">This label doesn't exist.</p> : null;
	}
	return (
		<ThreadList
			key={`${mailbox.id}:${query !== undefined ? `search:${query}` : resolved.labelId}`}
			mailboxId={mailbox.id}
			mailboxAddress={mailbox.address}
			folderSegment={folder}
			labelId={resolved.labelId}
			folderName={resolved.name}
			labels={labels}
			actions={actions}
			composer={composer}
			query={query}
		/>
	);
}
