import { createRequestHandler, RouterContextProvider } from "react-router";
import { nonceContext } from "../app/lib/nonce";
import { createWorker } from "./index";

export { MailboxDO, RegistryDO } from "./index";

const requestHandler = createRequestHandler(() => import("virtual:react-router/server-build"), import.meta.env.MODE);

export default createWorker((request) => {
	const context = new RouterContextProvider();
	// A fresh nonce for each page; entry.server puts it in the Content-Security-Policy.
	context.set(nonceContext, btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))));
	return requestHandler(request, context);
});
