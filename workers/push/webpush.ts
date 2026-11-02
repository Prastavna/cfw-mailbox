/**
 * Web Push with nothing but WebCrypto: VAPID authentication (RFC 8292) and payload encryption
 * with the "aes128gcm" content coding (RFC 8188, RFC 8291). The push service only ever sees
 * ciphertext; the browser that subscribed holds the key that opens it.
 */

export interface PushSubscriptionKeys {
	endpoint: string;
	/** The browser's P-256 public key, base64url (65 bytes uncompressed). */
	p256dh: string;
	/** The browser's auth secret, base64url (16 bytes). */
	auth: string;
}

/** The server's VAPID key pair. `publicKey` is what browsers pass as `applicationServerKey`. */
export interface VapidKeys {
	publicKey: string;
	privateKey: JsonWebKey;
}

const enc = new TextEncoder();
type Bytes = Uint8Array<ArrayBuffer>;

export function toBase64Url(bytes: Uint8Array | ArrayBuffer): string {
	const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let s = "";
	for (const x of b) s += String.fromCharCode(x);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(s: string): Bytes {
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
	return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function concat(...parts: Uint8Array[]): Bytes {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

/** HKDF-SHA-256 (extract and expand) to `bytes` bytes. */
async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, bytes: number): Promise<Bytes> {
	const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
	return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

export async function generateVapidKeys(): Promise<VapidKeys> {
	const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
	const publicKey = toBase64Url((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
	const privateKey = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
	return { publicKey, privateKey };
}

/** The `Authorization` header for a push service: a short-lived ES256 JWT for its origin. */
export async function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): Promise<string> {
	const header = toBase64Url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
	const claims = toBase64Url(
		enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })),
	);
	const key = await crypto.subtle.importKey("jwk", keys.privateKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
	// WebCrypto's ECDSA signature is already the raw r||s form JWS wants.
	const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${claims}`));
	return `vapid t=${header}.${claims}.${toBase64Url(signature)}, k=${keys.publicKey}`;
}

/** Encrypts one push message for one subscription (a single aes128gcm record). */
export async function encryptPayload(sub: Pick<PushSubscriptionKeys, "p256dh" | "auth">, plaintext: Uint8Array): Promise<Bytes> {
	const uaPublic = fromBase64Url(sub.p256dh);
	const authSecret = fromBase64Url(sub.auth);
	if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error("Invalid p256dh key");
	if (authSecret.length < 16) throw new Error("Invalid auth secret");

	const ephemeral = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
	const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", ephemeral.publicKey)) as ArrayBuffer);
	const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
	const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, ephemeral.privateKey, 256));

	// RFC 8291 §3.4: mix in the auth secret and both public keys.
	const ikm = await hkdf(authSecret, ecdhSecret, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
	const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

	// One record: the plaintext, then the 0x02 "last record" delimiter.
	const record = concat(plaintext, Uint8Array.of(2));
	const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, record));

	// Header: salt, record size, key ID length, key ID (the ephemeral public key).
	const rs = new Uint8Array(4);
	new DataView(rs.buffer).setUint32(0, 4096);
	return concat(salt, rs, Uint8Array.of(asPublic.length), asPublic, ciphertext);
}

/** Largest plaintext we send: push services accept 4096 bytes of ciphertext, minus overhead. */
export const MAX_PUSH_PLAINTEXT = 3000;

/**
 * Push services this server will deliver to. The endpoint comes from the browser, so without a
 * list a user could make the Worker POST to any URL.
 */
const PUSH_HOSTS = [
	/^fcm\.googleapis\.com$/,
	/^android\.googleapis\.com$/,
	/^updates\.push\.services\.mozilla\.com$/,
	/^(.+\.)?push\.apple\.com$/,
	/^(.+\.)?notify\.windows\.com$/,
];

export function isAllowedPushEndpoint(endpoint: string): boolean {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return false;
	}
	return url.protocol === "https:" && !url.username && !url.password && PUSH_HOSTS.some((h) => h.test(url.hostname));
}
