import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { ApiError, Label, MailboxEvent, Me, ThreadDetail, ThreadPage } from "../../shared/api";
import { noteResponseSource } from "./connection";

export class ApiRequestError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

/** The API's URL prefix. The app may be served below a base path (the static demo is). */
export const API_BASE = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

export const apiUrl = (path: string) => `${API_BASE}${path}`;

/**
 * URL for a file the browser opens itself (attachments, raw messages, exports) rather
 * than through fetch. The static demo replaces it, since it has no server.
 */
let fileUrl = apiUrl;
export const apiFileUrl = (path: string) => fileUrl(path);
export function setFileUrlResolver(resolve: (path: string) => string) {
	fileUrl = resolve;
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(apiUrl(path), {
		...init,
		headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
	});
	if (!init?.method || init.method === "GET") noteResponseSource(res);
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as ApiError | null;
		throw new ApiRequestError(res.status, body?.error ?? res.statusText);
	}
	return (res.status === 204 ? null : await res.json()) as T;
}

export const queryKeys = {
	me: ["me"] as const,
	mailbox: (mailboxId: string) => ["mailbox", mailboxId] as const,
	labels: (mailboxId: string) => ["mailbox", mailboxId, "labels"] as const,
	threads: (mailboxId: string, labelId: string) => ["mailbox", mailboxId, "threads", labelId] as const,
	thread: (mailboxId: string, threadId: string) => ["mailbox", mailboxId, "thread", threadId] as const,
};

export const PAGE_SIZE = 50;

export function useMe() {
	return useQuery({ queryKey: queryKeys.me, queryFn: () => apiFetch<Me>("/me") });
}

export function useLabels(mailboxId: string) {
	return useQuery({ queryKey: queryKeys.labels(mailboxId), queryFn: () => apiFetch<Label[]>(`/mailboxes/${mailboxId}/labels`) });
}

/** Cache key segment for a search's results, alongside label IDs. */
export const searchListKey = (query: string) => `search:${query}`;

export function useThreads(mailboxId: string, labelId: string | null, query?: string) {
	return useInfiniteQuery({
		queryKey: queryKeys.threads(mailboxId, query !== undefined ? searchListKey(query) : (labelId ?? "")),
		enabled: !!labelId || query !== undefined,
		initialPageParam: null as string | null,
		queryFn: ({ pageParam }) => {
			const params = new URLSearchParams(
				query !== undefined
					? { q: query, tz: String(new Date().getTimezoneOffset()), limit: String(PAGE_SIZE) }
					: { label: labelId!, limit: String(PAGE_SIZE) },
			);
			if (pageParam) params.set("cursor", pageParam);
			return apiFetch<ThreadPage>(`/mailboxes/${mailboxId}/threads?${params}`);
		},
		getNextPageParam: (last) => last.nextCursor,
	});
}

export function useThread(mailboxId: string, threadId: string) {
	return useQuery({
		queryKey: queryKeys.thread(mailboxId, threadId),
		queryFn: () => apiFetch<ThreadDetail>(`/mailboxes/${mailboxId}/threads/${threadId}`),
	});
}

export const attachmentUrl = (mailboxId: string, messageId: string, attachmentId: string, inline = false) =>
	apiFileUrl(`/mailboxes/${mailboxId}/messages/${messageId}/attachments/${attachmentId}${inline ? "?inline=1" : ""}`);

export const rawMessageUrl = (mailboxId: string, messageId: string) => apiFileUrl(`/mailboxes/${mailboxId}/messages/${messageId}/raw`);

export type LiveStatus = "connecting" | "live" | "offline";

/**
 * Keeps a WebSocket open to the mailbox and refreshes affected queries when
 * mail arrives. Reconnects with backoff, and refetches everything after a
 * reconnect in case events were missed.
 */
export function useMailboxEvents(mailboxId: string, drafts?: { openDraft: (id: string, title?: string) => void }): LiveStatus {
	const queryClient = useQueryClient();
	const [status, setStatus] = useState<LiveStatus>("connecting");
	// Kept in a ref so a new callback doesn't reconnect the socket.
	const draftsRef = useRef(drafts);
	draftsRef.current = drafts;

	useEffect(() => {
		let ws: WebSocket | null = null;
		let retry: ReturnType<typeof setTimeout> | undefined;
		let ping: ReturnType<typeof setInterval> | undefined;
		let attempts = 0;
		let stopped = false;

		const connect = () => {
			setStatus("connecting");
			const proto = location.protocol === "https:" ? "wss" : "ws";
			ws = new WebSocket(`${proto}://${location.host}${apiUrl(`/mailboxes/${mailboxId}/events`)}`);
			ws.onopen = () => {
				if (attempts > 0) queryClient.invalidateQueries({ queryKey: queryKeys.mailbox(mailboxId) });
				attempts = 0;
				setStatus("live");
				ping = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send("ping"), 30_000);
			};
			ws.onmessage = (e) => {
				if (e.data === "pong") return;
				const event = JSON.parse(e.data as string) as MailboxEvent;
				if (event.type === "threads.changed") {
					queryClient.invalidateQueries({ queryKey: queryKeys.labels(mailboxId) });
					queryClient.invalidateQueries({ queryKey: [...queryKeys.mailbox(mailboxId), "threads"] });
					for (const id of event.threadIds) queryClient.invalidateQueries({ queryKey: queryKeys.thread(mailboxId, id) });
				} else if (event.type === "send.failed") {
					toast.error(`"${event.subject || "(no subject)"}" wasn't sent`, {
						description: event.error,
						duration: 15_000,
						action: draftsRef.current
							? { label: "Open draft", onClick: () => draftsRef.current?.openDraft(event.draftId, event.subject) }
							: undefined,
					});
				}
			};
			ws.onclose = () => {
				clearInterval(ping);
				if (stopped) return;
				setStatus("offline");
				attempts++;
				retry = setTimeout(connect, Math.min(30_000, 1000 * 2 ** Math.min(attempts, 5)));
			};
		};

		connect();
		return () => {
			stopped = true;
			clearTimeout(retry);
			clearInterval(ping);
			ws?.close();
		};
	}, [mailboxId, queryClient]);

	return status;
}

const LAST_MAILBOX_KEY = "cfw-mailbox:last-mailbox";

export function rememberMailbox(id: string) {
	try {
		localStorage.setItem(LAST_MAILBOX_KEY, id);
	} catch {
		// Storage may be unavailable (private mode); not important.
	}
}

export function lastMailbox(): string | null {
	try {
		return localStorage.getItem(LAST_MAILBOX_KEY);
	} catch {
		return null;
	}
}
