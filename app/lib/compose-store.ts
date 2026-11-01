import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { create } from "zustand";
import type {
	AttachmentInfo,
	CreateDraftRequest,
	DraftDetail,
	DraftFields,
	MailboxSettings,
	MessageDetail,
	SendResult,
} from "../../shared/api";
import { apiFetch, ApiRequestError, queryKeys } from "./api";
import { initialBody, prefixSubject, quoteBlock, quoteDate, replyRecipients, textToHtml } from "./compose";

/** What a new compose window starts with. */
export interface ComposeSeed {
	to: DraftFields["to"];
	cc: DraftFields["cc"];
	bcc: DraftFields["bcc"];
	subject: string;
	/** Editor content (what the user writes). */
	body: string;
	/** Quoted reply / forwarded message, appended below the body. */
	quote: string | null;
	parent?: CreateDraftRequest["parent"];
	/** A forward's attachments, copied into the draft when it's first saved. */
	inheritedAttachments: AttachmentInfo[];
}

export interface ComposeWindow {
	key: string;
	mailboxId: string;
	/** Set once the draft exists on the server. */
	draftId: string | null;
	/** Present for new windows; windows reopening a saved draft load it instead. */
	seed: ComposeSeed | null;
	minimized: boolean;
	maximized: boolean;
	/** Shown in the title bar. */
	title: string;
}

/** Gmail stacks a few windows side by side; opening more closes the oldest (it has been saved). */
const MAX_WINDOWS = 3;

interface ComposeState {
	windows: ComposeWindow[];
	open: (w: Omit<ComposeWindow, "key" | "minimized" | "maximized">) => void;
	update: (key: string, patch: Partial<ComposeWindow>) => void;
	close: (key: string) => void;
}

export const useComposeStore = create<ComposeState>((set) => ({
	windows: [],
	open: (w) =>
		set((s) => {
			if (w.draftId) {
				const existing = s.windows.find((x) => x.draftId === w.draftId);
				if (existing) {
					return { windows: s.windows.map((x) => (x === existing ? { ...x, minimized: false } : x)) };
				}
			}
			const win: ComposeWindow = { ...w, key: crypto.randomUUID(), minimized: false, maximized: false };
			const others = s.windows.map((x) => ({ ...x, maximized: false }));
			return { windows: [...others, win].slice(-MAX_WINDOWS) };
		}),
	update: (key, patch) => set((s) => ({ windows: s.windows.map((w) => (w.key === key ? { ...w, ...patch } : w)) })),
	close: (key) => set((s) => ({ windows: s.windows.filter((w) => w.key !== key) })),
}));

// ---- Server calls ------------------------------------------------------------

export const settingsKey = (mailboxId: string) => [...queryKeys.mailbox(mailboxId), "settings"] as const;

export function useSettings(mailboxId: string) {
	return useQuery({
		queryKey: settingsKey(mailboxId),
		queryFn: () => apiFetch<MailboxSettings>(`/mailboxes/${mailboxId}/settings`),
		staleTime: 5 * 60_000,
	});
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const draftsApi = {
	create: (mailboxId: string, body: CreateDraftRequest) =>
		apiFetch<DraftDetail>(`/mailboxes/${mailboxId}/drafts`, json("POST", body)),
	get: (mailboxId: string, id: string) => apiFetch<DraftDetail>(`/mailboxes/${mailboxId}/drafts/${id}`),
	update: (mailboxId: string, id: string, fields: DraftFields) =>
		apiFetch<DraftDetail>(`/mailboxes/${mailboxId}/drafts/${id}`, json("PUT", fields)),
	discard: (mailboxId: string, id: string) => apiFetch<null>(`/mailboxes/${mailboxId}/drafts/${id}`, { method: "DELETE" }),
	send: (mailboxId: string, id: string) => apiFetch<SendResult>(`/mailboxes/${mailboxId}/drafts/${id}/send`, json("POST", {})),
	cancelSend: (mailboxId: string, id: string) =>
		apiFetch<DraftDetail>(`/mailboxes/${mailboxId}/drafts/${id}/cancel-send`, json("POST", {})),
	removeAttachment: (mailboxId: string, id: string, attachmentId: string) =>
		apiFetch<null>(`/mailboxes/${mailboxId}/drafts/${id}/attachments/${attachmentId}`, { method: "DELETE" }),
	async upload(mailboxId: string, id: string, file: File): Promise<AttachmentInfo> {
		const res = await fetch(`/api/mailboxes/${mailboxId}/drafts/${id}/attachments?filename=${encodeURIComponent(file.name)}`, {
			method: "POST",
			headers: { "content-type": file.type || "application/octet-stream" },
			body: file,
		});
		if (!res.ok) {
			const body = (await res.json().catch(() => null)) as { error?: string } | null;
			throw new ApiRequestError(res.status, body?.error ?? res.statusText);
		}
		return res.json();
	},
};

// ---- Opening windows -----------------------------------------------------------

/** Sanitises a message body for quoting: no scripts, styles or unattached inline images. */
async function quotableHtml(message: MessageDetail, keepInlineImages: boolean): Promise<string> {
	if (!message.html) return textToHtml(message.text ?? "");
	const { default: DOMPurify } = await import("dompurify");
	const purify = DOMPurify(window);
	purify.addHook("afterSanitizeAttributes", (node) => {
		const el = node as Element;
		if (el.tagName === "IMG" && !keepInlineImages && (el.getAttribute("src") ?? "").toLowerCase().startsWith("cid:")) {
			el.remove();
		}
	});
	return purify.sanitize(message.html, {
		FORBID_TAGS: ["style", "form", "input", "button", "select", "textarea", "iframe", "object", "embed", "base", "meta", "link", "svg", "math"],
		ALLOW_DATA_ATTR: false,
	});
}

/** Opens compose windows for this mailbox: new message, reply, reply all, forward, or an existing draft. */
export function useComposer(mailbox: { id: string; address: string }) {
	const { data: settings } = useSettings(mailbox.id);
	const open = useComposeStore((s) => s.open);
	const signature = settings?.signature ?? "";

	return useMemo(() => {
		const body = initialBody(signature);
		return {
			compose(seed: Partial<ComposeSeed> = {}) {
				open({
					mailboxId: mailbox.id,
					draftId: null,
					title: "New Message",
					seed: { to: [], cc: [], bcc: [], subject: "", body, quote: null, inheritedAttachments: [], ...seed },
				});
			},
			async reply(message: MessageDetail, all = false) {
				const { to, cc } = replyRecipients(message, mailbox.address, all);
				const quote = quoteBlock(message, await quotableHtml(message, false), "reply", quoteDate);
				const subject = prefixSubject(message.subject, "Re");
				open({
					mailboxId: mailbox.id,
					draftId: null,
					title: subject,
					seed: { to, cc, bcc: [], subject, body, quote, parent: { messageId: message.id, kind: "reply" }, inheritedAttachments: [] },
				});
			},
			async forward(message: MessageDetail) {
				const quote = quoteBlock(message, await quotableHtml(message, true), "forward", quoteDate);
				const subject = prefixSubject(message.subject, "Fwd");
				open({
					mailboxId: mailbox.id,
					draftId: null,
					title: subject,
					seed: {
						to: [],
						cc: [],
						bcc: [],
						subject,
						body,
						quote,
						parent: { messageId: message.id, kind: "forward" },
						inheritedAttachments: message.attachments,
					},
				});
			},
			openDraft(draftId: string, title = "Draft") {
				open({ mailboxId: mailbox.id, draftId, title, seed: null });
			},
		};
	}, [open, mailbox.id, mailbox.address, signature]);
}

export type Composer = ReturnType<typeof useComposer>;
