import type { Tx } from "./db.ts";

export type InvoiceStatus =
  | "RECEIVED" | "PARSED" | "EXTRACTED" | "MATCHED" | "AUTO_APPROVED" | "NEEDS_REVIEW" | "APPROVED" | "REJECTED"
  | "POSTING" | "POSTED" | "RECONCILED" | "RECOVERY";

export class ConflictError extends Error {
  readonly status = 409;
}
export class NotFoundError extends Error {
  readonly status = 404;
}

/** The only way invoice status changes. The DB trigger rejects illegal pairs; every change is audited. */
export async function setStatus(tx: Tx, invoiceId: number, to: InvoiceStatus, actor: string, action: string, detail: Record<string, unknown> = {}): Promise<void> {
  const r = await tx.query<{ status: InvoiceStatus }>("select status from invoices where id = $1", [invoiceId]);
  const from = r.rows[0]?.status;
  if (!from) throw new NotFoundError(`invoice ${invoiceId} not found`);
  await tx.query("update invoices set status = $2 where id = $1", [invoiceId, to]);
  await audit(tx, { invoiceId, actor, action, from, to, detail });
}

export async function audit(tx: Tx, e: { invoiceId: number | null; actor: string; action: string; from?: string | null; to?: string | null; detail?: Record<string, unknown> }): Promise<void> {
  await tx.query("insert into audit_log (invoice_id, actor, action, from_status, to_status, detail) values ($1, $2, $3, $4, $5, $6)", [
    e.invoiceId, e.actor, e.action, e.from ?? null, e.to ?? null, JSON.stringify(e.detail ?? {}),
  ]);
}

export async function openRecovery(tx: Tx, item: { invoiceId: number | null; outboxId?: number | null; billId?: string | null; kind: string; detail: Record<string, unknown> }): Promise<void> {
  // Idempotent: one open item per (invoice, bill, kind).
  await tx.query(
    `insert into recovery_queue (invoice_id, outbox_id, bill_id, kind, detail) values ($1, $2, $3, $4, $5)
     on conflict (coalesce(invoice_id, 0), coalesce(bill_id, ''), kind) where resolved_at is null do nothing`,
    [item.invoiceId, item.outboxId ?? null, item.billId ?? null, item.kind, JSON.stringify(item.detail)],
  );
}
