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
			},
		}),
	],
	test: {
		include: ["test/**/*.test.ts"],
	},
});
