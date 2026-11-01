/** HTML bodies larger than this go to R2 instead of the mailbox database (rows are capped at 2 MB). */
export const INLINE_HTML_LIMIT = 256 * 1024;
/** Plain text kept in the database for display and search; the full body stays in the raw message. */
export const TEXT_LIMIT = 256 * 1024;

/** Where a message's blobs live in R2. */
export function messageKeys(mailboxId: string, messageId: string) {
	const base = `mailboxes/${mailboxId}/messages/${messageId}`;
	return {
		raw: `${base}/raw.eml`,
		html: `${base}/body.html`,
		attachment: (attachmentId: string) => `${base}/attachments/${attachmentId}`,
	};
}
