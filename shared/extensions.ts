/**
 * Extensions are optional features each user turns on for themselves, from the
 * apps launcher in the top bar. They're off until a user enables them, and an
 * extension that's off adds nothing to the interface and refuses its API calls.
 */

export type ExtensionId = "ai";

export interface ExtensionInfo {
	id: ExtensionId;
	name: string;
	description: string;
	enabled: boolean;
	/** Whether the extension has what it needs to run (for AI: a provider, key and model). */
	ready: boolean;
}

export const EXTENSIONS: Record<ExtensionId, { name: string; description: string }> = {
	ai: {
		name: "AI Assistant",
		description: "Summarise conversations, draft replies, rewrite text and ask questions about your mail, with your own AI provider.",
	},
};

// ---- AI Assistant -----------------------------------------------------------

export const AI_PROVIDERS = {
	anthropic: {
		label: "Anthropic",
		needsKey: true,
		needsBaseUrl: false,
		defaultModel: "claude-sonnet-5-5",
		keyUrl: "https://console.anthropic.com/settings/keys",
		keyPlaceholder: "sk-ant-…",
	},
	openai: {
		label: "OpenAI",
		needsKey: true,
		needsBaseUrl: false,
		defaultModel: "gpt-5-mini",
		keyUrl: "https://platform.openai.com/api-keys",
		keyPlaceholder: "sk-…",
	},
	google: {
		label: "Google Gemini",
		needsKey: true,
		needsBaseUrl: false,
		defaultModel: "gemini-2.5-flash",
		keyUrl: "https://aistudio.google.com/apikey",
		keyPlaceholder: "AIza…",
	},
	"openai-compatible": {
		label: "OpenAI-compatible",
		needsKey: false,
		needsBaseUrl: true,
		defaultModel: "",
		keyUrl: null,
		keyPlaceholder: "Optional for local servers",
	},
	"workers-ai": {
		label: "Workers AI",
		needsKey: false,
		needsBaseUrl: false,
		defaultModel: "@cf/zai-org/glm-4.7-flash",
		keyUrl: null,
		keyPlaceholder: "",
	},
} as const;

export type AiProvider = keyof typeof AI_PROVIDERS;
export const AI_PROVIDER_IDS = Object.keys(AI_PROVIDERS) as AiProvider[];

/** What the browser sees. The API key itself never leaves the server. */
export interface AiSettings {
	enabled: boolean;
	provider: AiProvider;
	model: string;
	/** For OpenAI-compatible servers (OpenRouter, Groq, Together, Ollama, LM Studio…). */
	baseUrl: string | null;
	hasKey: boolean;
	/** The key's last characters, to recognise it. */
	keyHint: string | null;
	/** Whether the server can store API keys (it needs the ENCRYPTION_KEY secret). */
	canStoreKeys: boolean;
}

export interface AiSettingsUpdate {
	enabled?: boolean;
	provider?: AiProvider;
	model?: string;
	baseUrl?: string | null;
	/** A new key; null removes the stored one; leave out to keep it. */
	apiKey?: string | null;
}

export interface AiModelOption {
	id: string;
	name: string;
}

export const REWRITE_MODES = {
	proofread: "Fix spelling and grammar",
	shorten: "Shorten",
	elaborate: "Elaborate",
	formal: "More formal",
	friendly: "More friendly",
} as const;

export type RewriteMode = keyof typeof REWRITE_MODES;

export interface AiWriteRequest {
	/** What the message should say. */
	instructions: string;
	/** The message being replied to or forwarded, for context. */
	parentMessageId?: string;
	subject?: string;
	to?: string[];
	/** What's already in the body, to continue or rework it. */
	current?: string;
}

export interface AiRewriteRequest {
	text: string;
	mode?: RewriteMode;
	/** Free-form instead of a mode, e.g. "translate to French". */
	instructions?: string;
}

/** What the chat's tools return, so the panel can link to the conversations they found. */
export interface AiThreadHit {
	threadId: string;
	subject: string;
	from: string;
	date: string;
	snippet: string;
	unread: boolean;
}

export const AI_LIMITS = {
	instructionsChars: 2000,
	rewriteChars: 20_000,
	chatMessages: 40,
	chatChars: 4000,
} as const;
