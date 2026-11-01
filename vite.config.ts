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

export default defineConfig(({ command }) => ({
	plugins: [
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
