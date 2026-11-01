import { normalizeAddress } from "../../../shared/address";
import { AI_PROVIDERS, type AiProvider, type AiSettings, type AiSettingsUpdate } from "../../../shared/extensions";
import { canStoreSecrets, openSecret, sealSecret } from "../../lib/crypto";
import { HttpError } from "../../lib/http";
import { getRegistry } from "../../registry/RegistryDO";
import type { AiConfig } from "./models";

interface StoredAiSettings {
	provider: AiProvider;
	model: string;
	baseUrl: string | null;
	keyHint: string | null;
}

const DEFAULTS: StoredAiSettings = { provider: "anthropic", model: AI_PROVIDERS.anthropic.defaultModel, baseUrl: null, keyHint: null };

/** Binds the stored key to its owner, so the ciphertext is useless in anyone else's row. */
const secretContext = (email: string) => `ai-key:${normalizeAddress(email)}`;

async function load(env: Env, email: string) {
	const row = await getRegistry(env).getUserExtension(email, "ai");
	const stored: StoredAiSettings = { ...DEFAULTS, ...(row ? (JSON.parse(row.settings) as Partial<StoredAiSettings>) : {}) };
	return { enabled: row?.enabled ?? false, stored, secret: row?.secret ?? null };
}

function view(env: Env, enabled: boolean, s: StoredAiSettings, secret: string | null): AiSettings {
	return {
		enabled,
		provider: s.provider,
		model: s.model,
		baseUrl: s.baseUrl,
		hasKey: secret !== null,
		keyHint: secret !== null ? s.keyHint : null,
		canStoreKeys: canStoreSecrets(env),
	};
}

export async function getAiSettings(env: Env, email: string): Promise<AiSettings> {
	const { enabled, stored, secret } = await load(env, email);
	return view(env, enabled, stored, secret);
}

/** Whether the settings are complete enough to call the provider. */
export function isReady(s: AiSettings): boolean {
	const p = AI_PROVIDERS[s.provider];
	return !!s.model && (!p.needsKey || s.hasKey) && (!p.needsBaseUrl || !!s.baseUrl);
}

export function validateBaseUrl(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new HttpError(400, "The server URL isn't valid");
	}
	const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
		throw new HttpError(400, "The server URL must use https:// (http:// only works for localhost)");
	}
	if (url.username || url.password) throw new HttpError(400, "Put credentials in the API key field, not the URL");
	return url.toString().replace(/\/+$/, "");
}

export async function saveAiSettings(env: Env, email: string, update: AiSettingsUpdate): Promise<AiSettings> {
	const current = await load(env, email);
	const next: StoredAiSettings = { ...current.stored };
	let secret = current.secret;

	if (update.provider && update.provider !== next.provider) {
		// A key belongs to one provider: switching drops it, and picks that provider's default model.
		next.provider = update.provider;
		next.model = AI_PROVIDERS[update.provider].defaultModel;
		next.baseUrl = null;
		next.keyHint = null;
		secret = null;
	}
	if (update.model !== undefined) next.model = update.model.trim();
	if (update.baseUrl !== undefined) next.baseUrl = update.baseUrl ? validateBaseUrl(update.baseUrl) : null;
	if (update.apiKey === null) {
		secret = null;
		next.keyHint = null;
	} else if (update.apiKey !== undefined) {
		const key = update.apiKey.trim();
		secret = await sealSecret(env, key, secretContext(email)).catch((err: Error) => {
			throw new HttpError(503, err.message);
		});
		next.keyHint = key.length > 8 ? key.slice(-4) : null;
	}
	if (next.provider === "workers-ai") secret = null;

	const enabled = update.enabled ?? current.enabled;
	await getRegistry(env).saveUserExtension(email, "ai", { enabled, settings: JSON.stringify(next), secret });
	return view(env, enabled, next, secret);
}

/**
 * The user's provider config with the key decrypted, or an error explaining what's missing.
 * Every AI endpoint starts here, so nothing runs for users who haven't turned the extension on.
 */
export async function requireAiConfig(env: Env, email: string, opts: { whileDisabled?: boolean; withoutModel?: boolean } = {}): Promise<AiConfig> {
	const { enabled, stored, secret } = await load(env, email);
	if (!enabled && !opts.whileDisabled) throw new HttpError(403, "Turn on the AI Assistant in the apps menu first.");
	const provider = AI_PROVIDERS[stored.provider];
	let apiKey: string | null = null;
	if (secret) {
		apiKey = await openSecret(env, secret, secretContext(email));
		if (apiKey === null) throw new HttpError(400, "Your saved API key can't be read any more. Enter it again in AI Assistant settings.");
	}
	if (provider.needsKey && !apiKey) throw new HttpError(400, `Add your ${provider.label} API key in AI Assistant settings.`);
	if (provider.needsBaseUrl && !stored.baseUrl) throw new HttpError(400, "Add your AI server's URL in AI Assistant settings.");
	if (!stored.model && !opts.withoutModel) throw new HttpError(400, "Choose a model in AI Assistant settings.");
	return { provider: stored.provider, model: stored.model, apiKey, baseUrl: stored.baseUrl };
}
