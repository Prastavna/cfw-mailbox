import type { Config } from "@react-router/dev/config";

/**
 * `DEMO=1` builds the static showcase (see app/demo/): a single-page app with an
 * in-browser fake backend, served from GitHub Pages below DEMO_BASE.
 */
const demo = !!process.env.DEMO;

export default {
	// The Worker renders pages on the server; the demo has no server.
	ssr: !demo,
	basename: demo ? (process.env.DEMO_BASE ?? "/") : "/",
} satisfies Config;
