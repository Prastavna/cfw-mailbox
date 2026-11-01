import { useParams, useSearchParams } from "react-router";
import { ThreadView } from "~/components/mail/ThreadView";
import { resolveFolder, SEARCH_SEGMENT } from "~/lib/folders";
import { useMailboxContext } from "~/lib/mailbox-context";

export default function ThreadRoute() {
	const { folder = "", threadId = "" } = useParams();
	const [params] = useSearchParams();
	const { mailbox, labels, actions, composer } = useMailboxContext();
	const search = folder === SEARCH_SEGMENT;
	return (
		<ThreadView
			mailboxId={mailbox.id}
			mailboxAddress={mailbox.address}
			threadId={threadId}
			backHref={`/mail/${mailbox.id}/${folder}${search ? `?q=${encodeURIComponent(params.get("q") ?? "")}` : ""}`}
			currentLabelId={search ? "ALL" : (resolveFolder(folder, labels)?.labelId ?? "")}
			labels={labels}
			actions={actions}
			composer={composer}
		/>
	);
}
