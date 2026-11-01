import { api } from "./api";
import { handleInbound } from "./email/inbound";

export { MailboxDO } from "./mailbox/MailboxDO";
export { RegistryDO } from "./registry/RegistryDO";

type Fallback = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response> | Response;

/**
 * The Worker's handlers. `/api/*` goes to the API; every other request goes to
 * `fallback` (the React Router app in production, a 404 in tests).
 */
export function createWorker(fallback: Fallback) {
	return {
		async fetch(request, env, ctx) {
			const { pathname } = new URL(request.url);
			if (pathname === "/api" || pathname.startsWith("/api/")) return api.fetch(request, env, ctx);
			return fallback(request, env, ctx);
		},
		async email(message, env) {
			await handleInbound(message, env);
		},
	} satisfies ExportedHandler<Env>;
}
