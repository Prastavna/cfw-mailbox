import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration, useNavigate } from "react-router";

import type { Route } from "./+types/root";
import { Toaster } from "./components/ui/sonner";
import { useNonce } from "./lib/nonce";
import { registerServiceWorker, useServiceWorkerNavigation } from "./lib/pwa";
import "./app.css";

/** The static demo can't be installed: it lives below a path and has no server. */
const installable = !import.meta.env.VITE_DEMO;

export const links: Route.LinksFunction = () => [
	{ rel: "icon", href: `${import.meta.env.BASE_URL}favicon.ico`, sizes: "48x48" },
	...(installable
		? [
				{ rel: "icon", href: "/icons/icon.svg", type: "image/svg+xml" },
				{ rel: "apple-touch-icon", href: "/icons/apple-touch-icon.png" },
				// Behind Cloudflare Access the manifest needs the sign-in cookie.
				{ rel: "manifest", href: "/manifest.webmanifest", crossOrigin: "use-credentials" as const },
			]
		: []),
];

export function Layout({ children }: { children: React.ReactNode }) {
	const nonce = useNonce();
	return (
		<html lang="en">
			<head>
				<meta charSet="utf-8" />
				{/* viewport-fit=cover: the installed app draws under notches; app.css pads for them. */}
				<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
				<meta name="theme-color" media="(prefers-color-scheme: light)" content="#f6f8fc" />
				<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#111214" />
				<meta name="mobile-web-app-capable" content="yes" />
				<meta name="apple-mobile-web-app-title" content="Mail" />
				<meta name="apple-mobile-web-app-status-bar-style" content="default" />
				<Meta />
				<Links nonce={nonce} />
			</head>
			<body>
				{children}
				<ScrollRestoration nonce={nonce} />
				<Scripts nonce={nonce} />
			</body>
		</html>
	);
}

export default function App() {
	const navigate = useNavigate();
	useServiceWorkerNavigation(navigate);
	useEffect(() => registerServiceWorker(), []);
	const [queryClient] = useState(
		() => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: true } } }),
	);
	return (
		<QueryClientProvider client={queryClient}>
			<Outlet />
			<Toaster position="bottom-left" />
		</QueryClientProvider>
	);
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
	let message = "Something went wrong";
	let details = "An unexpected error occurred.";
	let stack: string | undefined;

	if (isRouteErrorResponse(error)) {
		message = error.status === 404 ? "Page not found" : "Error";
		details = error.status === 404 ? "The requested page could not be found." : error.statusText || details;
	} else if (import.meta.env.DEV && error instanceof Error) {
		details = error.message;
		stack = error.stack;
	}

	return (
		<main className="container mx-auto p-4 pt-16">
			<h1 className="text-xl font-medium">{message}</h1>
			<p className="text-muted-foreground">{details}</p>
			{stack && (
				<pre className="w-full overflow-x-auto p-4 text-xs">
					<code>{stack}</code>
				</pre>
			)}
		</main>
	);
}
