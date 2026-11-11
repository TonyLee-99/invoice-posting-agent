import { v5 as uuidv5 } from "uuid";
import type { GoodsReceipt, InvoiceFields, PurchaseOrder, ScalarField, Vendor } from "@ipa/domain";
import { InvoiceFields as InvoiceFieldsSchema, contentHash, normalizeInvoiceNumber } from "@ipa/domain";
import type { MatchPolicy, MatchResult, RouteResult, RoutingPolicy } from "@ipa/matching";
import { DEFAULT_MATCH_POLICY, DEFAULT_ROUTING_POLICY, resolveVendor, route, threeWayMatch } from "@ipa/matching";
import type { Db, Tx } from "./db.ts";
import { withTx } from "./db.ts";
import type { AccountMap } from "./payload.ts";
import { buildBill } from "./payload.ts";
import type { InvoiceStatus } from "./transitions.ts";
import { ConflictError, NotFoundError, audit, setStatus } from "./transitions.ts";

/** Namespace for deterministic requestids (UUIDv5 of the idempotency key). */
const REQUEST_ID_NS = "6f1d3c2a-8c43-4b7e-9e7a-2f3b1d9c0a55";

export interface IngestInput {
  sourceSha256?: string | null;
  sourceName?: string | null;
  sourceMime?: string | null;
  parsedText?: string | null;
  extracted?: unknown;
  extractionMeta?: Record<string, unknown>;
  fields: InvoiceFields;
  /** Calibrated per-field confidence; null if extraction failed. */
  confidence: Partial<Record<ScalarField, number>> | null;
}

export interface InvoiceRow {
  id: number;
  status: InvoiceStatus;
  fields: InvoiceFields;
  content_hash: string;
  version: number;
  vendor_id: string | null;
  invoice_number_norm: string | null;
  match: (MatchResult & { route?: RouteResult }) | null;
  decision: string | null;
  extraction_meta: Record<string, unknown> | null;
}

const EDITABLE: InvoiceStatus[] = ["EXTRACTED", "MATCHED", "NEEDS_REVIEW", "AUTO_APPROVED", "APPROVED", "REJECTED"];

export class PostingService {
  constructor(
    readonly db: Db,
    readonly opts: { realmId: string; matchPolicy?: MatchPolicy; routingPolicy?: RoutingPolicy; fxRates?: Record<string, number>; accounts?: AccountMap } = { realmId: "9341455000000001" },
  ) {}

  private get routing(): RoutingPolicy {
    return this.opts.routingPolicy ?? DEFAULT_ROUTING_POLICY;
  }

  // ---- reference data (Simulated vendor master / POs / receipts) ---------------------------------

  async upsertVendor(v: Vendor & { expenseAccountRef?: string }): Promise<void> {
    await this.db.query(
      `insert into vendors (vendor_id, name, aliases, tax_id, qbo_vendor_id, currency) values ($1,$2,$3,$4,$5,$6)
       on conflict (vendor_id) do update set name = excluded.name, aliases = excluded.aliases, tax_id = excluded.tax_id, qbo_vendor_id = excluded.qbo_vendor_id, currency = excluded.currency`,
      [v.vendorId, v.name, JSON.stringify(v.aliases), v.taxId, v.qboVendorId, v.currency],
    );
  }

  async upsertPo(po: PurchaseOrder): Promise<void> {
    await this.db.query(
      `insert into purchase_orders (po_number, vendor_id, currency, kind, status, tax_rate, freight_allowance_minor, lines) values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (po_number) do update set lines = excluded.lines, status = excluded.status, tax_rate = excluded.tax_rate, freight_allowance_minor = excluded.freight_allowance_minor, currency = excluded.currency, vendor_id = excluded.vendor_id, kind = excluded.kind`,
      [po.poNumber, po.vendorId, po.currency, po.kind, po.status, po.taxRate, po.freightAllowanceMinor, JSON.stringify(po.lines)],
    );
  }

  async addReceipt(gr: GoodsReceipt): Promise<void> {
    await this.db.query(`insert into goods_receipts (gr_number, po_number, received_at, lines) values ($1,$2,$3,$4) on conflict (gr_number) do update set lines = excluded.lines`, [
      gr.grNumber, gr.poNumber, gr.receivedAt, JSON.stringify(gr.lines),
    ]);
  }

  private async referenceData(tx: Tx): Promise<{ vendors: Vendor[]; pos: PurchaseOrder[]; receipts: GoodsReceipt[] }> {
    const vendors = (await tx.query("select * from vendors")).rows.map((r) => ({ vendorId: r.vendor_id, name: r.name, aliases: r.aliases, taxId: r.tax_id, qboVendorId: r.qbo_vendor_id, currency: r.currency }) as Vendor);
    const pos = (await tx.query("select * from purchase_orders")).rows.map((r) => ({ poNumber: r.po_number, vendorId: r.vendor_id, currency: r.currency, kind: r.kind, status: r.status, taxRate: r.tax_rate, freightAllowanceMinor: r.freight_allowance_minor, lines: r.lines }) as PurchaseOrder);
    const receipts = (await tx.query("select * from goods_receipts")).rows.map((r) => ({ grNumber: r.gr_number, poNumber: r.po_number, receivedAt: r.received_at, lines: r.lines }) as GoodsReceipt);
    return { vendors, pos, receipts };
  }

  private async reservedByOthers(tx: Tx, poNumber: string, invoiceId: number): Promise<Record<string, number>> {
    const r = await tx.query<{ line_no: number; q: number }>(
      "select line_no, sum(quantity)::float8 as q from po_line_reservations where po_number = $1 and active and invoice_id <> $2 group by line_no",
      [poNumber, invoiceId],
    );
    return Object.fromEntries(r.rows.map((x) => [`${poNumber}:${x.line_no}`, x.q]));
  }

  /**
   * Match under the PO row lock so two invoices against the same PO line serialize and cannot both consume
   * the same received quantity (reservations are taken in the same transaction as the approval).
   */
  private async matchLocked(tx: Tx, invoiceId: number, fields: InvoiceFields, isDuplicate: boolean): Promise<MatchResult> {
    const ref = await this.referenceData(tx);
    const policy = this.opts.matchPolicy ?? DEFAULT_MATCH_POLICY;
    const fxRates = this.opts.fxRates ?? {};
    let m = threeWayMatch({ fields, vendors: ref.vendors, purchaseOrders: ref.pos, receipts: ref.receipts, isDuplicate, fxRates }, policy);
    if (m.poNumber) {
      await tx.query("select 1 from purchase_orders where po_number = $1 for update", [m.poNumber]);
      const reserved = await this.reservedByOthers(tx, m.poNumber, invoiceId);
      m = threeWayMatch({ fields, vendors: ref.vendors, purchaseOrders: ref.pos, receipts: ref.receipts, isDuplicate, reservedByOthers: reserved, fxRates }, policy);
    }
    return m;
  }

  // ---- ingest + routing -------------------------------------------------------------------------

  async ingest(input: IngestInput, actor = "pipeline"): Promise<{ id: number; decision: string; status: InvoiceStatus }> {
    const fields = InvoiceFieldsSchema.parse(input.fields);
    return withTx(this.db, async (tx) => {
      const ref = await this.referenceData(tx);
      const vendor = resolveVendor(fields, ref.vendors);
      const numberNorm = normalizeInvoiceNumber(fields.invoiceNumber);
      if (vendor && numberNorm) await tx.query("select pg_advisory_xact_lock(hashtext($1))", [`${vendor.vendorId}|${numberNorm}`]);
      const dup = vendor && numberNorm
        ? (await tx.query("select id from invoices where vendor_id = $1 and invoice_number_norm = $2 and status <> 'REJECTED' limit 1", [vendor.vendorId, numberNorm])).rows[0]
        : undefined;
      const meta = { ...(input.extractionMeta ?? {}), confidence: input.confidence };
      const ins = await tx.query<{ id: number }>(
        `insert into invoices (source_sha256, source_name, source_mime, parsed_text, extracted, extraction_meta, fields, content_hash, status, vendor_id, invoice_number_norm)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
        [input.sourceSha256 ?? null, input.sourceName ?? null, input.sourceMime ?? null, input.parsedText ?? null, JSON.stringify(input.extracted ?? null), JSON.stringify(meta), JSON.stringify(fields), contentHash(fields), dup ? "REJECTED" : "EXTRACTED", vendor?.vendorId ?? null, numberNorm || null],
      );
      const id = ins.rows[0]!.id;
      await audit(tx, { invoiceId: id, actor, action: "ingest", to: dup ? "REJECTED" : "EXTRACTED", detail: { sourceName: input.sourceName ?? null } });
      if (dup) {
        const m = threeWayMatch({ fields, vendors: ref.vendors, purchaseOrders: [], receipts: [], isDuplicate: true });
        const r = route({ match: m, totalMinor: fields.totalMinor, confidence: input.confidence }, this.routing);
        await tx.query("update invoices set match = $2, decision = 'REJECT' where id = $1", [id, JSON.stringify({ ...m, route: r, duplicateOf: dup.id })]);
        await audit(tx, { invoiceId: id, actor, action: "reject_duplicate", detail: { duplicateOf: dup.id } });
        return { id, decision: "REJECT", status: "REJECTED" as InvoiceStatus };
      }
      return this.matchAndRoute(tx, id, fields, input.confidence, actor, false);
    });
  }

  private async matchAndRoute(tx: Tx, id: number, fields: InvoiceFields, confidence: IngestInput["confidence"], actor: string, edited: boolean): Promise<{ id: number; decision: string; status: InvoiceStatus }> {
    const m = await this.matchLocked(tx, id, fields, false);
    await setStatus(tx, id, "MATCHED", actor, edited ? "rematch_after_edit" : "match", { poNumber: m.poNumber, discrepancies: m.discrepancies.map((d) => d.code) });
    let r = route({ match: m, totalMinor: fields.totalMinor, confidence, humanVerified: edited }, this.routing);
    // An edited invoice always needs an explicit human approval of the new content.
    if (edited && r.decision === "AUTO_APPROVE") r = { ...r, decision: "NEEDS_REVIEW" };
    await tx.query("update invoices set match = $2, decision = $3, vendor_id = coalesce($4, vendor_id) where id = $1", [id, JSON.stringify({ ...m, route: r }), r.decision, m.vendorId]);
    if (r.decision === "REJECT") {
      await setStatus(tx, id, "REJECTED", actor, "route_reject", { reasons: r.reasons.map((x) => x.code) });
      return { id, decision: r.decision, status: "REJECTED" };
    }
    if (r.decision === "NEEDS_REVIEW") {
      await setStatus(tx, id, "NEEDS_REVIEW", actor, "route_review", { reasons: r.reasons.map((x) => x.code) });
      return { id, decision: r.decision, status: "NEEDS_REVIEW" };
    }
    await setStatus(tx, id, "AUTO_APPROVED", "policy:" + r.policyVersion, "auto_approve", {});
    await this.createApproval(tx, id, "auto", m);
    return { id, decision: r.decision, status: "AUTO_APPROVED" };
  }

  /** Approval row + PO quantity reservations + outbox job, all in the caller's transaction. */
  private async createApproval(tx: Tx, invoiceId: number, approver: string, m: MatchResult): Promise<number> {
    const inv = (await tx.query("select i.*, v.qbo_vendor_id from invoices i left join vendors v on v.vendor_id = i.vendor_id where i.id = $1", [invoiceId])).rows[0];
    if (!inv.qbo_vendor_id) throw new ConflictError("cannot approve: vendor is not in the vendor master");
    const ap = await tx.query<{ id: number }>("insert into approvals (invoice_id, approved_content_hash, approved_version, approver) values ($1,$2,$3,$4) returning id", [invoiceId, inv.content_hash, inv.version, approver]);
    const approvalId = ap.rows[0]!.id;
    if (m.poNumber) {
      for (const lm of m.lineMatches) {
        if (lm.poLineNo === null || lm.quantity === null) continue;
        await tx.query(
          `insert into po_line_reservations (invoice_id, approval_id, po_number, line_no, quantity) values ($1,$2,$3,$4,$5)
           on conflict (approval_id, po_number, line_no) do update set quantity = po_line_reservations.quantity + excluded.quantity`,
          [invoiceId, approvalId, m.poNumber, lm.poLineNo, lm.quantity],
        );
      }
    }
    const key = `approval:${approvalId}`;
    // Namespaced by installation: approval ids restart after a reset/restore, requestids must not (INC-16).
    const installation = (await tx.query("select id from installation limit 1")).rows[0].id as string;
    const requestId = uuidv5(`${installation}:${key}`, REQUEST_ID_NS);
    const built = buildBill(inv.fields as InvoiceFields, { qboVendorId: inv.qbo_vendor_id, requestId, ...(this.opts.accounts ? { accounts: this.opts.accounts } : {}) });
    await tx.query(
      `insert into outbox (invoice_id, approval_id, idempotency_key, request_id, realm_id, doc_number, vendor_ref, payload, payload_hash, status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')`,
      [invoiceId, approvalId, key, requestId, this.opts.realmId, built.docNumber, inv.qbo_vendor_id, built.payload, built.payloadHash],
    );
    await audit(tx, { invoiceId, actor: approver, action: "approval_created", detail: { approvalId, contentHash: inv.content_hash, requestId } });
    return approvalId;
  }

  // ---- human actions ----------------------------------------------------------------------------

  /** Human approval. `expectedContentHash` is the hash the reviewer saw; a stale view is refused. */
  async approve(invoiceId: number, actor: string, expectedContentHash: string): Promise<void> {
    await withTx(this.db, async (tx) => {
      const inv = await this.lock(tx, invoiceId);
      if (inv.status !== "NEEDS_REVIEW") throw new ConflictError(`cannot approve from ${inv.status}`);
      if (inv.content_hash !== expectedContentHash) throw new ConflictError("invoice changed since it was displayed; reload and review again");
      // Re-check matching under the PO lock: another invoice may have consumed the receipt meanwhile.
      const m = await this.matchLocked(tx, invoiceId, inv.fields, false);
      const blocking = m.discrepancies.filter((d) => d.code === "qty_over_received" && Number(d.facts.reservedByOthers ?? 0) > 0);
      if (blocking.length) throw new ConflictError("received quantity is already reserved by another approved invoice");
      await setStatus(tx, invoiceId, "APPROVED", actor, "approve", { contentHash: inv.content_hash });
      await this.createApproval(tx, invoiceId, actor, m);
    });
  }

  async reject(invoiceId: number, actor: string, reason: string): Promise<void> {
    await withTx(this.db, async (tx) => {
      const inv = await this.lock(tx, invoiceId);
      if (!["NEEDS_REVIEW", "MATCHED", "EXTRACTED"].includes(inv.status)) throw new ConflictError(`cannot reject from ${inv.status}`);
      await setStatus(tx, invoiceId, "REJECTED", actor, "reject", { reason });
    });
  }

  /**
   * Edit fields. Voids the current approval (and its reservations, and the never-sent outbox job), re-matches,
   * and always lands in NEEDS_REVIEW. Refused once posting has started.
   */
  async edit(invoiceId: number, actor: string, patch: Partial<InvoiceFields>, expectedVersion?: number): Promise<{ status: InvoiceStatus; contentHash: string; version: number }> {
    return withTx(this.db, async (tx) => {
      const inv = await this.lock(tx, invoiceId);
      if (!EDITABLE.includes(inv.status)) throw new ConflictError(`invoice is ${inv.status}; posted invoices are corrected in the ledger, not edited`);
      if (expectedVersion !== undefined && expectedVersion !== inv.version) throw new ConflictError("invoice was edited by someone else; reload");
      const next = InvoiceFieldsSchema.parse({ ...inv.fields, ...patch });
      const hash = contentHash(next);
      const voided = await tx.query<{ id: number }>("update approvals set voided_at = now(), void_reason = 'edited' where invoice_id = $1 and voided_at is null returning id", [invoiceId]);
      if (voided.rows.length) {
        await tx.query("update po_line_reservations set active = false where approval_id = any($1)", [voided.rows.map((r) => r.id)]);
        const cancelled = await tx.query("update outbox set status = 'cancelled', updated_at = now() where invoice_id = $1 and status in ('pending', 'in_flight') returning id", [invoiceId]);
        await audit(tx, { invoiceId, actor, action: "approval_voided", detail: { approvals: voided.rows.map((r) => r.id), cancelledJobs: cancelled.rows.map((r) => r.id) } });
      }
      const ref = await this.referenceData(tx);
      const vendor = resolveVendor(next, ref.vendors);
      await tx.query("update invoices set fields = $2, content_hash = $3, version = version + 1, vendor_id = $4, invoice_number_norm = $5 where id = $1", [
        invoiceId, JSON.stringify(next), hash, vendor?.vendorId ?? null, normalizeInvoiceNumber(next.invoiceNumber) || null,
      ]);
      await audit(tx, { invoiceId, actor, action: "edit", from: inv.status, detail: { before: inv.content_hash, after: hash, changed: Object.keys(patch) } });
      const confidence = (inv.extraction_meta?.confidence ?? null) as IngestInput["confidence"];
      const r = await this.matchAndRoute(tx, invoiceId, next, confidence, actor, true);
      const v = (await tx.query("select version from invoices where id = $1", [invoiceId])).rows[0].version as number;
      return { status: r.status, contentHash: hash, version: v };
    });
  }

  async get(invoiceId: number): Promise<InvoiceRow> {
    const r = await this.db.query("select * from invoices where id = $1", [invoiceId]);
    if (!r.rows[0]) throw new NotFoundError(`invoice ${invoiceId} not found`);
    return r.rows[0] as InvoiceRow;
  }

  private async lock(tx: Tx, invoiceId: number): Promise<InvoiceRow> {
    const r = await tx.query("select * from invoices where id = $1 for update", [invoiceId]);
    if (!r.rows[0]) throw new NotFoundError(`invoice ${invoiceId} not found`);
    return r.rows[0] as InvoiceRow;
  }
}
