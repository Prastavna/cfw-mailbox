import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiError } from "../../shared/api";
import type { AiModelOption, AiSettings, AiSettingsUpdate, ExtensionInfo } from "../../shared/extensions";
import { ApiRequestError, apiFetch, apiUrl } from "./api";

export const extensionKeys = {
	all: ["extensions"] as const,
	ai: ["extensions", "ai"] as const,
	aiModels: ["extensions", "ai", "models"] as const,
};

export function useExtensions() {
	return useQuery({ queryKey: extensionKeys.all, queryFn: () => apiFetch<ExtensionInfo[]>("/extensions"), staleTime: 60_000 });
}

/** True when the user has turned the AI Assistant on and it has what it needs to run. */
export function useAiReady(): boolean {
	const { data } = useExtensions();
	const ai = data?.find((e) => e.id === "ai");
	return !!ai?.enabled && ai.ready;
}

export function useAiSettings(enabled = true) {
	return useQuery({ queryKey: extensionKeys.ai, queryFn: () => apiFetch<AiSettings>("/extensions/ai"), enabled });
}

export function useSaveAiSettings() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (update: AiSettingsUpdate) => apiFetch<AiSettings>("/extensions/ai", { method: "PUT", body: JSON.stringify(update) }),
		onSuccess: (saved) => {
			queryClient.setQueryData(extensionKeys.ai, saved);
			queryClient.invalidateQueries({ queryKey: extensionKeys.all, exact: true });
			queryClient.removeQueries({ queryKey: extensionKeys.aiModels });
		},
	});
}

export function useAiModels(enabled: boolean) {
	return useQuery({
		queryKey: extensionKeys.aiModels,
		queryFn: () => apiFetch<AiModelOption[]>("/extensions/ai/models"),
		enabled,
		retry: false,
		staleTime: 10 * 60_000,
	});
}

/** POSTs to an AI endpoint and streams the plain-text answer as it's written. */
export async function streamAiText(path: string, body: unknown, onText: (soFar: string) => void, signal?: AbortSignal): Promise<string> {
	const res = await fetch(apiUrl(path), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});
	if (!res.ok) {
		const err = (await res.json().catch(() => null)) as ApiError | null;
		throw new ApiRequestError(res.status, err?.error ?? res.statusText);
	}
	const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
	let text = "";
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			text += value;
			onText(text);
		}
	} catch (err) {
		if (signal?.aborted) throw err;
		throw new Error(text ? "The answer was cut off. Try again." : "The AI provider didn't answer. Try again.");
	}
	if (!text.trim()) throw new Error("The model returned an empty answer. Try again, or choose another model.");
	return text;
}

export type AiRunState = { status: "idle" } | { status: "running"; text: string } | { status: "done"; text: string } | { status: "error"; error: string; text: string };

/** One AI request at a time, cancellable, with its streamed text as state. */
export function useAiRun() {
	const [state, setState] = useState<AiRunState>({ status: "idle" });
	const controller = useRef<AbortController | null>(null);

	const cancel = useCallback(() => {
		controller.current?.abort();
		controller.current = null;
	}, []);
	useEffect(() => cancel, [cancel]);

	const run = useCallback(
		async (path: string, body: unknown) => {
			cancel();
			const c = new AbortController();
			controller.current = c;
			setState({ status: "running", text: "" });
			try {
				const text = await streamAiText(path, body, (t) => !c.signal.aborted && setState({ status: "running", text: t }), c.signal);
				if (!c.signal.aborted) setState({ status: "done", text: text.trim() });
				return text.trim();
			} catch (err) {
				if (c.signal.aborted) return null;
				setState((s) => ({ status: "error", error: (err as Error).message, text: "text" in s ? s.text : "" }));
				return null;
			}
		},
		[cancel],
	);

	const reset = useCallback(() => {
		cancel();
		setState({ status: "idle" });
	}, [cancel]);

	return { state, run, cancel: reset, reset };
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Model text (blank lines between paragraphs) as editor HTML. */
export function textToHtml(text: string): string {
	return text
		.trim()
		.split(/\n{2,}/)
		.map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
		.join("");
}
