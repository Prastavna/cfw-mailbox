import type { Context } from "hono";
import type { z } from "zod";
import type { MailboxRole } from "../../shared/api";
import type { Identity } from "../auth/access";
import { HttpError } from "../lib/http";

export type AppEnv = {
	Bindings: Env;
	Variables: { identity: Identity; role: MailboxRole };
};

export type AppContext = Context<AppEnv>;

/** Largest JSON body accepted: a draft at its size limit, with room for the other fields. */
const MAX_JSON_BYTES = 1024 * 1024;

export async function parseBody<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
	// Requiring JSON forces a CORS preflight for cross-site requests, which blocks form-based CSRF.
	if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
		throw new HttpError(415, "Content-Type must be application/json");
	}
	if (Number(req.headers.get("content-length") ?? 0) > MAX_JSON_BYTES) throw new HttpError(413, "Request body is too large");
	// The header can be missing (chunked uploads), so check what actually arrived too.
	const text = await req.text();
	if (text.length > MAX_JSON_BYTES) throw new HttpError(413, "Request body is too large");
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		throw new HttpError(400, "Body must be JSON");
	}
	const parsed = schema.safeParse(json);
	if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => i.message).join("; "));
	return parsed.data;
}

/**
 * Per-user budgets from the Workers rate limiting binding. They're counted per Cloudflare
 * location and are approximate: a guard against runaway clients and scripts, not a quota.
 */
export async function rateLimit(limiter: RateLimit | undefined, key: string) {
	if (!limiter) return;
	const { success } = await limiter.limit({ key });
	if (!success) throw new HttpError(429, "Too many requests. Wait a minute and try again.");
}

