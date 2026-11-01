import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

/** `pnpm dev` signs you in without Cloudflare Access. .dev.vars overrides these. */
const DEV_VARS = {
	AUTH_MODE: "dev",
	DEV_USER_EMAIL: "dev@example.com",
	ADMIN_EMAILS: "dev@example.com",
	// Only protects keys stored in local dev state. Production sets its own secret.
	ENCRYPTION_KEY: "local-development-only-not-secret",
};

/** `DEMO=1`: the static showcase with fake data (app/demo/), no Worker. */
const demo = !!process.env.DEMO;

export default defineConfig(({ command }) => ({
	base: demo ? (process.env.DEMO_BASE ?? "/") : "/",
	define: demo ? { "import.meta.env.VITE_DEMO": JSON.stringify("1") } : undefined,
	plugins: [
		!demo &&
			cloudflare({
				viteEnvironment: { name: "ssr" },
				// The end-to-end tests run against their own, throwaway local state.
				persistState: process.env.E2E ? { path: ".wrangler/e2e-state" } : true,
				config: command === "serve" ? (config) => ({ vars: { ...config.vars, ...DEV_VARS } }) : undefined,
			}),
		tailwindcss(),
		reactRouter(),
	],
	resolve: {
		tsconfigPaths: true,
	},
}));
