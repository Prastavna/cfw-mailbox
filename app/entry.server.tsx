import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";
import { type EntryContext, type RouterContextProvider, ServerRouter } from "react-router";
import { appCsp, NonceContext, nonceContext } from "./lib/nonce";

export const streamTimeout = 5_000;

export default async function handleRequest(
	request: Request,
	responseStatusCode: number,
	responseHeaders: Headers,
	routerContext: EntryContext,
	loadContext: RouterContextProvider,
) {
	if (request.method.toUpperCase() === "HEAD") {
		return new Response(null, { status: responseStatusCode, headers: responseHeaders });
	}

	const nonce = loadContext.get(nonceContext);
	let shellRendered = false;
	const userAgent = request.headers.get("user-agent");

	const body = await renderToReadableStream(
		<NonceContext.Provider value={nonce}>
			<ServerRouter context={routerContext} url={request.url} nonce={nonce} />
		</NonceContext.Provider>,
		{
			nonce,
			signal: AbortSignal.timeout(streamTimeout + 1000),
			onError(error: unknown) {
				responseStatusCode = 500;
				// Errors in the shell are logged by React Router; log the ones after it.
				if (shellRendered) console.error(error);
			},
		},
	);
	shellRendered = true;

	if ((userAgent && isbot(userAgent)) || routerContext.isSpaMode) await body.allReady;

	responseHeaders.set("Content-Type", "text/html; charset=utf-8");
	if (nonce) responseHeaders.set("Content-Security-Policy", appCsp(nonce));
	return new Response(body, { headers: responseHeaders, status: responseStatusCode });
}
