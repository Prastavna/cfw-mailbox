import { Navigate, useParams } from "react-router";
import { DEFAULT_FOLDER } from "~/lib/folders";

export default function MailboxIndex() {
	const { mailboxId } = useParams();
	return <Navigate to={`/mail/${mailboxId}/${DEFAULT_FOLDER}`} replace />;
}
