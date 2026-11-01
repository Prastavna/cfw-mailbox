import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export const TEST_ADMIN = "admin@example.test";

export default defineConfig({
	plugins: [
		cloudflareTest({
			main: "./test/worker.ts",
			wrangler: { configPath: "./wrangler.jsonc" },
			remoteBindings: false,
			miniflare: {
				bindings: {
					AUTH_MODE: "dev",
					DEV_USER_EMAIL: TEST_ADMIN,
					ADMIN_EMAILS: TEST_ADMIN,
				},
				// Tests make many requests as one user; test/limits.test.ts covers the 429 path.
				ratelimits: {
					API_LIMITER: { namespace_id: "41001", simple: { limit: 1_000_000, period: 60 } },
					HEAVY_LIMITER: { namespace_id: "41002", simple: { limit: 1_000_000, period: 60 } },
				},
			},
		}),
	],
	test: {
		include: ["test/**/*.test.ts"],
	},
});
