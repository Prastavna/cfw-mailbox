/** Headers every response gets unless it already sets them. */
const DEFAULTS: Record<string, string> = {
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "same-origin",
	"X-Frame-Options": "DENY",
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Resource-Policy": "same-origin",
	"Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
};

/** Adds the default security headers (and HSTS over HTTPS). WebSocket upgrades pass through untouched. */
export function withSecurityHeaders(request: Request, response: Response): Response {
	if (response.status === 101 || response.webSocket) return response;
	const headers = new Headers(response.headers);
	for (const [name, value] of Object.entries(DEFAULTS)) if (!headers.has(name)) headers.set(name, value);
	if (new URL(request.url).protocol === "https:") headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
