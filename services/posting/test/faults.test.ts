// Deterministic fault scenarios (docs/ACCEPTANCE.md A1-A10, A16, A18). Each test injects one fault and checks
// invariants against the emulator's append-only creation log and the test's own obligation list.
import { afterEach, describe, expect, it } from "vitest";
import type { CrashPoint, Harness, OutboxWorker, WorkerHooks } from "../src/index.ts";
import { CONFIDENT, SimulatedCrash, checkInvariants, createHarness, drain, reconcile, seedApproved, simInvoice } from "../src/index.ts";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const crashOnce = (point: CrashPoint): WorkerHooks => {
  let fired = false;
  return {
    at(p) {
      if (p === point && !fired) {
        fired = true;
        throw new SimulatedCrash(p);
      }
    },
  };
};

/** Stall at `point` until released; resolves `reached` when the worker arrives there. */
function stallAt(point: CrashPoint) {
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const arrived = new Promise<void>((r) => (reached = r));
  let used = false;
  const hooks: WorkerHooks = {
    async at(p) {
      if (p === point && !used) {
        used = true;
        reached();
        await gate;
      }
    },
  };
  return { hooks, release, arrived };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const creations = () => h.emu.creations().length;

async function expectClean(obligations: Map<number, { totalMinor: number; invoiceNumber: string }>, allowRecovery = false) {
  const inv = await checkInvariants(h, obligations);
  expect(inv.duplicateCreations).toEqual([]);
  expect(inv.lost).toEqual([]);
  expect(inv.localWithoutLedger).toEqual([]);
  expect(inv.ledgerWithoutLocal).toEqual([]);
  expect(inv.staleContent).toEqual([]);
  if (!allowRecovery) expect(inv.inRecovery).toEqual([]);
  return inv;
}

describe("worker crashes", () => {
  it("A1 crash before the remote write: posted exactly once after lease expiry", async () => {
    h = await createHarness();
    const { obligations } = await seedApproved(h, 1);
    const d = await drain(h, [h.worker({ hooks: crashOnce("before_remote_write") })]);
    expect(d.crashes).toBe(1);
    expect(creations()).toBe(1);
    await expectClean(obligations);
  });

  it("A2 crash after the remote write, before the local commit: next attempt queries and adopts", async () => {
    h = await createHarness();
    const { ids, obligations } = await seedApproved(h, 1);
    await drain(h, [h.worker({ hooks: crashOnce("after_remote_write") })]);
    expect(creations()).toBe(1);
    const p = (await h.db.query("select adopted from postings where invoice_id = $1", [ids[0]])).rows[0];
    expect(p.adopted).toBe(true);
    await expectClean(obligations);
  });

  it("crash right after the intent commit and after the local commit are both harmless", async () => {
    h = await createHarness();
    const a = await seedApproved(h, 1, 1);
    const d1 = await drain(h, [h.worker({ hooks: crashOnce("after_intent") })]);
    const b = await seedApproved(h, 1, 2, a.obligations);
    const d2 = await drain(h, [h.worker({ hooks: crashOnce("after_local_commit") })]);
    expect([d1.crashes, d2.crashes]).toEqual([1, 1]); // both hooks actually fired
    expect(creations()).toBe(2);
    await expectClean(b.obligations);
  });
});

describe("delivery and remote faults", () => {
  it("A3 duplicate delivery: a stalled worker resumes after another worker took over and posted", async () => {
    h = await createHarness();
    const { obligations } = await seedApproved(h, 1);
    const stall = stallAt("before_remote_write");
    const w1 = h.worker({ hooks: stall.hooks });
    const t1 = w1.tick();
    await stall.arrived;
    await sleep(h.requestTimeoutMs * 4 + 50); // lease expires
    await drain(h, [h.worker()]);
    stall.release();
    const r1 = await t1;
    expect(["fenced", "released"]).toContain(r1[0]!.result); // never a write by the stale owner
    expect(creations()).toBe(1);
    await expectClean(obligations);
  });

  it("A4 timeout after the remote commit: query-before-retry adopts the committed Bill", async () => {
    h = await createHarness();
    const { obligations } = await seedApproved(h, 3);
    h.emu.setFaults([{ op: "create", effect: "hang_after_commit", times: 3 }]);
    await drain(h, [h.worker()]);
    expect(creations()).toBe(3);
    const adopted = (await h.db.query("select count(*)::int as n from postings where adopted")).rows[0].n;
    expect(adopted).toBe(3);
    await expectClean(obligations);
  });

  it("A4b timeout after commit with read-after-write lag: the stable requestid prevents the duplicate", async () => {
    h = await createHarness({ emulator: { queryLagMs: 10_000 } });
    const { obligations } = await seedApproved(h, 2);
    h.emu.setFaults([{ op: "create", effect: "hang_after_commit", times: 2 }]);
    await drain(h, [h.worker()]);
    expect(creations()).toBe(2);
    await expectClean(obligations);
  });

  it("A5 5xx storm (before and after commit): every invoice posted once or parked in recovery", async () => {
    h = await createHarness();
    const { obligations } = await seedApproved(h, 5);
    h.emu.setFaults([
      { op: "create", effect: "error500_after", prob: 0.5, times: 6 },
      { op: "create", effect: "error503_before", prob: 1, times: 8 },
    ]);
    await drain(h, [h.worker(), h.worker()], { maxMs: 30_000 });
    const fired5xx = h.emu.faultLog.filter((f) => f.effect.startsWith("error5")).length;
    expect(fired5xx).toBeGreaterThanOrEqual(10);
    const inv = await expectClean(obligations, true);
    const posted = (await h.db.query("select count(*)::int as n from postings")).rows[0].n;
    expect(posted + inv.inRecovery.length).toBe(5);
  });

  it("429 throttling is retried after Retry-After without duplicates", async () => {
    h = await createHarness();
    const { obligations } = await seedApproved(h, 2);
    h.emu.setFaults([{ op: "create", effect: "throttle429", times: 2 }]);
    const w = h.worker();
    await drain(h, [w], { maxMs: 10_000 });
    expect(creations()).toBe(2);
    await expectClean(obligations);
  });

  it("A6 eight concurrent workers on 60 jobs with latency: each posted once, no deadlock", async () => {
    h = await createHarness({ requestTimeoutMs: 400 });
    const { obligations } = await seedApproved(h, 60);
    h.emu.setFaults([{ op: "any", effect: "latency", prob: 0.5, latencyMs: 30 }]);
    const workers: OutboxWorker[] = Array.from({ length: 8 }, () => h.worker({ batchSize: 3 }));
    const d = await drain(h, workers, { maxMs: 30_000 });
    expect(d.quiescent).toBe(true);
    expect(creations()).toBe(60);
    const owners = (await h.db.query("select count(distinct worker)::int as n from post_attempts")).rows[0].n;
    expect(owners).toBeGreaterThan(1);
    await expectClean(obligations);
  });

  it("A9 emulator restart after a commit with requestid memory dropped: query-first still prevents the duplicate", async () => {
    const dir = (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "emu-"));
    h = await createHarness({ emulator: { snapshotPath: `${dir}/state.json`, persistRequestIds: false } });
    const { obligations } = await seedApproved(h, 2);
    await drain(h, [h.worker({ hooks: crashOnce("after_remote_write") })], { maxMs: 50 });
    await h.restartEmulator();
    await drain(h, [h.worker()]);
    expect(creations()).toBe(2);
    await expectClean(obligations);
  });

  it("A10 unresolvable unknown outcome: lands in recovery and is never retried blind", async () => {
    h = await createHarness();
    const { ids } = await seedApproved(h, 1);
    h.emu.setFaults([{ op: "query", effect: "error500_before" }]);
    await drain(h, [h.worker({ maxUncertainAttempts: 4 })], { maxMs: 15_000 });
    expect(creations()).toBe(0); // no write without a trustworthy query
    const rec = (await h.db.query("select kind from recovery_queue where invoice_id = $1", [ids[0]])).rows;
    expect(rec.map((r) => r.kind)).toEqual(["unknown_outcome"]);
    expect((await h.svc.get(ids[0]!)).status).toBe("RECOVERY");
  });
});

describe("server-defaulted fields (live sandbox finding, INC-14)", () => {
  it("an invoice without a due date is adopted after a crash, and reconciliation does not flag QBO's default due date", async () => {
    h = await createHarness();
    const f = { ...simInvoice(950), dueDate: null };
    const r = await h.svc.ingest({ fields: f, confidence: CONFIDENT });
    await drain(h, [h.worker({ hooks: crashOnce("after_remote_write") })]);
    const p = (await h.db.query("select adopted from postings where invoice_id = $1", [r.id])).rows[0];
    expect(p?.adopted).toBe(true); // was: ambiguous_remote, because QBO filled DueDate
    expect(h.emu.liveBills()[0]!.DueDate).toBeTruthy();
    const rep = await reconcile(h.db, h.qbo);
    expect(rep).toMatchObject({ changed: 0, orphans: 0, reconciled: 1 });
    expect((await h.db.query("select count(*)::int as n from recovery_queue")).rows[0].n).toBe(0);
  });
});

describe("requestid namespace (live sandbox finding, INC-16)", () => {
  it("a fresh database against the same realm gets new requestids, so QBO's cached responses are never replayed", async () => {
    h = await createHarness();
    await seedApproved(h, 1, 1);
    const first = (await h.db.query("select request_id from outbox")).rows[0].request_id;
    await drain(h, [h.worker()]);
    // Same realm, new installation (reset/restore): approval ids restart at 1.
    await h.db.query("truncate invoices, approvals, po_line_reservations, outbox, post_attempts, postings, recovery_queue, audit_log restart identity cascade");
    await h.db.query("delete from installation; insert into installation default values");
    await seedApproved(h, 1, 2);
    const second = (await h.db.query("select request_id from outbox")).rows[0].request_id;
    expect(second).not.toBe(first);
    await drain(h, [h.worker()]);
    expect(h.emu.creations()).toHaveLength(2);
  });

  it("a replayed response for someone else's Bill is never recorded as our posting (restore from backup keeps the namespace)", async () => {
    h = await createHarness();
    await seedApproved(h, 1, 1);
    const old = (await h.db.query("select request_id from outbox")).rows[0].request_id;
    await drain(h, [h.worker()]);
    h.emu.drift("delete", h.emu.liveBills()[0]!.Id); // deleted in QBO; the cached requestid response survives (as on the sandbox)
    // Restore an older backup: same installation id, approval ids restart -> the same requestid is generated again.
    await h.db.query("truncate invoices, approvals, po_line_reservations, outbox, post_attempts, postings, recovery_queue, audit_log restart identity cascade");
    const { ids } = await seedApproved(h, 1, 2);
    expect((await h.db.query("select request_id from outbox")).rows[0].request_id).toBe(old);
    await drain(h, [h.worker()]);
    expect((await h.db.query("select count(*)::int as n from postings")).rows[0].n).toBe(0);
    expect((await h.db.query("select kind from recovery_queue where invoice_id = $1", [ids[0]])).rows.map((r) => r.kind)).toEqual(["requestid_collision"]);
  });
});

describe("auth outage", () => {
  it("a revoked/expired token pauses the worker; the invoice is not parked in recovery and nothing is written", async () => {
    h = await createHarness();
    const { ids } = await seedApproved(h, 1);
    h.emu.setFaults([{ op: "query", effect: "expire_token" }, { op: "token", effect: "error500_before" }]);
    const w = h.worker({ maxUncertainAttempts: 2 });
    const r = await w.tick();
    expect(r[0]!.result).toBe("retry");
    expect(w.authCircuitOpenUntil).toBeGreaterThan(Date.now());
    expect(await w.tick()).toEqual([]); // circuit open: no claims
    expect((await h.db.query("select count(*)::int as n from recovery_queue")).rows[0].n).toBe(0);
    expect((await h.db.query("select outcome from post_attempts")).rows.map((x) => x.outcome)).toEqual(["auth_failed"]);
    expect(creations()).toBe(0);
    expect((await h.svc.get(ids[0]!)).status).toBe("POSTING");
  });
});

describe("edits and approvals", () => {
  it("A7 edit after approval, before posting: old content never posted; re-approval posts the new content once", async () => {
    h = await createHarness();
    const { ids } = await seedApproved(h, 1);
    const id = ids[0]!;
    const e = await h.svc.edit(id, "alice", { totalMinor: 20_000, subtotalMinor: 20_000, lines: [{ description: "Maintenance service", quantity: 200, unitPrice: 1, amountMinor: 20_000 }] });
    expect(e.status).toBe("NEEDS_REVIEW");
    expect((await h.db.query("select status from outbox where invoice_id = $1", [id])).rows[0].status).toBe("cancelled");
    await drain(h, [h.worker()]);
    expect(creations()).toBe(0);
    await h.svc.approve(id, "bob", e.contentHash);
    await drain(h, [h.worker()]);
    expect(creations()).toBe(1);
    expect(h.emu.liveBills()[0]!.TotalAmt).toBe(200);
    await expectClean(new Map([[id, { totalMinor: 20_000, invoiceNumber: "SIM-1" }]]));
  });

  it("A7b edit races a worker that already claimed the job: the worker cancels under the shared row lock", async () => {
    h = await createHarness();
    const { ids } = await seedApproved(h, 1);
    const stall = stallAt("after_claim");
    const w = h.worker({ hooks: stall.hooks });
    const t = w.tick();
    await stall.arrived;
    await h.svc.edit(ids[0]!, "alice", { dueDate: "2026-12-15" });
    stall.release();
    expect((await t)[0]!.result).toBe("fenced"); // edit cancelled the in-flight job
    expect(creations()).toBe(0);
  });

  it("A8 edits are refused once posting has started, and after posting", async () => {
    h = await createHarness();
    const { ids } = await seedApproved(h, 2);
    const stall = stallAt("after_intent");
    const t = h.worker({ hooks: stall.hooks, batchSize: 1 }).tick();
    await stall.arrived;
    const posting = (await h.db.query("select id from invoices where status = 'POSTING'")).rows[0].id as number;
    await expect(h.svc.edit(posting, "alice", { dueDate: "2027-01-01" })).rejects.toThrow(/POSTING/);
    stall.release();
    await t;
    await drain(h, [h.worker()]);
    await expect(h.svc.edit(ids[0]!, "alice", { dueDate: "2027-01-01" })).rejects.toThrow(/POSTED/);
  });
});

describe("fencing and adoption safety", () => {
  it("A16 a stale worker resuming after takeover changes no local state", async () => {
    h = await createHarness();
    const { obligations } = await seedApproved(h, 1);
    const stall = stallAt("after_remote_write");
    const w1 = h.worker({ hooks: stall.hooks, workerId: "stale" });
    const t1 = w1.tick();
    await stall.arrived; // W1's Bill is committed remotely, W1 is paused before recording it
    await sleep(h.requestTimeoutMs * 4 + 50);
    await drain(h, [h.worker({ workerId: "fresh" })]);
    const snapshot = async () => {
      const out: Record<string, unknown[]> = {};
      for (const t of ["invoices", "approvals", "outbox", "post_attempts", "postings", "recovery_queue", "audit_log"]) out[t] = (await h.db.query(`select * from ${t} order by 1`)).rows;
      return JSON.stringify(out);
    };
    const before = await snapshot();
    stall.release();
    expect((await t1)[0]!.result).toBe("fenced");
    expect(await snapshot()).toBe(before); // full table contents, not just counts
    expect(creations()).toBe(1);
    await expectClean(obligations);
  });

  it("A18 a manually entered Bill with the same DocNumber is never adopted or duplicated", async () => {
    h = await createHarness();
    const f = simInvoice(900);
    h.emu.manualBill({ VendorRef: { value: "56" }, DocNumber: f.invoiceNumber!, TxnDate: f.invoiceDate!, CurrencyRef: { value: "USD" }, Line: [{ Amount: 123.45, DetailType: "AccountBasedExpenseLineDetail", AccountBasedExpenseLineDetail: { AccountRef: { value: "7" } } }] });
    const r = await h.svc.ingest({ fields: f, confidence: CONFIDENT });
    await drain(h, [h.worker()]);
    expect(h.emu.creations().filter((c) => c.privateNote)).toHaveLength(0);
    const rec = (await h.db.query("select kind, detail from recovery_queue where invoice_id = $1", [r.id])).rows[0];
    expect(rec.kind).toBe("ambiguous_remote");
    expect(rec.detail.candidates[0].ours).toBe(false);
  });
});
