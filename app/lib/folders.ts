import { AlertOctagon, File, Inbox, type LucideIcon, Mails, Send, Star, Tag, Tags, Trash2 } from "lucide-react";
import type { Label } from "../../shared/api";

/** Sidebar entries for system labels, in Gmail's order. The slug is the URL segment. */
export interface Folder {
	slug: string;
	labelId: string;
	name: string;
	icon: LucideIcon;
	/** Which count the sidebar shows next to the name. */
	count: "unread" | "total" | "none";
}

export const SYSTEM_FOLDERS: readonly Folder[] = [
	{ slug: "inbox", labelId: "INBOX", name: "Inbox", icon: Inbox, count: "unread" },
	{ slug: "starred", labelId: "STARRED", name: "Starred", icon: Star, count: "none" },
	{ slug: "important", labelId: "IMPORTANT", name: "Important", icon: Tags, count: "none" },
	{ slug: "sent", labelId: "SENT", name: "Sent", icon: Send, count: "none" },
	{ slug: "drafts", labelId: "DRAFT", name: "Drafts", icon: File, count: "total" },
	{ slug: "all", labelId: "ALL", name: "All Mail", icon: Mails, count: "none" },
	{ slug: "spam", labelId: "SPAM", name: "Spam", icon: AlertOctagon, count: "unread" },
	{ slug: "trash", labelId: "TRASH", name: "Trash", icon: Trash2, count: "none" },
];

export const DEFAULT_FOLDER = "inbox";

/** URL segment for search results: /mail/:mailboxId/search?q=… */
export const SEARCH_SEGMENT = "search";

/** Gmail's label palette (background colours). */
export const LABEL_COLORS = [
	"#fb4c2f", "#ffad47", "#fad165", "#16a766", "#43d692", "#4a86e8",
	"#a479e2", "#f691b3", "#2da2bb", "#b99aff", "#ff7537", "#8a1c0a",
	"#7a2e0b", "#0b804b", "#285bac", "#41236d", "#83334c", "#666666",
];
export const UserLabelIcon = Tag;

/**
 * Resolves the `:folder` URL segment: a system folder slug, or a user label's ID.
 * Returns null when it matches neither.
 */
export function resolveFolder(segment: string, labels: Label[] | undefined): { labelId: string; name: string } | null {
	const system = SYSTEM_FOLDERS.find((f) => f.slug === segment);
	if (system) return { labelId: system.labelId, name: system.name };
	const user = labels?.find((l) => l.type === "user" && l.id === segment);
	return user ? { labelId: user.id, name: user.name } : null;
}

/** Labels shown as chips on threads: user labels, plus Inbox when viewing elsewhere. */
export function visibleLabelChips(
	labelIds: string[],
	labels: Label[] | undefined,
	currentLabelId: string,
): { id: string; name: string; color: string | null }[] {
	return labelIds.flatMap((id) => {
		if (id === currentLabelId) return [];
		if (id === "INBOX") return [{ id, name: "Inbox", color: null }];
		const label = labels?.find((l) => l.id === id && l.type === "user");
		return label ? [{ id, name: label.name, color: label.color }] : [];
	});
}
