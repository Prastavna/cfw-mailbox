import { type InfiniteData, type QueryKey, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import {
	ALL_MAIL,
	invertChanges,
	type Label,
	type LabelInput,
	type MessageLabelChange,
	type ModifyResult,
	type ThreadDetail,
	type ThreadPage,
} from "../../shared/api";
import { apiFetch, queryKeys } from "./api";

/**
 * Thread actions, Gmail style: each is a set of labels to add and remove.
 * The UI updates immediately (optimistically) and rolls back if the server
 * refuses. Undo replays the server's record of exactly what changed.
 */

export interface LabelDelta {
	add?: string[];
	remove?: string[];
}

export const Actions = {
	archive: { remove: ["INBOX"] },
	moveToInbox: { add: ["INBOX"], remove: ["TRASH", "SPAM"] },
	trash: { add: ["TRASH"], remove: ["INBOX", "SPAM"] },
	spam: { add: ["SPAM"], remove: ["INBOX"] },
	notSpam: { add: ["INBOX"], remove: ["SPAM"] },
	markRead: { remove: ["UNREAD"] },
	markUnread: { add: ["UNREAD"] },
	star: { add: ["STARRED"] },
	unstar: { remove: ["STARRED"] },
	important: { add: ["IMPORTANT"] },
	notImportant: { remove: ["IMPORTANT"] },
} satisfies Record<string, LabelDelta>;

const HIDDEN: Record<string, string[]> = { TRASH: [], SPAM: ["TRASH"] };
const hiddenIn = (labelId: string) => HIDDEN[labelId] ?? ["TRASH", "SPAM"];

/** Whether a thread with these labels appears in the given list. Mirrors MailboxDO.listThreads. */
export function belongsTo(listLabelId: string, labelIds: string[]): boolean {
	if (listLabelId === ALL_MAIL) return !labelIds.includes("TRASH") && !labelIds.includes("SPAM");
	return labelIds.includes(listLabelId) && !hiddenIn(listLabelId).some((l) => labelIds.includes(l));
}

const applyDelta = (labelIds: string[], add: string[], remove: string[]) =>
	[...new Set([...labelIds, ...add])].filter((l) => !remove.includes(l)).sort();

interface ModifyOptions {
	/** Toast text, e.g. "Conversation archived". No toast when omitted. */
	message?: string;
	undoable?: boolean;
}

export function useMailActions(mailboxId: string) {
	const queryClient = useQueryClient();
	const prefix = useMemo(() => queryKeys.mailbox(mailboxId), [mailboxId]);

	const snapshot = useCallback(() => queryClient.getQueriesData({ queryKey: prefix }), [queryClient, prefix]);
	const restore = useCallback(
		(saved: [QueryKey, unknown][]) => saved.forEach(([key, data]) => queryClient.setQueryData(key, data)),
		[queryClient],
	);
	const resync = useCallback(() => queryClient.invalidateQueries({ queryKey: prefix }), [queryClient, prefix]);

	/** Optimistically applies a label delta to cached lists and thread views. */
	const applyOptimistic = useCallback(
		(threadIds: string[], add: string[], remove: string[]) => {
			const ids = new Set(threadIds);
			for (const [key, data] of queryClient.getQueriesData<InfiniteData<ThreadPage>>({ queryKey: [...prefix, "threads"] })) {
				if (!data) continue;
				const listLabel = String(key[3]);
				queryClient.setQueryData<InfiniteData<ThreadPage>>(key, {
					...data,
					pages: data.pages.map((page) => ({
						...page,
						threads: page.threads.flatMap((t) => {
							if (!ids.has(t.id)) return [t];
							const labelIds = applyDelta(t.labelIds, add, remove);
							return belongsTo(listLabel, labelIds) ? [{ ...t, labelIds, unread: labelIds.includes("UNREAD") }] : [];
						}),
					})),
				});
			}
			for (const id of threadIds) {
				queryClient.setQueryData<ThreadDetail>(queryKeys.thread(mailboxId, id), (detail) => {
					if (!detail) return detail;
					const last = detail.messages.length - 1;
					const labelIds = applyDelta(detail.thread.labelIds, add, remove);
					return {
						thread: { ...detail.thread, labelIds, unread: labelIds.includes("UNREAD") },
						messages: detail.messages.map((m, i) => {
							const latestOnly = add.filter((l) => (l !== "STARRED" && l !== "UNREAD") || i === last);
							return { ...m, labelIds: applyDelta(m.labelIds, latestOnly, remove) };
						}),
					};
				});
			}
		},
		[queryClient, prefix, mailboxId],
	);

	const undo = useCallback(
		async (changes: MessageLabelChange[]) => {
			try {
				await apiFetch<ModifyResult>(`/mailboxes/${mailboxId}/messages/modify`, {
					method: "POST",
					body: JSON.stringify({ changes: invertChanges(changes) }),
				});
				toast("Action undone.");
			} catch (err) {
				toast.error(`Couldn't undo: ${(err as Error).message}`);
			} finally {
				resync();
			}
		},
		[mailboxId, resync],
	);

	const modify = useCallback(
		async (threadIds: string[], delta: LabelDelta, opts: ModifyOptions = {}): Promise<boolean> => {
			if (!threadIds.length) return false;
			const add = delta.add ?? [];
			const remove = delta.remove ?? [];
			await queryClient.cancelQueries({ queryKey: prefix });
			const saved = snapshot();
			applyOptimistic(threadIds, add, remove);
			try {
				const result = await apiFetch<ModifyResult>(`/mailboxes/${mailboxId}/threads/modify`, {
					method: "POST",
					body: JSON.stringify({ threadIds, addLabelIds: add, removeLabelIds: remove }),
				});
				if (opts.message) {
					toast(opts.message, {
						action:
							opts.undoable !== false && result.changes.length
								? { label: "Undo", onClick: () => undo(result.changes) }
								: undefined,
					});
				}
				return true;
			} catch (err) {
				restore(saved);
				toast.error(`Couldn't update: ${(err as Error).message}`);
				return false;
			} finally {
				queryClient.invalidateQueries({ queryKey: queryKeys.labels(mailboxId) });
				queryClient.invalidateQueries({ queryKey: [...prefix, "threads"], refetchType: "none" });
			}
		},
		[queryClient, prefix, snapshot, applyOptimistic, restore, undo, mailboxId],
	);

	/** Per-message change, e.g. starring one message in a conversation. */
	const modifyMessage = useCallback(
		async (messageId: string, delta: LabelDelta) => {
			try {
				await apiFetch<ModifyResult>(`/mailboxes/${mailboxId}/messages/modify`, {
					method: "POST",
					body: JSON.stringify({ changes: [{ messageId, addLabelIds: delta.add ?? [], removeLabelIds: delta.remove ?? [] }] }),
				});
			} catch (err) {
				toast.error(`Couldn't update: ${(err as Error).message}`);
			} finally {
				resync();
			}
		},
		[mailboxId, resync],
	);

	const deleteForever = useCallback(
		async (threadIds: string[]) => {
			const saved = snapshot();
			for (const [key, data] of queryClient.getQueriesData<InfiniteData<ThreadPage>>({ queryKey: [...prefix, "threads"] })) {
				if (!data) continue;
				queryClient.setQueryData<InfiniteData<ThreadPage>>(key, {
					...data,
					pages: data.pages.map((p) => ({ ...p, threads: p.threads.filter((t) => !threadIds.includes(t.id)) })),
				});
			}
			try {
				const { threadIds: deleted } = await apiFetch<{ threadIds: string[] }>(`/mailboxes/${mailboxId}/threads/delete`, {
					method: "POST",
					body: JSON.stringify({ threadIds }),
				});
				toast(`${deleted.length} conversation${deleted.length === 1 ? "" : "s"} deleted forever.`);
				for (const id of deleted) queryClient.removeQueries({ queryKey: queryKeys.thread(mailboxId, id) });
			} catch (err) {
				restore(saved);
				toast.error(`Couldn't delete: ${(err as Error).message}`);
			} finally {
				queryClient.invalidateQueries({ queryKey: queryKeys.labels(mailboxId) });
			}
		},
		[snapshot, queryClient, prefix, mailboxId, restore],
	);

	// ---- Labels ----------------------------------------------------------------

	const createLabel = useCallback(
		async (input: LabelInput) => {
			const label = await apiFetch<Label>(`/mailboxes/${mailboxId}/labels`, { method: "POST", body: JSON.stringify(input) });
			await queryClient.invalidateQueries({ queryKey: queryKeys.labels(mailboxId) });
			return label;
		},
		[mailboxId, queryClient],
	);

	const updateLabel = useCallback(
		async (id: string, input: Partial<LabelInput>) => {
			await apiFetch(`/mailboxes/${mailboxId}/labels/${id}`, { method: "PATCH", body: JSON.stringify(input) });
			await queryClient.invalidateQueries({ queryKey: queryKeys.labels(mailboxId) });
		},
		[mailboxId, queryClient],
	);

	const deleteLabel = useCallback(
		async (id: string) => {
			await apiFetch(`/mailboxes/${mailboxId}/labels/${id}`, { method: "DELETE" });
			resync();
		},
		[mailboxId, resync],
	);

	return useMemo(
		() => ({ modify, modifyMessage, deleteForever, createLabel, updateLabel, deleteLabel }),
		[modify, modifyMessage, deleteForever, createLabel, updateLabel, deleteLabel],
	);
}

export type MailActions = ReturnType<typeof useMailActions>;
