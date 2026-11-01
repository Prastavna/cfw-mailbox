/**
 * Encrypts users' secrets (AI provider keys) before they're stored, with AES-256-GCM under a
 * key derived from the ENCRYPTION_KEY secret. Each ciphertext is bound to its owner and
 * purpose (`context`), so it can't be copied to another user's row and decrypted there.
 */

const VERSION = "v1";

export class MissingEncryptionKeyError extends Error {
	constructor() {
		super("This server can't store API keys until an administrator sets the ENCRYPTION_KEY secret.");
	}
}

export const canStoreSecrets = (env: Pick<Env, "ENCRYPTION_KEY">) => (env.ENCRYPTION_KEY ?? "").length >= 16;

const keys = new Map<string, Promise<CryptoKey>>();

function deriveKey(secret: string): Promise<CryptoKey> {
	let key = keys.get(secret);
	if (!key) {
		key = (async () => {
			const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, ["deriveKey"]);
			return crypto.subtle.deriveKey(
				{ name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("cfw-mailbox"), info: new TextEncoder().encode("user-secrets/v1") },
				material,
				{ name: "AES-GCM", length: 256 },
				false,
				["encrypt", "decrypt"],
			);
		})();
		keys.set(secret, key);
	}
	return key;
}

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function sealSecret(env: Pick<Env, "ENCRYPTION_KEY">, plaintext: string, context: string): Promise<string> {
	if (!canStoreSecrets(env)) throw new MissingEncryptionKeyError();
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const sealed = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) },
		await deriveKey(env.ENCRYPTION_KEY),
		new TextEncoder().encode(plaintext),
	);
	return `${VERSION}.${toBase64(iv)}.${toBase64(new Uint8Array(sealed))}`;
}

/** Null when the secret can't be opened (wrong context, or ENCRYPTION_KEY changed). */
export async function openSecret(env: Pick<Env, "ENCRYPTION_KEY">, sealed: string, context: string): Promise<string | null> {
	if (!canStoreSecrets(env)) return null;
	const [version, iv, data] = sealed.split(".");
	if (version !== VERSION || !iv || !data) return null;
	try {
		const plain = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: fromBase64(iv), additionalData: new TextEncoder().encode(context) },
			await deriveKey(env.ENCRYPTION_KEY),
			fromBase64(data),
		);
		return new TextDecoder().decode(plain);
	} catch {
		return null;
	}
}
