import type { QboClient } from "@ipa/qbo";
import { QboUnavailableError } from "@ipa/qbo";
import type { Db } from "./db.ts";
import { withTx } from "./db.ts";
import { MARKER_PREFIX } from "./payload.ts";
import { openRecovery, setStatus } from "./transitions.ts";
import { sameContent } from "./worker.ts";
import { toMinor } from "@ipa/domain";

export interface ReconcileReport {
  runId: number;
  status: "complete" | "partial";
  checked: number;
  reconciled: number;
  missing: number;
  changed: number;
  orphans: number;
  scannedBills: number;
}

/**
 * Nightly reconciliation. The ledger (QBO) is the system of record: we never change it, we compare and queue
 * every difference for a person. Pass 1 reads each live local posting by Bill Id; pass 2 pages through the
 * ledger and finds Bills carrying our marker that no local posting claims (orphans / duplicates).
 * Any unavailable page marks the run partial; absence is never concluded from a failed read.
 */
export async function reconcile(db: Db, qbo: QboClient, opts: { pageSize?: number; actor?: string } = {}): Promise<ReconcileReport> {
  const actor = opts.actor ?? "reconciler";
  const run = (await db.query<{ id: number }>("insert into reconciliation_runs default values returning id")).rows[0]!.id;
  const rep: ReconcileReport = { runId: run, status: "complete", checked: 0, reconciled: 0, missing: 0, changed: 0, orphans: 0, scannedBills: 0 };
  // Live postings with the payload that was approved; a posting whose ledger values were accepted by a person
  // (accept_ledger) is compared on the accepted total only.
  const postings = (await db.query("select p.*, o.payload, exists (select 1 from recovery_queue q where q.bill_id = p.bill_id and q.resolution = 'accept_ledger') as ledger_accepted from postings p join outbox o on o.id = p.outbox_id where p.voided_at is null order by p.invoice_id")).rows;
  try {
    for (const p of postings) {
      const bill = await qbo.getBill(p.bill_id);
      rep.checked++;
      await withTx(db, async (tx) => {
        const st = (await tx.query("select status from invoices where id = $1 for update", [p.invoice_id])).rows[0].status as string;
        const live = st === "POSTED" || st === "RECONCILED";
        if (!bill) {
          rep.missing++;
          await openRecovery(tx, { invoiceId: p.invoice_id, billId: p.bill_id, kind: "reconcile_mismatch", detail: { issue: "missing_in_ledger", billId: p.bill_id } });
          if (live) await setStatus(tx, p.invoice_id, "RECOVERY", actor, "reconcile_missing", { billId: p.bill_id });
          return;
        }
        const ledgerMinor = toMinor(bill.TotalAmt, p.currency);
        const contentOk = p.ledger_accepted || sameContent(bill, p.payload);
        if (ledgerMinor !== p.total_minor || bill.VendorRef.value !== p.vendor_ref || bill.DocNumber !== p.doc_number || (bill.CurrencyRef?.value ?? p.currency) !== p.currency || !contentOk) {
          rep.changed++;
          await openRecovery(tx, {
            invoiceId: p.invoice_id, billId: p.bill_id, kind: "reconcile_mismatch",
            detail: { issue: "ledger_differs", local: { totalMinor: p.total_minor, vendor: p.vendor_ref, docNumber: p.doc_number }, ledger: { totalMinor: ledgerMinor, vendor: bill.VendorRef.value, docNumber: bill.DocNumber ?? null } },
          });
          if (live) await setStatus(tx, p.invoice_id, "RECOVERY", actor, "reconcile_mismatch", { billId: p.bill_id });
          return;
        }
        if (st === "POSTED") await setStatus(tx, p.invoice_id, "RECONCILED", actor, "reconciled", { billId: p.bill_id });
        if (live) rep.reconciled++;
      });
    }
    const pageSize = opts.pageSize ?? 100;
    let start = 1;
    while (true) {
      const page = await qbo.listBills(start, pageSize);
      rep.scannedBills += page.length;
      for (const b of page) {
        const note = b.PrivateNote ?? "";
        if (!note.startsWith(MARKER_PREFIX)) continue; // not created by this integration
        const claimed = (await db.query("select 1 from postings where bill_id = $1 and voided_at is null", [b.Id])).rows[0];
        if (claimed) continue;
        const requestId = note.slice(MARKER_PREFIX.length).split(" ")[0]!;
        const job = (await db.query("select id, invoice_id from outbox where request_id = $1", [requestId])).rows[0];
        rep.orphans++;
        await withTx(db, (tx) =>
          openRecovery(tx, { invoiceId: job?.invoice_id ?? null, outboxId: job?.id ?? null, billId: b.Id, kind: "orphan_remote_bill", detail: { billId: b.Id, requestId, docNumber: b.DocNumber ?? null, totalAmt: b.TotalAmt } }),
        );
      }
      await db.query("update reconciliation_runs set checkpoint = $2 where id = $1", [run, start + page.length]);
      if (page.length < pageSize) break;
      start += pageSize;
    }
  } catch (e) {
    if (!(e instanceof QboUnavailableError)) throw e;
    rep.status = "partial";
  }
  await db.query("update reconciliation_runs set finished_at = now(), status = $2, counts = $3 where id = $1", [run, rep.status, JSON.stringify(rep)]);
  return rep;
}
