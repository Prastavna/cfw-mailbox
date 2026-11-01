import { useOutletContext } from "react-router";
import type { Label, MailboxAccess, Me } from "../../shared/api";
import type { MailActions } from "./actions";

/** What the mailbox layout passes down to its folder and thread routes. */
export interface MailboxContext {
	me: Me;
	mailbox: MailboxAccess;
	labels: Label[] | undefined;
	actions: MailActions;
}

export const useMailboxContext = () => useOutletContext<MailboxContext>();
