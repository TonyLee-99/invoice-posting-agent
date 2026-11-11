// Deterministic schedules that each defense exists for. With the defense off the schedule must produce a
// duplicate Bill (the test fails if it does not: that would mean the defense is untested or unnecessary);
// with it on, zero duplicates. Complements the random chaos ablations in results/chaos.json.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CrashPoint, Defenses, Harness, WorkerHooks } from "../src/index.ts";
import { ALL_DEFENSES, SimulatedCrash, createHarness, drain, seedApproved } from "../src/index.ts";

let h: Harness;
afterEach(async () => {
  await h?.close();
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dupCount = () => h.emu.creations().length - new Set(h.emu.creations().map((c) => c.docNumber)).size;
const snapshot = () => path.join(mkdtempSync(path.join(os.tmpdir(), "abl-")), "s.json");

function crashOnce(point: CrashPoint): WorkerHooks {
  let fired = false;
  return { at: (p) => { if (p === point && !fired) { fired = true; throw new SimulatedCrash(p); } } };
}

async function timeoutWithLag(defenses: Defenses) {
  h = await createHarness({ emulator: { queryLagMs: 10_000 } });
  await seedApproved(h, 1);
  h.emu.setFaults([{ op: "create", effect: "hang_after_commit", times: 1 }]);
  await drain(h, [h.worker({ defenses })]);
  return dupCount();
}

async function crashThenRestart(defenses: Defenses) {
  h = await createHarness({ emulator: { snapshotPath: snapshot(), persistRequestIds: false } });
  await seedApproved(h, 1);
  await drain(h, [h.worker({ defenses, hooks: crashOnce("after_remote_write") })], { maxMs: 50 });
  await h.restartEmulator();
  await drain(h, [h.worker({ defenses })]);
  return dupCount();
}

async function staleWorkerAfterRestart(defenses: Defenses) {
  h = await createHarness({ emulator: { snapshotPath: snapshot(), persistRequestIds: false } });
  await seedApproved(h, 1);
  let release!: () => void;
  let arrived!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const reached = new Promise<void>((r) => (arrived = r));
  let used = false;
  const w1 = h.worker({ defenses, hooks: { async at(p) { if (p === "before_remote_write" && !used) { used = true; arrived(); await gate; } } } });
  const t1 = w1.tick();
  await reached; // W1 paused (GC / frozen VM) after its query, before sending
  await sleep(h.requestTimeoutMs * 4 + 50);
  await drain(h, [h.worker({ defenses })]); // W2 takes over and posts
  await h.restartEmulator(); // the ledger forgets requestids
  release();
  await t1;
  return dupCount();
}

describe("defense ablations (deterministic schedules)", () => {
  it("stable requestid: timeout-after-commit + query lag duplicates without it, not with it", async () => {
    expect(await timeoutWithLag({ ...ALL_DEFENSES, stableRequestId: false })).toBe(1);
    await h.close();
    expect(await timeoutWithLag(ALL_DEFENSES)).toBe(0);
  });

  it("query-first: crash after write + requestid memory loss duplicates without it, not with it", async () => {
    expect(await crashThenRestart({ ...ALL_DEFENSES, queryFirst: false })).toBe(1);
    await h.close();
    expect(await crashThenRestart(ALL_DEFENSES)).toBe(0);
  });

  it("fencing and lease guard: a paused stale worker duplicates only when both are off", async () => {
    expect(await staleWorkerAfterRestart({ ...ALL_DEFENSES, fencing: false, leaseGuard: false })).toBe(1);
    await h.close();
    expect(await staleWorkerAfterRestart({ ...ALL_DEFENSES, fencing: true, leaseGuard: false })).toBe(0);
    await h.close();
    expect(await staleWorkerAfterRestart({ ...ALL_DEFENSES, fencing: false, leaseGuard: true })).toBe(0);
    await h.close();
    expect(await staleWorkerAfterRestart(ALL_DEFENSES)).toBe(0);
  });
});
