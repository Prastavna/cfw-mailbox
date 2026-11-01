import { useOutletContext } from "react-router";
import type { Label, MailboxAccess, Me } from "../../shared/api";
import type { MailActions } from "./actions";
import type { Composer } from "./compose-store";

/** What the mailbox layout passes down to its folder and thread routes. */
export interface MailboxContext {
	me: Me;
	mailbox: MailboxAccess;
	labels: Label[] | undefined;
	actions: MailActions;
	composer: Composer;
}

export const useMailboxContext = () => useOutletContext<MailboxContext>();
