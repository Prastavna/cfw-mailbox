import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";

async function start() {
	// The static showcase answers the API in the browser. Left out of real builds.
	if (import.meta.env.VITE_DEMO) await (await import("./demo/install")).installDemo();
	startTransition(() => {
		hydrateRoot(
			document,
			<StrictMode>
				<HydratedRouter />
			</StrictMode>,
		);
	});
}

void start();
