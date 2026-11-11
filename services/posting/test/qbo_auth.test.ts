// `make qbo-auth` callback settings: the redirect URI must match the Intuit app exactly, and a busy port is reported.
import { describe, expect, it } from "vitest";
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CALLBACK_PORT, REDIRECT_URI } from "../../../scripts/qbo/live.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const run = promisify(execFile);

describe("qbo-auth callback", () => {
  it("uses http://localhost:8777/callback", () => {
    expect(CALLBACK_PORT).toBe(8777);
    expect(REDIRECT_URI).toBe("http://localhost:8777/callback");
  });
  it("reports a busy callback port instead of failing obscurely", async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(CALLBACK_PORT, "127.0.0.1", r));
    try {
      const env = { ...process.env, QBO_REHEARSAL_CLIENT_ID: "x", QBO_REHEARSAL_CLIENT_SECRET: "y" };
      const err = await run(path.join(ROOT, "node_modules/.bin/tsx"), [path.join(ROOT, "scripts/qbo/auth.ts")], { env }).catch((e: { code: number; stdout: string }) => e);
      expect((err as { code: number }).code).toBe(1);
      expect((err as { stdout: string }).stdout).toContain("port 8777 is in use");
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  }, 60_000);
});
