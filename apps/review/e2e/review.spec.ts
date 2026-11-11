import { expect, test } from "@playwright/test";
import path from "node:path";

const IMG = path.resolve(import.meta.dirname, "../../../docs/img");

test("review queue: edit voids approval, re-approve, worker posts; audit log records it", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("queue")).toBeVisible();
  await page.getByRole("button", { name: /needs review/i }).click();
  const first = page.locator("[data-testid^=row-]").first();
  await first.click();
  await expect(page.getByTestId("status")).toHaveText(/NEEDS REVIEW/);
  await page.waitForTimeout(1200); // let the document render for the screenshot
  await page.screenshot({ path: `${IMG}/review-queue.png` });

  // Edit a field: approval binding means the content hash changes and a fresh approval is required.
  const hashBefore = await page.locator(".hash").textContent();
  await page.getByTestId("field-dueDate").fill("2027-01-15");
  await page.getByTestId("save").click();
  await expect(page.locator(".hash")).not.toHaveText(hashBefore ?? "");
  await expect(page.getByTestId("status")).toHaveText(/NEEDS REVIEW/);

  await page.getByTestId("approve").click();
  await expect(page.getByTestId("status")).toHaveText(/APPROVED|POSTING|POSTED/);
  // The worker loop posts it to the QBO emulator within a few seconds.
  for (let i = 0; i < 20; i++) {
    await page.reload();
    if (/POSTED/.test((await page.getByTestId("status").textContent()) ?? "")) break;
    await page.waitForTimeout(1000);
  }
  await expect(page.getByTestId("status")).toHaveText(/POSTED/);
  await expect(page.getByTestId("posting")).toContainText("QBO Bill");
  await page.screenshot({ path: `${IMG}/posted-detail.png` });

  await page.getByRole("link", { name: "Audit log" }).first().click();
  await expect(page.getByTestId("audit-table")).toContainText("rematch after edit");
  await page.screenshot({ path: `${IMG}/audit-log.png` });
});

test("recovery queue shows the manually keyed duplicate with its evidence", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^recovery/i }).click();
  const rows = page.locator("[data-testid^=row-]");
  if ((await rows.count()) === 0) test.skip(true, "no recovery item in this seed");
  await rows.first().click();
  await expect(page.getByTestId("posting")).toContainText("recovery");
  await page.screenshot({ path: `${IMG}/recovery.png` });
});
