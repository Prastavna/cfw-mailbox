import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { normalizeAddress } from "../../shared/address";
import { HttpError } from "../lib/http";

/**
 * Who is making this request?
 *
 * Production: the Worker sits behind Cloudflare Access, which signs every
 * request with a JWT in `Cf-Access-Jwt-Assertion`. We verify it ourselves too,
 * so a misconfigured route can't expose mail.
 *
 * Local development: AUTH_MODE=dev trusts DEV_USER_EMAIL, but only for requests
 * to localhost. Any other mode, or missing config, fails closed.
 */

export interface Identity {
	email: string;
	isAdmin: boolean;
}

const jwksCache = new Map<string, JWTVerifyGetKey>();

function teamOrigin(teamDomain: string): string {
	const url = new URL(teamDomain.includes("://") ? teamDomain : `https://${teamDomain}`);
	return url.origin;
}

function jwksFor(origin: string): JWTVerifyGetKey {
	let jwks = jwksCache.get(origin);
	if (!jwks) {
		jwks = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", origin));
		jwksCache.set(origin, jwks);
	}
	return jwks;
}

export function adminEmails(env: Env): Set<string> {
	return new Set(
		(env.ADMIN_EMAILS ?? "")
			.split(",")
			.map((e) => normalizeAddress(e))
			.filter(Boolean),
	);
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export async function authenticate(request: Request, env: Env): Promise<Identity> {
	const email = await resolveEmail(request, env);
	return { email, isAdmin: adminEmails(env).has(email) };
}

async function resolveEmail(request: Request, env: Env): Promise<string> {
	const mode = env.AUTH_MODE || "access";

	if (mode === "dev") {
		if (!LOCAL_HOSTS.has(new URL(request.url).hostname)) {
			throw new HttpError(500, "AUTH_MODE=dev is only allowed on localhost");
		}
		// Set only in .dev.vars, so it may be missing from the generated Env type.
		const devEmail = (env as { DEV_USER_EMAIL?: string }).DEV_USER_EMAIL;
		if (!devEmail) throw new HttpError(500, "AUTH_MODE=dev requires DEV_USER_EMAIL");
		return normalizeAddress(devEmail);
	}

	if (mode !== "access") throw new HttpError(500, `Unknown AUTH_MODE "${mode}"`);
	if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
		throw new HttpError(500, "Cloudflare Access is not configured: set ACCESS_TEAM_DOMAIN and ACCESS_AUD");
	}

	const token = request.headers.get("Cf-Access-Jwt-Assertion");
	if (!token) throw new HttpError(401, "Missing Cloudflare Access token");

	const origin = teamOrigin(env.ACCESS_TEAM_DOMAIN);
	try {
		const { payload } = await jwtVerify(token, jwksFor(origin), { issuer: origin, audience: env.ACCESS_AUD });
		if (typeof payload.email !== "string" || !payload.email) {
			throw new HttpError(403, "Access token has no email (service tokens can't open mailboxes)");
		}
		return normalizeAddress(payload.email);
	} catch (err) {
		if (err instanceof HttpError) throw err;
		throw new HttpError(401, "Invalid or expired Cloudflare Access token");
	}
}
