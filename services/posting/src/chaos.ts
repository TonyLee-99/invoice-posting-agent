// Randomized fault runs. One seed = one reproducible mix of worker crashes/stalls, remote faults, an optional
// emulator restart, human edits and approvals. After the chaos window the faults stop, the system must become
// quiescent within a bound (liveness), the scripted RUNBOOK procedures resolve the recovery queue, nightly
// reconciliation runs, and invariants are checked against independent evidence.
import { existsSync, unlinkSync } from "node:fs";
import type { EmulatorOptions, FaultRule } from "@ipa/qbo";
import { prng } from "@ipa/qbo";
import type { Harness, Obligations } from "./harness.ts";
import { CONFIDENT, checkInvariants, drain, simInvoice } from "./harness.ts";
import { reconcile } from "./reconcile.ts";
import { RecoveryDesk } from "./recovery.ts";
import { ConflictError } from "./transitions.ts";
import type { CrashPoint, Defenses, OutboxWorker } from "./worker.ts";
import { ALL_DEFENSES, SimulatedCrash, sameContent } from "./worker.ts";
import { markerFor } from "./payload.ts";

const POINTS: CrashPoint[] = ["after_claim", "after_intent", "before_remote_write", "after_remote_write", "after_local_commit"];

export interface SeedConfig {
  seed: number;
  workers: number;
  invoices: number;
  crashProb: number;
  stallProb: number;
  queryLagMs: number;
  restart: boolean;
  concurrentSameRequestId: "serialize" | "race";
  rules: FaultRule[];
  edits: number;
  /** Frozen before the run: seeds where a duplicate is possible even with every defense (DESIGN §5 residual). */
  residualEligible: boolean;
}

export interface SeedResult {
  config: SeedConfig;
  defenses: Defenses;
  ok: boolean;
  duplicates: number;
  lost: number;
  inRecoveryAfterRunbook: number;
  localWithoutLedger: number;
  ledgerWithoutLocal: number;
  staleContent: number;
  quiescentAfterFaults: boolean;
  livenessMs: number;
  crashes: number;
  faultsFired: Record<string, number>;
  recoveryOpened: Record<string, number>;
  editsApplied: number;
  editsRefused: number;
  duplicateDetectedByReconcile: number;
  posted: number;
  ms: number;
}

export function configFor(seed: number): SeedConfig {
  const r = prng(seed * 7919 + 13);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  const rules: FaultRule[] = [];
  const maybe = (p: number, rule: FaultRule) => {
    if (r() < p) rules.push(rule);
  };
  maybe(0.6, { op: "create", effect: "error500_before", prob: 0.05 + 0.15 * r() });
  maybe(0.5, { op: "create", effect: "error503_before", prob: 0.05 + 0.1 * r() });
  maybe(0.7, { op: "create", effect: "error500_after", prob: 0.05 + 0.15 * r() });
  maybe(0.5, { op: "create", effect: "reset_after_commit", prob: 0.05 + 0.1 * r() });
  maybe(0.6, { op: "create", effect: "hang_after_commit", prob: 0.05 + 0.1 * r() });
  maybe(0.3, { op: "create", effect: "hang_before_commit", prob: 0.05 });
  maybe(0.4, { op: "create", effect: "throttle429", prob: 0.1 });
  maybe(0.4, { op: "query", effect: "error500_before", prob: 0.05 + 0.1 * r() });
  maybe(0.2, { op: "any", effect: "expire_token", prob: 0.03 });
  maybe(0.6, { op: "any", effect: "latency", prob: 0.3, latencyMs: Math.round(10 + 60 * r()) });
  const queryLagMs = r() < 0.3 ? Math.round(50 + 400 * r()) : 0;
  const restart = r() < 0.3;
  const stallProb = r() < 0.4 ? 0.05 : 0;
  const concurrentSameRequestId = r() < 0.2 ? "race" : "serialize";
  return {
    seed,
    workers: 2 + Math.floor(r() * 7),
    invoices: 8 + Math.floor(r() * 13),
    crashProb: pick([0, 0.02, 0.05, 0.1]),
    stallProb,
    queryLagMs,
    restart,
    concurrentSameRequestId,
    rules,
    edits: Math.floor(r() * 4),
    // requestid memory can be lost (restart) while a write is invisible (lag) or a stale request can land (stall).
    residualEligible: restart && (queryLagMs > 0 || stallProb > 0),
  };
}

export async function runSeed(h: Harness, seed: number, opts: { defenses?: Defenses; chaosMs?: number; livenessBoundMs?: number } = {}): Promise<SeedResult> {
  const t0 = Date.now();
  const cfg = configFor(seed);
  const defenses = opts.defenses ?? ALL_DEFENSES;
  const r = prng(seed * 104729 + 7);
  const emuOpts: EmulatorOptions = {
    seed,
    queryLagMs: cfg.queryLagMs,
    concurrentSameRequestId: cfg.concurrentSameRequestId,
    persistRequestIds: false,
    snapshotPath: `${process.env.TMPDIR ?? "/tmp"}/ipa-chaos-${process.pid}-${seed}.json`,
  };
  // A fresh ledger per seed: a snapshot left by an earlier run of the same seed would leak old Bills in.
  if (existsSync(emuOpts.snapshotPath!)) unlinkSync(emuOpts.snapshotPath!);
  await h.reset(emuOpts);
  h.emu.setFaults(cfg.rules);

  const obligations: Obligations = new Map();
  const ids: number[] = [];
  for (let i = 0; i < cfg.invoices; i++) {
    const f = simInvoice(i + 1, 10_000 + Math.floor(r() * 90_000));
    const res = await h.svc.ingest({ fields: f, confidence: CONFIDENT });
    ids.push(res.id);
    obligations.set(res.id, { totalMinor: f.totalMinor!, invoiceNumber: f.invoiceNumber! });
  }

  let chaosOn = true;
  const hooks = {
    async at(_p: CrashPoint) {
      if (!chaosOn) return;
      if (r() < cfg.crashProb) throw new SimulatedCrash(_p);
      if (r() < cfg.stallProb) await new Promise((res) => setTimeout(res, Math.round(r() * h.requestTimeoutMs * 8)));
    },
  };
  void POINTS;
  const mk = () => h.worker({ hooks, defenses, maxUncertainAttempts: 6 });
  const workers: OutboxWorker[] = Array.from({ length: cfg.workers }, mk);

  // Human activity during the chaos window: edits (some refused with 409) and later approvals of edited invoices.
  let editsApplied = 0;
  let editsRefused = 0;
  const human = (async () => {
    for (let e = 0; e < cfg.edits; e++) {
      await new Promise((res) => setTimeout(res, Math.round(r() * 600)));
      const id = ids[Math.floor(r() * ids.length)]!;
      const newTotal = 10_000 + Math.floor(r() * 90_000);
      try {
        await h.svc.edit(id, "chaos-editor", { totalMinor: newTotal, subtotalMinor: newTotal, lines: [{ description: "Maintenance service", quantity: newTotal / 100, unitPrice: 1, amountMinor: newTotal }] });
        obligations.set(id, { totalMinor: newTotal, invoiceNumber: obligations.get(id)!.invoiceNumber });
        editsApplied++;
      } catch (err) {
        if (!(err instanceof ConflictError)) throw err;
        editsRefused++;
      }
    }
  })();

  const restartAt = cfg.restart ? 200 + Math.floor(r() * 800) : -1;
  const chaosMs = opts.chaosMs ?? 1500;
  let crashes = 0;
  const tStart = Date.now();
  let restarted = false;
  while (Date.now() - tStart < chaosMs) {
    if (!restarted && restartAt >= 0 && Date.now() - tStart > restartAt) {
      restarted = true;
      await h.restartEmulator();
      h.emu.setFaults(cfg.rules);
    }
    const res = await Promise.allSettled(workers.map((w) => w.tick()));
    res.forEach((x, i) => {
      if (x.status === "rejected") {
        if (!(x.reason instanceof SimulatedCrash)) throw x.reason;
        crashes++;
        workers[i] = mk();
      }
    });
    await approveEdited(h);
    await new Promise((res) => setTimeout(res, 10));
  }
  await human;
  const faultsFired: Record<string, number> = {};
  const count = (k: string) => (faultsFired[k] = (faultsFired[k] ?? 0) + 1);
  // Faults stop: liveness phase.
  chaosOn = false;
  for (const f of [...h.priorFaultLog, ...h.emu.faultLog]) count(`${f.op}:${f.effect}`);
  if (restarted) count("emulator_restart");
  if (crashes) faultsFired["worker_crash"] = crashes;
  h.emu.clearFaults();
  await approveEdited(h);
  const tl = Date.now();
  const d = await drain(h, workers.map(() => h.worker({ defenses })), { maxMs: opts.livenessBoundMs ?? 15_000 });
  const livenessMs = Date.now() - tl;

  const recoveryOpened = Object.fromEntries((await h.db.query("select kind, count(*)::int as n from recovery_queue group by kind")).rows.map((x) => [x.kind, x.n]));
  // Runbook bot, then reconcile, then the runbook again for anything reconciliation found.
  await runbookBot(h, defenses);
  await drain(h, [h.worker({ defenses })], { maxMs: 10_000 });
  // After the runbook every obligation must end posted: parked items count as a failure of liveness.
  const rep = await reconcile(h.db, h.qbo);
  const orphansFound = rep.orphans;
  await runbookBot(h, defenses);
  const inv = await checkInvariants(h, obligations);
  const posted = (await h.db.query("select count(*)::int as n from postings where voided_at is null")).rows[0].n as number;
  return {
    config: cfg,
    defenses,
    ok: inv.ok && d.quiescent && inv.inRecovery.length === 0,
    duplicates: inv.duplicateCreations.reduce((s, x) => s + x.count - 1, 0),
    lost: inv.lost.length,
    inRecoveryAfterRunbook: inv.inRecovery.length,
    localWithoutLedger: inv.localWithoutLedger.length,
    ledgerWithoutLocal: inv.ledgerWithoutLocal.length,
    staleContent: inv.staleContent.length,
    quiescentAfterFaults: d.quiescent,
    livenessMs,
    crashes,
    faultsFired,
    recoveryOpened,
    editsApplied,
    editsRefused,
    duplicateDetectedByReconcile: orphansFound,
    posted,
    ms: Date.now() - t0,
  };
}

/** The reviewer: approves edited invoices (NEEDS_REVIEW) using the content hash currently displayed. */
async function approveEdited(h: Harness): Promise<void> {
  const rows = (await h.db.query("select id, content_hash from invoices where status = 'NEEDS_REVIEW'")).rows;
  for (const row of rows) {
    try {
      await h.svc.approve(row.id, "chaos-reviewer", row.content_hash);
    } catch (e) {
      if (!(e instanceof ConflictError)) throw e;
    }
  }
}

/**
 * RUNBOOK §3 as a script. unknown_outcome / ambiguous_remote: query the ledger; adopt our Bill if exactly one
 * matches, retry after the quiet period if none. orphan_remote_bill (a duplicate): void it in QBO (the
 * emulator stands in for the person), then confirm.
 */
async function runbookBot(h: Harness, defenses: Defenses): Promise<void> {
  const desk = new RecoveryDesk(h.db, h.qbo, { quietPeriodMs: h.requestTimeoutMs * 4 });
  for (let round = 0; round < 3; round++) {
    const items = await desk.open();
    if (!items.length) return;
    await new Promise((res) => setTimeout(res, h.requestTimeoutMs * 4 + 50)); // quiet period
    for (const it of items) {
      try {
        if (it.kind === "orphan_remote_bill" && it.bill_id) {
          const posted = it.invoice_id ? (await h.db.query("select 1 from postings where invoice_id = $1 and voided_at is null", [it.invoice_id])).rows[0] : null;
          if (posted || !it.invoice_id) {
            h.emu.drift("delete", it.bill_id);
            await desk.resolve(it.id, { action: "confirm_duplicate_voided" }, "runbook-bot");
          } else {
            await desk.resolve(it.id, { action: "adopt", billId: it.bill_id }, "runbook-bot");
          }
          continue;
        }
        if ((it.kind === "unknown_outcome" || it.kind === "ambiguous_remote") && it.outbox_id) {
          const job = (await h.db.query("select * from outbox where id = $1", [it.outbox_id])).rows[0];
          const bills = (await h.qbo.queryBillsByDocNumber(job.doc_number)).filter((b) => b.VendorRef.value === job.vendor_ref);
          const ours = bills.filter((b) => (b.PrivateNote ?? "").startsWith(markerFor(job.request_id)) && sameContent(b, job.payload));
          if (ours.length >= 1) {
            await desk.resolve(it.id, { action: "adopt", billId: ours[0]!.Id }, "runbook-bot");
            // Any further copies are duplicates; reconciliation will report them as orphans.
          } else if (bills.length === 0) {
            await desk.resolve(it.id, { action: "retry" }, "runbook-bot");
          }
        }
      } catch (e) {
        if (!(e instanceof ConflictError)) throw e;
      }
    }
    await drain(h, [h.worker({ defenses })], { maxMs: 5_000 });
  }
}
