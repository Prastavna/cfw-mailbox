import { api } from "./api";
import { handleInbound } from "./email/inbound";
import { withSecurityHeaders } from "./lib/security-headers";

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
			const response =
				pathname === "/api" || pathname.startsWith("/api/") ? await api.fetch(request, env, ctx) : await fallback(request, env, ctx);
			return withSecurityHeaders(request, response);
		},
		async email(message, env, ctx) {
			await handleInbound(message, env, ctx);
		},
	} satisfies ExportedHandler<Env>;
}
