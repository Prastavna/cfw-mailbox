import { useOutletContext } from "react-router";
import type { Label, MailboxAccess, Me } from "../../shared/api";

/** What the mailbox layout passes down to its folder and thread routes. */
export interface MailboxContext {
	me: Me;
	mailbox: MailboxAccess;
	labels: Label[] | undefined;
}

export const useMailboxContext = () => useOutletContext<MailboxContext>();
