import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 5180);

/**
 * End-to-end tests against `pnpm dev` (local dev auth, simulated sending), with state kept in
 * .wrangler/e2e-state, apart from your own dev data. Each test makes its own mailbox.
 *
 *   pnpm exec playwright install chromium   # once
 *   pnpm test:e2e
 */
export default defineConfig({
	testDir: "./e2e",
	globalSetup: "./e2e/global-setup.ts",
	timeout: 60_000,
	expect: { timeout: 10_000 },
	fullyParallel: true,
	workers: process.env.CI ? 2 : 3,
	retries: process.env.CI ? 1 : 0,
	forbidOnly: !!process.env.CI,
	reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
	use: {
		baseURL: `http://localhost:${PORT}`,
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
		launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {},
	},
	projects: [
		{ name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } }, testIgnore: /mobile\.spec/ },
		{ name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: /mobile\.spec/ },
	],
	webServer: {
		command: `pnpm dev --port ${PORT} --strictPort`,
		url: `http://localhost:${PORT}/api/health`,
		env: { E2E: "1" },
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
		stdout: "ignore",
		stderr: "pipe",
	},
});
