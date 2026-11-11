import { randomUUID } from "node:crypto";
import type { Bill, CreateResult, QboClient } from "@ipa/qbo";
import { QboAuthError, QboUnavailableError } from "@ipa/qbo";
import { toMinor } from "@ipa/domain";
import type { Db, Tx } from "./db.ts";
import { withTx } from "./db.ts";
import { markerFor } from "./payload.ts";
import { audit, openRecovery, setStatus } from "./transitions.ts";

export type CrashPoint = "after_claim" | "after_intent" | "before_remote_write" | "after_remote_write" | "after_local_commit";

/** Thrown by fault hooks to simulate the process dying at a point. The worker must not catch-and-continue. */
export class SimulatedCrash extends Error {
  constructor(readonly point: CrashPoint) {
    super(`simulated crash at ${point}`);
  }
}

export interface WorkerHooks {
  /** Called at each crash point; may throw SimulatedCrash or await (to simulate a stall). */
  at?(point: CrashPoint, ctx: { jobId: number; workerId: string }): Promise<void> | void;
}

/** Each defense can be switched off for ablation runs. Production uses all of them. */
export interface Defenses {
  stableRequestId: boolean;
  queryFirst: boolean;
  fencing: boolean;
  leaseGuard: boolean;
}

export const ALL_DEFENSES: Defenses = { stableRequestId: true, queryFirst: true, fencing: true, leaseGuard: true };

export interface WorkerOptions {
  workerId?: string;
  leaseMs?: number;
  /** Must match the QBO client's per-request timeout. */
  requestTimeoutMs?: number;
  batchSize?: number;
  /** Unknown outcomes (timeouts, 5xx, failed queries) tolerated before the job goes to the recovery queue. */
  maxUncertainAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  defenses?: Defenses;
  hooks?: WorkerHooks;
}

interface Job {
  id: number;
  invoice_id: number;
  approval_id: number;
  request_id: string;
  doc_number: string;
  vendor_ref: string;
  payload: string;
  payload_hash: string;
  realm_id: string;
  claim_gen: number;
  attempts: number;
  lease_until: Date;
}

export interface JobOutcome {
  jobId: number;
  result: "posted" | "adopted" | "retry" | "recovery" | "cancelled" | "already_done" | "fenced" | "released";
}

export class OutboxWorker {
  readonly id: string;
  private readonly o: Required<Omit<WorkerOptions, "hooks" | "workerId">> & { hooks: WorkerHooks };
  authCircuitOpenUntil = 0;

  constructor(private readonly db: Db, private readonly qbo: QboClient, opts: WorkerOptions = {}) {
    this.id = opts.workerId ?? `w-${randomUUID().slice(0, 8)}`;
    const requestTimeoutMs = opts.requestTimeoutMs ?? 15_000;
    this.o = {
      // Lease >= 3x request timeout so a request normally finishes (or times out) long before the lease expires.
      leaseMs: opts.leaseMs ?? requestTimeoutMs * 4,
      requestTimeoutMs,
      batchSize: opts.batchSize ?? 5,
      maxUncertainAttempts: opts.maxUncertainAttempts ?? 8,
      backoffBaseMs: opts.backoffBaseMs ?? 500,
      backoffMaxMs: opts.backoffMaxMs ?? 60_000,
      defenses: opts.defenses ?? ALL_DEFENSES,
      hooks: opts.hooks ?? {},
    };
    if (this.o.leaseMs < this.o.requestTimeoutMs * 3) throw new Error("leaseMs must be at least 3x requestTimeoutMs");
  }

  /** Claim up to batchSize due jobs (new, or abandoned with an expired lease) and process them in order. */
  async tick(): Promise<JobOutcome[]> {
    if (Date.now() < this.authCircuitOpenUntil) return [];
    const jobs = await this.claim();
    const out: JobOutcome[] = [];
    for (const j of jobs) out.push(await this.process(j));
    return out;
  }

  async claim(): Promise<Job[]> {
    const r = await this.db.query<Job>(
      `update outbox set status = 'in_flight', lease_owner = $1, lease_until = now() + ($2 || ' milliseconds')::interval,
              claim_gen = claim_gen + 1, attempts = attempts + 1, updated_at = now()
       where id in (
         select id from outbox
         where (status = 'pending' and available_at <= now()) or (status = 'in_flight' and lease_until < now())
         order by available_at, id
         limit $3
         for update skip locked)
       returning id, invoice_id, approval_id, request_id, doc_number, vendor_ref, payload, payload_hash, realm_id, claim_gen, attempts, lease_until`,
      [this.id, String(this.o.leaseMs), this.o.batchSize],
    );
    return r.rows;
  }

  private fence(): string {
    // Every write after the claim is conditional on still owning the claim generation ($GEN is filled in by fenced()).
    return this.o.defenses.fencing ? " and claim_gen = $GEN" : "";
  }

  /** Run `sql` with the fence appended; returns affected row count. `$GEN` placeholder is the claim generation. */
  private async fenced(tx: Tx | Db, sql: string, params: unknown[], gen: number): Promise<number> {
    let text = sql;
    const p = [...params];
    if (this.o.defenses.fencing) {
      p.push(gen);
      text = text.replace("$GEN", `$${p.length}`);
    }
    const r = await tx.query(text, p);
    return r.rowCount ?? 0;
  }

  async process(job: Job): Promise<JobOutcome> {
    await this.o.hooks.at?.("after_claim", { jobId: job.id, workerId: this.id });

    // Step 2: guard + intent, under the invoice row lock (the same lock edits and approvals take).
    const intent = await withTx(this.db, async (tx) => {
      const inv = (await tx.query("select id, status, content_hash from invoices where id = $1 for update", [job.invoice_id])).rows[0];
      const ob = (await tx.query("select status, claim_gen, lease_until - now() as remaining from outbox where id = $1 for update", [job.id])).rows[0];
      if (this.o.defenses.fencing && ob.claim_gen !== job.claim_gen) return { stop: "fenced" as const };
      if (ob.status !== "in_flight") return { stop: "fenced" as const };
      const posted = (await tx.query("select 1 from postings where invoice_id = $1", [job.invoice_id])).rows[0];
      if (posted) {
        await tx.query("update outbox set status = 'done', lease_owner = null, updated_at = now() where id = $1", [job.id]);
        return { stop: "already_done" as const };
      }
      const ap = (await tx.query("select approved_content_hash, voided_at from approvals where id = $1", [job.approval_id])).rows[0];
      if (ap.voided_at || ap.approved_content_hash !== inv.content_hash) {
        await tx.query("update outbox set status = 'cancelled', updated_at = now() where id = $1", [job.id]);
        await audit(tx, { invoiceId: job.invoice_id, actor: this.id, action: "job_cancelled_stale_approval", detail: { jobId: job.id } });
        return { stop: "cancelled" as const };
      }
      const remainingMs = intervalMs(ob.remaining);
      if (this.o.defenses.leaseGuard && remainingMs < this.o.requestTimeoutMs * 2 + 100) {
        // Not enough lease left to finish a request safely; hand the job back instead of racing the next owner.
        await tx.query("update outbox set status = 'pending', lease_owner = null, lease_until = null, available_at = now() where id = $1", [job.id]);
        return { stop: "released" as const };
      }
      const n = (await tx.query("select count(*)::int as n from post_attempts where outbox_id = $1", [job.id])).rows[0].n as number;
      const requestId = this.o.defenses.stableRequestId ? job.request_id : randomUUID();
      const att = await tx.query<{ id: number }>("insert into post_attempts (outbox_id, attempt_no, claim_gen, worker, request_id) values ($1,$2,$3,$4,$5) returning id", [job.id, n + 1, job.claim_gen, this.id, requestId]);
      if (inv.status === "APPROVED" || inv.status === "AUTO_APPROVED") await setStatus(tx, job.invoice_id, "POSTING", this.id, "posting_intent", { jobId: job.id, requestId });
      return { stop: null, attemptId: att.rows[0]!.id, requestId };
    });
    if (intent.stop) return { jobId: job.id, result: intent.stop };
    const { attemptId, requestId } = intent;
    await this.o.hooks.at?.("after_intent", { jobId: job.id, workerId: this.id });

    // Step 3: query first, always.
    if (this.o.defenses.queryFirst) {
      let bills: Bill[];
      try {
        bills = (await this.qbo.queryBillsByDocNumber(job.doc_number)).filter((b) => b.VendorRef.value === job.vendor_ref);
      } catch (e) {
        if (e instanceof QboAuthError) {
          // Systemic auth failure: pause, keep the job pending, do not spend its uncertainty budget.
          this.authCircuitOpenUntil = Date.now() + this.o.backoffMaxMs;
          return this.retryLater(job, attemptId, "auth_failed", 401, e.message, this.o.backoffMaxMs);
        }
        if (!(e instanceof QboUnavailableError)) throw e;
        return this.uncertain(job, attemptId, "query_failed", null, e.message);
      }
      if (bills.length > 0) {
        const marker = markerFor(job.request_id);
        const ours = bills.filter((b) => (b.PrivateNote ?? "").startsWith(marker));
        if (bills.length === 1 && ours.length === 1 && sameContent(ours[0]!, job.payload)) {
          return this.finalize(job, attemptId, ours[0]!, true);
        }
        return this.toRecovery(job, attemptId, "ambiguous_remote", "ambiguous", {
          docNumber: job.doc_number,
          candidates: bills.map((b) => ({ id: b.Id, total: b.TotalAmt, ours: (b.PrivateNote ?? "").startsWith(marker) })),
        });
      }
    }

    // Step 4: write with the stable requestid. Re-check ownership right before the request leaves: a pause
    // (GC, frozen VM, slow query) between the intent and here must not turn into a write by a stale worker.
    await this.o.hooks.at?.("before_remote_write", { jobId: job.id, workerId: this.id });
    if (this.o.defenses.leaseGuard && job.lease_until.getTime() - Date.now() < this.o.requestTimeoutMs * 2) {
      return this.release(job, attemptId, "lease too short to send safely");
    }
    if (this.o.defenses.fencing) {
      const cur = (await this.db.query("select claim_gen, status from outbox where id = $1", [job.id])).rows[0];
      if (cur.claim_gen !== job.claim_gen || cur.status !== "in_flight") return { jobId: job.id, result: "fenced" };
    }
    const result: CreateResult = await this.qbo.createBill(job.payload, requestId);
    await this.o.hooks.at?.("after_remote_write", { jobId: job.id, workerId: this.id });
    switch (result.kind) {
      case "created":
        return this.finalize(job, attemptId, result.bill, false);
      case "unknown":
        return this.uncertain(job, attemptId, "unknown", result.httpStatus, result.reason);
      case "throttled":
        return this.retryLater(job, attemptId, "throttled", 429, "throttled", result.retryAfterMs);
      case "auth_failed":
        // Systemic: pause this worker and keep the job pending. It is not this invoice's fault.
        this.authCircuitOpenUntil = Date.now() + this.o.backoffMaxMs;
        return this.retryLater(job, attemptId, "auth_failed", 401, result.detail, this.o.backoffMaxMs);
      case "rejected":
        return this.toRecovery(job, attemptId, "remote_rejected", "rejected", { httpStatus: result.httpStatus, fault: result.fault }, result.httpStatus);
    }
  }

  private async finalize(job: Job, attemptId: number, bill: Bill, adopted: boolean): Promise<JobOutcome> {
    const res = await withTx(this.db, async (tx) => {
      const n = await this.fenced(tx, `update outbox set status = 'done', lease_owner = null, updated_at = now() where id = $1 and status = 'in_flight'${this.fence()}`, [job.id], job.claim_gen);
      if (n === 0) return "fenced" as const;
      const payload = JSON.parse(job.payload) as { CurrencyRef?: { value: string } };
      const ins = await tx.query(
        `insert into postings (invoice_id, outbox_id, realm_id, bill_id, doc_number, vendor_ref, total_minor, currency, payload_hash, adopted)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict do nothing`,
        [job.invoice_id, job.id, job.realm_id, bill.Id, job.doc_number, job.vendor_ref, toMinor(bill.TotalAmt, payload.CurrencyRef?.value ?? "USD"), payload.CurrencyRef?.value ?? "USD", job.payload_hash, adopted],
      );
      if ((ins.rowCount ?? 0) === 0) {
        // Another path already recorded a posting for this invoice (or this Bill for another invoice).
        await openRecovery(tx, { invoiceId: job.invoice_id, outboxId: job.id, billId: bill.Id, kind: "ambiguous_remote", detail: { reason: "posting_conflict", billId: bill.Id } });
      }
      await tx.query("update post_attempts set outcome = $2, remote_bill_id = $3, finished_at = now(), http_status = 200 where id = $1", [attemptId, adopted ? "adopted" : "created", bill.Id]);
      const st = (await tx.query("select status from invoices where id = $1 for update", [job.invoice_id])).rows[0].status;
      if (st === "POSTING" || st === "RECOVERY") await setStatus(tx, job.invoice_id, "POSTED", this.id, adopted ? "adopted_existing_bill" : "bill_created", { billId: bill.Id, requestId: job.request_id });
      return adopted ? ("adopted" as const) : ("posted" as const);
    });
    await this.o.hooks.at?.("after_local_commit", { jobId: job.id, workerId: this.id });
    return { jobId: job.id, result: res };
  }

  private async uncertain(job: Job, attemptId: number, outcome: "unknown" | "query_failed", httpStatus: number | null, error: string): Promise<JobOutcome> {
    const uncertainSoFar = (await this.db.query("select count(*)::int as n from post_attempts where outbox_id = $1 and outcome in ('unknown', 'query_failed')", [job.id])).rows[0].n as number;
    if (uncertainSoFar + 1 >= this.o.maxUncertainAttempts) {
      return this.toRecovery(job, attemptId, "unknown_outcome", outcome, { error, attempts: uncertainSoFar + 1 }, httpStatus);
    }
    return this.retryLater(job, attemptId, outcome, httpStatus, error, this.backoff(job.attempts));
  }

  private async retryLater(job: Job, attemptId: number, outcome: string, httpStatus: number | null, error: string, delayMs: number): Promise<JobOutcome> {
    const res = await withTx(this.db, async (tx) => {
      const n = await this.fenced(
        tx,
        `update outbox set status = 'pending', lease_owner = null, lease_until = null, last_error = $2,
           available_at = now() + ($3 || ' milliseconds')::interval, updated_at = now() where id = $1 and status = 'in_flight'${this.fence()}`,
        [job.id, error.slice(0, 500), String(Math.round(delayMs))],
        job.claim_gen,
      );
      if (n === 0) return "fenced" as const;
      await tx.query("update post_attempts set outcome = $2, http_status = $3, error = $4, finished_at = now() where id = $1", [attemptId, outcome, httpStatus, error.slice(0, 500)]);
      return "retry" as const;
    });
    return { jobId: job.id, result: res };
  }

  /** Give the job back without counting an attempt against it (used when the lease is too short). */
  private async release(job: Job, attemptId: number, why: string): Promise<JobOutcome> {
    const res = await withTx(this.db, async (tx) => {
      const n = await this.fenced(tx, `update outbox set status = 'pending', lease_owner = null, lease_until = null, available_at = now(), updated_at = now() where id = $1 and status = 'in_flight'${this.fence()}`, [job.id], job.claim_gen);
      if (n === 0) return "fenced" as const;
      await tx.query("update post_attempts set outcome = 'released', error = $2, finished_at = now() where id = $1", [attemptId, why]);
      return "released" as const;
    });
    return { jobId: job.id, result: res };
  }

  private async toRecovery(job: Job, attemptId: number, kind: string, outcome: string, detail: Record<string, unknown>, httpStatus: number | null = null): Promise<JobOutcome> {
    const res = await withTx(this.db, async (tx) => {
      const n = await this.fenced(tx, `update outbox set status = 'dead', lease_owner = null, last_error = $2, updated_at = now() where id = $1 and status = 'in_flight'${this.fence()}`, [job.id, kind], job.claim_gen);
      if (n === 0) return "fenced" as const;
      await tx.query("update post_attempts set outcome = $2, http_status = $3, error = $4, finished_at = now() where id = $1", [attemptId, outcome, httpStatus, kind]);
      await openRecovery(tx, { invoiceId: job.invoice_id, outboxId: job.id, kind, detail });
      const st = (await tx.query("select status from invoices where id = $1 for update", [job.invoice_id])).rows[0].status;
      if (st === "POSTING") await setStatus(tx, job.invoice_id, "RECOVERY", this.id, "to_recovery", { kind, ...detail });
      return "recovery" as const;
    });
    return { jobId: job.id, result: res };
  }

  private backoff(attempt: number): number {
    // Exponential with full jitter, capped.
    const cap = Math.min(this.o.backoffMaxMs, this.o.backoffBaseMs * 2 ** Math.min(attempt, 10));
    return Math.round(cap / 2 + Math.random() * (cap / 2));
  }
}

/**
 * Remote Bill matches the payload we would have sent: vendor, DocNumber, dates, currency, total, and each line's
 * amount and expense account (currency-aware minor units, so zero-decimal currencies compare correctly).
 */
export function sameContent(bill: Bill, payload: string): boolean {
  const p = JSON.parse(payload) as Bill;
  const cur = p.CurrencyRef?.value ?? "USD";
  const lines = (b: Pick<Bill, "Line">) => b.Line.map((l) => `${toMinor(l.Amount, cur)}@${l.AccountBasedExpenseLineDetail?.AccountRef?.value ?? ""}`).join(",");
  const total = (b: Pick<Bill, "Line">) => b.Line.reduce((s, l) => s + toMinor(l.Amount, cur), 0);
  return (
    bill.VendorRef.value === p.VendorRef.value &&
    bill.DocNumber === p.DocNumber &&
    (bill.TxnDate ?? null) === (p.TxnDate ?? null) &&
    (bill.DueDate ?? null) === (p.DueDate ?? null) &&
    (bill.CurrencyRef?.value ?? null) === (p.CurrencyRef?.value ?? null) &&
    toMinor(bill.TotalAmt, cur) === total(p) &&
    lines(bill) === lines(p)
  );
}

function intervalMs(v: unknown): number {
  // node-postgres returns intervals as objects {milliseconds, seconds, minutes, ...}; negative when expired.
  if (!v || typeof v !== "object") return 0;
  const i = v as Record<string, number>;
  return ((i.days ?? 0) * 86400 + (i.hours ?? 0) * 3600 + (i.minutes ?? 0) * 60 + (i.seconds ?? 0)) * 1000 + (i.milliseconds ?? 0);
}
