import { useParams } from "react-router";
import { ThreadView } from "~/components/mail/ThreadView";
import { resolveFolder } from "~/lib/folders";
import { useMailboxContext } from "~/lib/mailbox-context";

export default function ThreadRoute() {
	const { folder = "", threadId = "" } = useParams();
	const { mailbox, labels, actions, composer } = useMailboxContext();
	return (
		<ThreadView
			mailboxId={mailbox.id}
			mailboxAddress={mailbox.address}
			threadId={threadId}
			backHref={`/mail/${mailbox.id}/${folder}`}
			currentLabelId={resolveFolder(folder, labels)?.labelId ?? ""}
			labels={labels}
			actions={actions}
			composer={composer}
		/>
	);
}
