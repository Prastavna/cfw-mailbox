import { createContext as createReactContext, useContext } from "react";
import { createContext } from "react-router";

/** Per-request CSP nonce, created by the Worker and handed to React Router through its context. */
export const nonceContext = createContext<string>("");

/** The nonce while rendering on the server. */
export const NonceContext = createReactContext<string | undefined>(undefined);

/**
 * The page's nonce: from the server render, or in the browser from a script the server rendered
 * (browsers hide the attribute but keep the `nonce` property), so hydration sees the same props.
 */
export function useNonce(): string | undefined {
	const server = useContext(NonceContext);
	if (server !== undefined || typeof document === "undefined") return server;
	return document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce || undefined;
}

/** Content Security Policy for the app's HTML pages. */
export function appCsp(nonce: string): string {
	return [
		"default-src 'self'",
		`script-src 'self' 'nonce-${nonce}'`,
		// Radix and the editor set inline styles; email bodies use them too.
		"style-src 'self' 'unsafe-inline'",
		// Email bodies render in srcdoc iframes, which inherit this policy. Their own, stricter
		// policy blocks remote images until "Display images".
		"img-src 'self' data: blob: https: http:",
		"font-src 'self' data: https:",
		"media-src 'self' blob:",
		"connect-src 'self'",
		"frame-src 'self' blob:",
		"worker-src 'self' blob:",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'self'",
		"frame-ancestors 'none'",
	].join("; ");
}
