import { defineConfig } from "@playwright/test";

// Live end-to-end: seeds the demo (emulator + Postgres + API + worker), then drives the review UI.
export default defineConfig({
  testDir: "e2e",
  testIgnore: "static.spec.ts",
  timeout: 120_000,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:3000", viewport: { width: 1480, height: 900 } },
  webServer: [
    { command: "npx tsx ../../scripts/demo.ts --serve", url: "http://127.0.0.1:4000/api/health", timeout: 240_000, reuseExistingServer: false },
    { command: "npx next dev -p 3000 -H 127.0.0.1", url: "http://127.0.0.1:3000", timeout: 180_000, reuseExistingServer: true },
  ],
});
