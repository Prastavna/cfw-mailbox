import { useParams, useSearchParams } from "react-router";
import { ThreadView } from "~/components/mail/ThreadView";
import { resolveFolder, SEARCH_SEGMENT } from "~/lib/folders";
import { searchListKey } from "~/lib/api";
import { useMailboxContext } from "~/lib/mailbox-context";

export default function ThreadRoute() {
	const { folder = "", threadId = "" } = useParams();
	const [params] = useSearchParams();
	const { mailbox, labels, actions, composer } = useMailboxContext();
	const search = folder === SEARCH_SEGMENT;
	const suffix = search ? `?q=${encodeURIComponent(params.get("q") ?? "")}` : "";
	const labelId = search ? "ALL" : (resolveFolder(folder, labels)?.labelId ?? "");
	return (
		<ThreadView
			mailboxId={mailbox.id}
			mailboxAddress={mailbox.address}
			threadId={threadId}
			backHref={`/mail/${mailbox.id}/${folder}${suffix}`}
			currentLabelId={labelId}
			listKey={search ? searchListKey(params.get("q") ?? "") : labelId}
			hrefFor={(id) => `/mail/${mailbox.id}/${folder}/${id}${suffix}`}
			labels={labels}
			actions={actions}
			composer={composer}
		/>
	);
}
