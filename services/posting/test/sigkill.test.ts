import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Harness } from "../src/index.ts";
import { checkInvariants, createHarness, drain, seedApproved } from "../src/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const workerBin = path.resolve(here, "../src/bin/worker.ts");
const tsx = path.resolve(here, "../../../node_modules/.bin/tsx");

let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe("A14 real process killed mid-post", () => {
  for (const point of ["before_remote_write", "after_remote_write"] as const) {
    it(`SIGKILL at ${point}: a new process recovers with zero duplicates`, async () => {
      h = await createHarness({ requestTimeoutMs: 300 });
      const { obligations } = await seedApproved(h, 1);
      const url = (h.db as unknown as { options: { connectionString: string } }).options.connectionString;
      const child = spawn(tsx, [workerBin], {
        env: {
          ...process.env, DATABASE_URL: url, QBO_API_BASE: h.emu.url, QBO_TOKEN_URL: `${h.emu.url}/oauth2/v1/tokens/bearer`, QBO_CLIENT_ID: h.emu.clientId,
          QBO_CLIENT_SECRET: h.emu.clientSecret, QBO_REALM_ID: h.emu.realmId, QBO_TIMEOUT_MS: "300", WORKER_LEASE_MS: "1200", WORKER_PAUSE_AT: point, WORKER_ID: "child",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("child never reached the pause point")), 20_000);
        child.stdout.on("data", (d: Buffer) => {
          if (d.toString().includes("PAUSED")) {
            clearTimeout(t);
            resolve();
          }
        });
      });
      child.kill("SIGKILL");
      await new Promise((r) => child.on("exit", r));
      expect(h.emu.creations()).toHaveLength(point === "after_remote_write" ? 1 : 0);
      const d = await drain(h, [h.worker()], { maxMs: 10_000 });
      expect(d.quiescent).toBe(true);
      expect(h.emu.creations()).toHaveLength(1);
      expect((await checkInvariants(h, obligations)).ok).toBe(true);
      const workers = (await h.db.query("select worker from post_attempts order by id")).rows.map((r) => r.worker);
      expect(workers[0]).toBe("child");
    }, 40_000);
  }
});
