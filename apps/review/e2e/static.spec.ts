import { expect, test } from "@playwright/test";
import path from "node:path";

// Runs only when STATIC_URL is set (the GitHub Pages export served locally): checks it works with no server.
const url = process.env.STATIC_URL;
test.skip(!url, "STATIC_URL not set");
test("static demo renders recorded data without an API", async ({ page }) => {
  await page.goto(url!);
  await expect(page.locator("[data-testid^=row-]").first()).toBeVisible();
  await expect(page.getByText("Static demo recorded from a real run")).toBeVisible();
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.resolve(import.meta.dirname, "../../../docs/img/static-demo.png") });
});
