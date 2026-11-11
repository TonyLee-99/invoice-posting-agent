import { defineConfig } from "@playwright/test";
// For the static export only: `STATIC_URL=http://host/invoice-posting-agent/demo/ npx playwright test -c playwright.static.config.ts`
export default defineConfig({ testDir: "e2e", testMatch: "static.spec.ts", use: { viewport: { width: 1480, height: 900 } } });
