// **Simulated** procurement data. QBO has no goods-receipt concept and the public invoice sets have no POs, so
// vendor master, POs and receipts are generated from each invoice's *label* (not from the extraction), with one
// controlled discrepancy chosen by a hash of the doc id. The expected routing outcome is part of the label.
import { createHash } from "node:crypto";
import type { GoodsReceipt, InvoiceFields, PurchaseOrder, Vendor } from "@ipa/domain";
import { toMinor } from "@ipa/domain";
import type { ManifestDoc } from "./prepare.ts";

export type Scenario =
  | "clean" | "price_within_tolerance" | "price_over_tolerance" | "partial_receipts" | "short_receipt" | "no_receipt"
  | "tax_rate_mismatch" | "currency_mismatch" | "no_po" | "unknown_vendor" | "duplicate";

export interface ProcCase {
  docId: string;
  scenario: Scenario;
  /** Expected match outcome: "clean" (eligible for auto-approval), "review", or "reject". */
  expected: "clean" | "review" | "reject";
  vendor: Vendor | null;
  pos: PurchaseOrder[];
  receipts: GoodsReceipt[];
  isDuplicate: boolean;
  /** **Simulated** treasury rate table (only for dual-currency documents). */
  fxRates: Record<string, number>;
}

const h = (s: string) => createHash("sha256").update(s).digest().readUInt32BE(0) / 2 ** 32;

/** Vendor master name: IPP labels are names; Katana labels are "name + street address" (cut at the first digit). */
export function vendorNameOf(doc: ManifestDoc): string {
  const raw = doc.gt.vendor_name ?? "Unknown vendor";
  if (doc.vendorRule === "name") return raw;
  return raw.split(/\s+(?=\d)/)[0]!.trim();
}

/** Canonical fields from the label (used to test the matcher in isolation from extraction). */
export function gtFields(doc: ManifestDoc): InvoiceFields {
  const g = doc.gt;
  const cur = g.currency ?? "USD";
  const m = (v: number | null) => (v === null ? null : toMinor(Math.abs(v), cur));
  // IPP totals include shipping without a separate label; recover it as total - subtotal - tax (consistent docs only).
  const gap = g.total !== null && g.subtotal !== null ? Math.abs(g.total) - Math.abs(g.subtotal) - Math.abs(g.tax ?? 0) : 0;
  const freight = !g.should_flag && gap > 0.015 ? m(gap) : null;
  // Dual-currency labels give the line currency and the total in it; the document's rate is their ratio.
  const dual = g.secondary && g.total ? { lineCurrency: g.secondary[0], fxBase: g.secondary[0], exchangeRate: Math.round((Math.abs(g.total) / g.secondary[1]) * 10_000) / 10_000 } : null;
  return {
    vendorName: g.vendor_name, vendorTaxId: g.vendor_tax_id, invoiceNumber: g.invoice_number, poNumber: null,
    invoiceDate: g.invoice_date, dueDate: g.due_date, currency: g.currency ?? "USD", documentType: g.document_type,
    subtotalMinor: m(g.subtotal), taxMinor: m(g.tax), freightMinor: freight, totalMinor: m(g.total),
    lines: g.lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unit_price, amountMinor: toMinor(l.amount, dual?.lineCurrency ?? cur) })),
    ...(dual ? dual : {}),
  };
}

/**
 * Label-generator rule v2 (2026-11-11 round 2): a document is expected to go to a person, whatever the Simulated
 * procurement scenario, when its own labels lack a field needed to post (vendor, number, date, total) or its labelled
 * amounts do not add up (lines vs subtotal, with tax-inclusive lines allowed; subtotal + tax + shipping vs total).
 * v1 assumed every generated "clean" scenario was clean; results/matching.json reports both.
 */
export function needsPerson(doc: ManifestDoc): boolean {
  const g = doc.gt;
  if (!g.vendor_name || !g.invoice_number || !g.invoice_date || g.total === null) return true;
  if (g.secondary) return false; // dual-currency: lines are in another currency; checked through the FX rule
  const lineSum = g.lines.reduce((s, l) => s + l.amount, 0);
  const sub = Math.abs(g.subtotal ?? 0), tax = Math.abs(g.tax ?? 0);
  const near = (a: number, b: number) => Math.abs(a - b) <= 0.02; // same 2-cent tolerance as the matcher
  if (g.lines.length && g.subtotal !== null && !near(lineSum, sub) && !near(lineSum, sub + tax)) return true;
  return g.subtotal !== null && Math.abs(g.total) + 0.015 < sub + tax; // total smaller than subtotal + tax: labels inconsistent
}

/** v1 expected outcome, kept so the earlier reported matcher numbers can be reproduced. */
export function expectedV1(doc: ManifestDoc, p: ProcCase): ProcCase["expected"] {
  const unsupported = doc.gt.document_type !== "invoice";
  return unsupported || p.scenario === "duplicate" ? "reject" : doc.gt.should_flag ? "review" : ["clean", "price_within_tolerance", "partial_receipts"].includes(p.scenario) ? "clean" : "review";
}

export function procurementFor(doc: ManifestDoc): ProcCase {
  const goods = doc.source === "katana"; // Katana rows carry qty + unit price -> 3-way; IPP -> amount-based 2-way
  const r = h(`proc-v1:${doc.docId}`);
  const pool: Scenario[] = goods
    ? ["clean", "clean", "clean", "clean", "clean", "price_within_tolerance", "price_over_tolerance", "partial_receipts", "short_receipt", "no_receipt", "tax_rate_mismatch", "no_po", "unknown_vendor", "duplicate"]
    : ["clean", "clean", "clean", "clean", "clean", "clean", "price_within_tolerance", "price_over_tolerance", "tax_rate_mismatch", "currency_mismatch", "no_po", "unknown_vendor", "duplicate"];
  let scenario = pool[Math.floor(r * pool.length)]!;
  const g = doc.gt;
  if (!g.lines.length && ["price_within_tolerance", "price_over_tolerance", "partial_receipts", "short_receipt", "no_receipt"].includes(scenario)) scenario = "clean";
  if (!g.tax && scenario === "tax_rate_mismatch") scenario = "clean";
  const cur = g.currency ?? "USD";
  // A PO for a dual-currency vendor is raised in the line currency (e.g. USD), the vendor invoices payable in NAD.
  const poCur = g.secondary ? g.secondary[0] : cur;
  const vendorId = `V-${createHash("sha256").update(vendorNameOf(doc)).digest("hex").slice(0, 8)}`;
  const vendor: Vendor = { vendorId, name: vendorNameOf(doc), aliases: [], taxId: g.vendor_tax_id, qboVendorId: String(1000 + Math.floor(h(vendorId) * 9000)), currency: cur };
  const poNumber = `PO-${doc.docId.replace(/[^a-z0-9]/gi, "").slice(-10).toUpperCase()}`;
  const taxRate = g.tax && g.subtotal ? Math.round((Math.abs(g.tax) / Math.abs(g.subtotal)) * 10000) / 10000 : null;
  const lines = (g.lines.length ? g.lines : [{ description: "Invoice total", quantity: 1, unit_price: Math.abs(g.subtotal ?? g.total ?? 0), amount: Math.abs(g.subtotal ?? g.total ?? 0) }]).map((l, i) => {
    const qty = goods ? (l.quantity ?? 1) : 1;
    const unit = goods ? (l.unit_price ?? l.amount / qty) : Math.abs(l.amount);
    return { lineNo: i + 1, description: l.description, quantity: qty, unitPrice: unit };
  });
  if (scenario === "price_over_tolerance") lines[0]!.unitPrice = Math.round(lines[0]!.unitPrice * 0.9 * 100) / 100;
  if (scenario === "price_within_tolerance") lines[0]!.unitPrice = Math.round(lines[0]!.unitPrice * 0.99 * 100) / 100;
  const po: PurchaseOrder = {
    poNumber, vendorId, currency: scenario === "currency_mismatch" ? (poCur === "USD" ? "EUR" : "USD") : poCur, kind: goods ? "goods" : "services", status: "open",
    taxRate: scenario === "tax_rate_mismatch" && taxRate !== null ? Math.max(0, taxRate - 0.05) : taxRate, freightAllowanceMinor: Math.max(toMinor(50, cur), gtFields(doc).freightMinor ?? 0), lines,
  };
  const receipts: GoodsReceipt[] = [];
  if (goods && scenario !== "no_receipt") {
    const full = lines.map((l) => ({ poLineNo: l.lineNo, quantityReceived: l.quantity }));
    if (scenario === "partial_receipts") {
      receipts.push({ grNumber: `${poNumber}-GR1`, poNumber, receivedAt: "2026-01-01", lines: full.map((l) => ({ ...l, quantityReceived: l.quantityReceived / 2 })) });
      receipts.push({ grNumber: `${poNumber}-GR2`, poNumber, receivedAt: "2026-01-02", lines: full.map((l) => ({ ...l, quantityReceived: l.quantityReceived / 2 })) });
    } else if (scenario === "short_receipt") {
      receipts.push({ grNumber: `${poNumber}-GR1`, poNumber, receivedAt: "2026-01-01", lines: full.map((l, i) => (i === 0 ? { ...l, quantityReceived: Math.max(0, l.quantityReceived - 1) || 0.5 } : l)) });
    } else receipts.push({ grNumber: `${poNumber}-GR1`, poNumber, receivedAt: "2026-01-01", lines: full });
  }
  // A distractor PO for the same vendor, so PO selection without a printed PO number is actually exercised.
  const distractor: PurchaseOrder = { poNumber: `${poNumber}-X`, vendorId, currency: cur, kind: po.kind, status: "open", taxRate, freightAllowanceMinor: 0, lines: [{ lineNo: 1, description: "Consulting retainer quarterly", quantity: 1, unitPrice: 999 }] };
  const unsupported = g.document_type !== "invoice";
  const expected: ProcCase["expected"] = unsupported || scenario === "duplicate" ? "reject" : g.should_flag || needsPerson(doc) ? "review" : ["clean", "price_within_tolerance", "partial_receipts"].includes(scenario) ? "clean" : "review";
  return {
    docId: doc.docId, scenario, expected,
    vendor: scenario === "unknown_vendor" ? null : vendor,
    pos: scenario === "no_po" ? [distractor] : [distractor, po],
    receipts, isDuplicate: scenario === "duplicate",
    // Reference rate = the document's rate moved by a small, fixed treasury spread (0.2%): inside the 1% tolerance.
    fxRates: g.secondary && g.total ? { [`${g.secondary[0]}/${cur}`]: Math.round((Math.abs(g.total) / g.secondary[1]) * 1.002 * 10_000) / 10_000 } : {},
  };
}
