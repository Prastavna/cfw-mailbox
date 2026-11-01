import { Download, FileText, ImageIcon } from "lucide-react";
import type { AttachmentInfo } from "../../../shared/api";
import { attachmentUrl } from "~/lib/api";
import { formatSize } from "~/lib/format";

/** Download cards for a message's real attachments (inline images are shown in the body). */
export function AttachmentList({
	mailboxId,
	messageId,
	attachments,
}: {
	mailboxId: string;
	messageId: string;
	attachments: AttachmentInfo[];
}) {
	const files = attachments.filter((a) => a.disposition === "attachment");
	if (files.length === 0) return null;

	return (
		<section className="mt-4 border-t pt-4" aria-label="Attachments">
			<h3 className="mb-3 text-sm font-medium">
				{files.length} attachment{files.length === 1 ? "" : "s"}
			</h3>
			<ul className="flex flex-wrap gap-3">
				{files.map((a) => {
					const Icon = a.mimeType.startsWith("image/") ? ImageIcon : FileText;
					return (
						<li key={a.id}>
							<a
								href={attachmentUrl(mailboxId, messageId, a.id)}
								download={a.filename}
								className="group flex w-56 items-center gap-3 rounded-lg border bg-mail-surface p-3 text-sm transition-colors hover:bg-mail-hover"
							>
								<Icon className="size-8 shrink-0 text-red-600" aria-hidden />
								<span className="flex min-w-0 flex-1 flex-col">
									<span className="truncate font-medium" title={a.filename}>
										{a.filename}
									</span>
									<span className="text-muted-foreground text-xs">{formatSize(a.size)}</span>
								</span>
								<Download className="size-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" aria-label="Download" />
							</a>
						</li>
					);
				})}
			</ul>
		</section>
	);
}
