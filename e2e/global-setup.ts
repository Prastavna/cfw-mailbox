import { chromium, type FullConfig } from "@playwright/test";

/**
 * Opens the app once before the tests, so Vite finishes optimising dependencies (which
 * reloads the page) before any test is watching.
 */
export default async function globalSetup(config: FullConfig) {
	const { baseURL, launchOptions } = config.projects[0]!.use;
	const browser = await chromium.launch(launchOptions);
	const page = await browser.newPage({ baseURL });
	for (let attempt = 0; attempt < 3; attempt++) {
		await page.goto("/");
		await page.waitForLoadState("networkidle");
		await page.waitForTimeout(1500);
	}
	await browser.close();
}
