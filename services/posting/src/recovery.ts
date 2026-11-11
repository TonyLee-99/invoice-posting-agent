import type { Bill, QboClient } from "@ipa/qbo";
import type { Db } from "./db.ts";
import { withTx } from "./db.ts";
import { markerFor } from "./payload.ts";
import { ConflictError, NotFoundError, audit, setStatus } from "./transitions.ts";
import { sameContent } from "./worker.ts";
import { toMinor } from "@ipa/domain";

export type Resolution =
  | { action: "adopt"; billId: string; override?: { reason: string } }
  | { action: "retry" }
  | { action: "close_not_posted"; reason: string }
  | { action: "accept_ledger" }
  | { action: "acknowledge_deleted"; reason: string }
  | { action: "confirm_duplicate_voided" };

export interface RecoveryItem {
  id: number;
  invoice_id: number | null;
  outbox_id: number | null;
  bill_id: string | null;
  kind: string;
  detail: Record<string, unknown>;
  opened_at: string;
  resolved_at: string | null;
}

/**
 * Runbook procedures (docs/RUNBOOK.md) as code. Every resolution re-checks the ledger first and records the
 * evidence it relied on. Nothing here writes to QBO: duplicates are voided by a person in QBO, then confirmed.
 */
export class RecoveryDesk {
  constructor(private readonly db: Db, private readonly qbo: QboClient, private readonly opts: { quietPeriodMs?: number } = {}) {}

  async open(): Promise<RecoveryItem[]> {
    return (await this.db.query("select * from recovery_queue where resolved_at is null order by id")).rows as RecoveryItem[];
  }

  async resolve(itemId: number, r: Resolution, actor: string): Promise<void> {
    const item = (await this.db.query("select * from recovery_queue where id = $1", [itemId])).rows[0] as RecoveryItem | undefined;
    if (!item) throw new NotFoundError(`recovery item ${itemId} not found`);
    if (item.resolved_at) throw new ConflictError("already resolved");
    const job = item.outbox_id ? (await this.db.query("select * from outbox where id = $1", [item.outbox_id])).rows[0] : null;
    let evidence: Record<string, unknown> = {};

    if (r.action === "adopt") {
      if (!job || !item.invoice_id) throw new ConflictError("adopt needs an invoice with a posting job");
      const bill = await this.qbo.getBill(r.billId);
      if (!bill) throw new ConflictError(`bill ${r.billId} not found in the ledger`);
      const ours = (bill.PrivateNote ?? "").startsWith(markerFor(job.request_id));
      if (!sameContent(bill, job.payload)) throw new ConflictError("bill content differs from the approved payload");
      if (!ours && !r.override) throw new ConflictError("bill was not created by this integration; adopting needs an explicit override with a reason");
      evidence = { bill: summarize(bill), ours, override: r.override ?? null };
      await withTx(this.db, async (tx) => {
        await tx.query(
          `insert into postings (invoice_id, outbox_id, realm_id, bill_id, doc_number, vendor_ref, total_minor, currency, payload_hash, adopted)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)`,
          [item.invoice_id, job.id, job.realm_id, bill.Id, job.doc_number, job.vendor_ref, toMinor(bill.TotalAmt, bill.CurrencyRef?.value ?? "USD"), bill.CurrencyRef?.value ?? "USD", job.payload_hash],
        );
        await tx.query("update outbox set status = 'done', updated_at = now() where id = $1", [job.id]);
        await this.toStatus(tx, item.invoice_id!, "POSTED", actor, "recovery_adopt", evidence);
        await this.close(tx, item.id, r.action, actor, evidence);
      });
      return;
    }

    if (r.action === "retry" || r.action === "close_not_posted") {
      if (!job || !item.invoice_id) throw new ConflictError(`${r.action} needs an invoice with a posting job`);
      // No request of ours may still be able to land: the newest attempt must be older than the quiet period.
      const last = (await this.db.query("select extract(epoch from (now() - max(started_at))) * 1000 as age_ms from post_attempts where outbox_id = $1", [job.id])).rows[0];
      const quiet = this.opts.quietPeriodMs ?? 120_000;
      if (last.age_ms !== null && Number(last.age_ms) < quiet) throw new ConflictError(`last attempt is ${Math.round(Number(last.age_ms))} ms old; wait ${quiet} ms so no in-flight request can still commit`);
      const bills = (await this.qbo.queryBillsByDocNumber(job.doc_number)).filter((b) => b.VendorRef.value === job.vendor_ref);
      if (bills.length) throw new ConflictError(`ledger has ${bills.length} bill(s) with DocNumber ${job.doc_number}; adopt or void instead`);
      evidence = { absentQueryAt: new Date().toISOString(), docNumber: job.doc_number };
      await withTx(this.db, async (tx) => {
        if (r.action === "retry") {
          await tx.query("update outbox set status = 'pending', available_at = now(), lease_owner = null, lease_until = null, updated_at = now() where id = $1", [job.id]);
          await this.toStatus(tx, item.invoice_id!, "POSTING", actor, "recovery_retry", evidence);
        } else {
          await tx.query("update approvals set voided_at = now(), void_reason = $2 where id = $1 and voided_at is null", [job.approval_id, `closed: ${r.reason}`]);
          await tx.query("update po_line_reservations set active = false where approval_id = $1", [job.approval_id]);
          await this.toStatus(tx, item.invoice_id!, "REJECTED", actor, "recovery_close", { ...evidence, reason: r.reason });
        }
        await this.close(tx, item.id, r.action, actor, evidence);
      });
      return;
    }

    if (r.action === "accept_ledger") {
      if (item.kind !== "reconcile_mismatch" || !item.bill_id || !item.invoice_id) throw new ConflictError("accept_ledger applies to reconcile mismatches");
      const bill = await this.qbo.getBill(item.bill_id);
      if (!bill) throw new ConflictError("bill no longer exists; use acknowledge_deleted");
      evidence = { bill: summarize(bill) };
      await withTx(this.db, async (tx) => {
        // System of record wins: local posting takes the ledger's values.
        await tx.query("update postings set total_minor = $2, doc_number = $3, vendor_ref = $4 where bill_id = $1 and voided_at is null", [bill.Id, toMinor(bill.TotalAmt, bill.CurrencyRef?.value ?? "USD"), bill.DocNumber ?? "", bill.VendorRef.value]);
        await this.toStatus(tx, item.invoice_id!, "RECONCILED", actor, "recovery_accept_ledger", evidence);
        await this.close(tx, item.id, r.action, actor, evidence);
      });
      return;
    }

    if (r.action === "acknowledge_deleted") {
      if (!item.bill_id || !item.invoice_id) throw new ConflictError("acknowledge_deleted needs a bill");
      if (await this.qbo.getBill(item.bill_id)) throw new ConflictError("bill still exists in the ledger");
      evidence = { readAt: new Date().toISOString(), billId: item.bill_id, reason: r.reason };
      await withTx(this.db, async (tx) => {
        await tx.query("update postings set voided_at = now(), void_reason = $2 where bill_id = $1", [item.bill_id, r.reason]);
        await this.toStatus(tx, item.invoice_id!, "REJECTED", actor, "recovery_ack_deleted", evidence);
        await this.close(tx, item.id, r.action, actor, evidence);
      });
      return;
    }

    // confirm_duplicate_voided: a person voided the extra Bill in QBO; verify it is gone.
    if (item.kind !== "orphan_remote_bill" || !item.bill_id) throw new ConflictError("confirm_duplicate_voided applies to orphan bills");
    if (await this.qbo.getBill(item.bill_id)) throw new ConflictError("duplicate bill still exists in the ledger; void it in QBO first");
    evidence = { readAt: new Date().toISOString(), billId: item.bill_id };
    await withTx(this.db, (tx) => this.close(tx, item.id, r.action, actor, evidence));
  }

  private async toStatus(tx: Parameters<typeof setStatus>[0], invoiceId: number, to: "POSTED" | "POSTING" | "REJECTED" | "RECONCILED", actor: string, action: string, detail: Record<string, unknown>) {
    const st = (await tx.query("select status from invoices where id = $1 for update", [invoiceId])).rows[0].status as string;
    if (st !== to) await setStatus(tx, invoiceId, to, actor, action, detail);
    else await audit(tx, { invoiceId, actor, action, detail });
  }

  private async close(tx: Parameters<typeof setStatus>[0], id: number, resolution: string, actor: string, evidence: Record<string, unknown>) {
    await tx.query("update recovery_queue set resolved_at = now(), resolution = $2, resolved_by = $3, evidence = $4 where id = $1", [id, resolution, actor, JSON.stringify(evidence)]);
  }
}

function summarize(b: Bill) {
  return { id: b.Id, docNumber: b.DocNumber ?? null, vendor: b.VendorRef.value, totalAmt: b.TotalAmt, privateNote: b.PrivateNote ?? null };
}
