import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAI } from "agents/models/ai-sdk";
import type { LanguageModel } from "ai";
import type { AiModelOption, AiProvider } from "../../../shared/extensions";
import { HttpError } from "../../lib/http";

export interface AiConfig {
	provider: AiProvider;
	model: string;
	apiKey: string | null;
	baseUrl: string | null;
}

/** Builds the AI SDK model for a user's settings. Tests replace `create` with a mock. */
export const aiModels = {
	create(env: Env, config: AiConfig): LanguageModel {
		const { provider, model, apiKey, baseUrl } = config;
		switch (provider) {
			case "anthropic":
				return createAnthropic({ apiKey: apiKey ?? "" })(model);
			case "openai":
				return createOpenAI({ apiKey: apiKey ?? "" })(model);
			case "google":
				return createGoogle({ apiKey: apiKey ?? "" })(model);
			case "openai-compatible":
				return createOpenAICompatible({ name: "custom", baseURL: baseUrl ?? "", apiKey: apiKey ?? undefined })(model);
			case "workers-ai":
				return createAI({ binding: env.AI }).languageModel(model);
		}
	},
};

/**
 * Lists the provider's models with the user's key, so people pick a real model ID rather
 * than guess one. Filters out models that can't chat (embeddings, images, speech…).
 */
export async function listModels(env: Env, config: AiConfig): Promise<AiModelOption[]> {
	const { provider, apiKey, baseUrl } = config;
	const get = async (url: string, headers: Record<string, string>) => {
		const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
		if (res.status === 401 || res.status === 403) throw new HttpError(400, `${providerName(provider)} didn't accept the API key.`);
		if (!res.ok) throw new HttpError(502, `${providerName(provider)} couldn't list models (HTTP ${res.status}).`);
		return res.json<Record<string, unknown>>();
	};
	const notChat = /embed|tts|whisper|dall-e|image|audio|moderation|realtime|transcribe|search|computer-use|davinci|babbage|sora|veo|imagen|aqa/i;

	switch (provider) {
		case "anthropic": {
			const body = await get("https://api.anthropic.com/v1/models?limit=100", { "x-api-key": apiKey ?? "", "anthropic-version": "2023-06-01" });
			return (body.data as { id: string; display_name?: string }[]).map((m) => ({ id: m.id, name: m.display_name ?? m.id }));
		}
		case "openai": {
			const body = await get("https://api.openai.com/v1/models", { authorization: `Bearer ${apiKey}` });
			return (body.data as { id: string }[])
				.filter((m) => !notChat.test(m.id))
				.map((m) => ({ id: m.id, name: m.id }))
				.sort((a, b) => a.id.localeCompare(b.id));
		}
		case "google": {
			const body = await get("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", { "x-goog-api-key": apiKey ?? "" });
			return (body.models as { name: string; displayName?: string; supportedGenerationMethods?: string[] }[])
				.filter((m) => m.supportedGenerationMethods?.includes("generateContent") && !notChat.test(m.name))
				.map((m) => ({ id: m.name.replace(/^models\//, ""), name: m.displayName ?? m.name }));
		}
		case "openai-compatible": {
			const body = await get(`${(baseUrl ?? "").replace(/\/+$/, "")}/models`, apiKey ? { authorization: `Bearer ${apiKey}` } : {});
			return ((body.data ?? []) as { id: string }[]).map((m) => ({ id: m.id, name: m.id })).sort((a, b) => a.id.localeCompare(b.id));
		}
		case "workers-ai": {
			const models = await env.AI.models({ task: "Text Generation", per_page: 200, hide_experimental: true });
			return models
				.filter((m) => m.properties?.some((p) => p.property_id === "function_calling" && String(p.value) === "true") ?? true)
				.map((m) => ({ id: m.name, name: m.name.replace(/^@cf\//, "") }))
				.sort((a, b) => a.id.localeCompare(b.id));
		}
	}
}

export const providerName = (p: AiProvider) =>
	({ anthropic: "Anthropic", openai: "OpenAI", google: "Google", "openai-compatible": "The AI server", "workers-ai": "Workers AI" })[p];
