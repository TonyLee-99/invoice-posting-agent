import type { GoodsReceipt, InvoiceFields, PurchaseOrder, Vendor } from "@ipa/domain";
import { normalizeVendorName, tokenSimilarity, toMinor, vendorNamesMatch } from "@ipa/domain";

export type Severity = "block" | "review" | "info";

export type DiscrepancyCode =
  | "vendor_unknown"
  | "po_not_found"
  | "po_closed"
  | "po_vendor_mismatch"
  | "currency_mismatch"
  | "line_unmatched"
  | "price_over_tolerance"
  | "qty_over_received"
  | "qty_over_ordered"
  | "receipt_missing"
  | "tax_mismatch"
  | "freight_over_allowance"
  | "arithmetic_mismatch"
  | "duplicate_invoice"
  | "unsupported_document"
  | "missing_field"
  | "low_confidence"
  | "amount_over_cap";

export interface Discrepancy {
  code: DiscrepancyCode;
  severity: Severity;
  message: string;
  /** Machine-readable numbers behind the message. Drafted vendor emails may only cite these. */
  facts: Record<string, string | number | null>;
  lineIndex?: number;
}

export interface LineMatch {
  invoiceLine: number;
  poLineNo: number | null;
  quantity: number | null;
  invoiceAmountMinor: number;
  expectedAmountMinor: number | null;
  similarity: number;
}

export interface MatchPolicy {
  version: string;
  /** Extended-amount tolerance per line: max(pct * expected, abs). */
  priceTolerancePct: number;
  priceToleranceAbsMinor: number;
  taxTolerancePct: number;
  taxToleranceAbsMinor: number;
  arithmeticToleranceMinor: number;
  freightToleranceMinor: number;
  minLineSimilarity: number;
}

export const DEFAULT_MATCH_POLICY: MatchPolicy = {
  version: "match-2026-11-11",
  priceTolerancePct: 0.02,
  priceToleranceAbsMinor: 100,
  taxTolerancePct: 0.01,
  taxToleranceAbsMinor: 5,
  arithmeticToleranceMinor: 2,
  freightToleranceMinor: 100,
  minLineSimilarity: 0.25,
};

export interface MatchInput {
  fields: InvoiceFields;
  vendors: Vendor[];
  purchaseOrders: PurchaseOrder[];
  receipts: GoodsReceipt[];
  /** Quantities on PO lines already reserved by other approved invoices: key `${po}:${line}`. */
  reservedByOthers?: Record<string, number>;
  /** True when another live invoice from the same vendor has the same normalized number. */
  isDuplicate?: boolean;
}

export interface MatchResult {
  vendorId: string | null;
  poNumber: string | null;
  matchType: "3-way" | "2-way" | "none";
  discrepancies: Discrepancy[];
  lineMatches: LineMatch[];
  policyVersion: string;
}

export function resolveVendor(fields: InvoiceFields, vendors: Vendor[]): Vendor | null {
  if (fields.vendorTaxId) {
    const norm = fields.vendorTaxId.replace(/[^0-9a-z]/gi, "").toLowerCase();
    const byTax = vendors.find((v) => v.taxId && v.taxId.replace(/[^0-9a-z]/gi, "").toLowerCase() === norm);
    if (byTax) return byTax;
  }
  if (!fields.vendorName) return null;
  const exact = vendors.find((v) => [v.name, ...v.aliases].some((n) => normalizeVendorName(n) === normalizeVendorName(fields.vendorName)));
  if (exact) return exact;
  return vendors.find((v) => [v.name, ...v.aliases].some((n) => vendorNamesMatch(n, fields.vendorName))) ?? null;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Pair invoice lines with PO lines greedily by description similarity, using amount closeness as tie-breaker. */
function pairLines(fields: InvoiceFields, po: PurchaseOrder, policy: MatchPolicy): LineMatch[] {
  const cands: { i: number; j: number; score: number; sim: number }[] = [];
  fields.lines.forEach((line, i) => {
    po.lines.forEach((pl, j) => {
      const sim = tokenSimilarity(line.description, pl.description);
      // Services POs commit an amount per line (2-way, amount-based); goods POs a quantity at a unit price.
      const qty = po.kind === "services" ? pl.quantity : (line.quantity ?? pl.quantity);
      const expected = toMinor(pl.unitPrice * qty, po.currency);
      const amountCloseness = expected === 0 ? 0 : Math.max(0, 1 - Math.abs(line.amountMinor - expected) / Math.abs(expected));
      cands.push({ i, j, sim, score: sim + 0.25 * amountCloseness });
    });
  });
  cands.sort((a, b) => b.score - a.score);
  const usedI = new Set<number>();
  const usedJ = new Set<number>();
  const out: LineMatch[] = fields.lines.map((l, i) => ({ invoiceLine: i, poLineNo: null, quantity: l.quantity, invoiceAmountMinor: l.amountMinor, expectedAmountMinor: null, similarity: 0 }));
  for (const c of cands) {
    if (usedI.has(c.i) || usedJ.has(c.j) || c.sim < policy.minLineSimilarity) continue;
    usedI.add(c.i);
    usedJ.add(c.j);
    const pl = po.lines[c.j]!;
    const line = fields.lines[c.i]!;
    const qty = po.kind === "services" ? pl.quantity : (line.quantity ?? pl.quantity);
    out[c.i] = { invoiceLine: c.i, poLineNo: pl.lineNo, quantity: qty, invoiceAmountMinor: line.amountMinor, expectedAmountMinor: toMinor(pl.unitPrice * qty, po.currency), similarity: c.sim };
  }
  return out;
}

/** Choose the PO: the printed PO number if present, else the vendor's open PO whose lines pair best. */
function selectPo(fields: InvoiceFields, vendor: Vendor | null, pos: PurchaseOrder[], policy: MatchPolicy): PurchaseOrder | null {
  if (fields.poNumber) {
    const byNumber = pos.find((p) => p.poNumber.toLowerCase() === fields.poNumber!.toLowerCase());
    if (byNumber) return byNumber;
  }
  if (!vendor) return null;
  const candidates = pos.filter((p) => p.vendorId === vendor.vendorId);
  let best: { po: PurchaseOrder; score: number } | null = null;
  for (const po of candidates) {
    const pairs = pairLines(fields, po, policy);
    const matched = pairs.filter((p) => p.poLineNo !== null);
    const amountFit = matched.length ? sum(matched.map((p) => (p.expectedAmountMinor ? 1 - Math.min(1, Math.abs(p.invoiceAmountMinor - p.expectedAmountMinor) / Math.abs(p.expectedAmountMinor)) : 0))) : 0;
    const score = sum(matched.map((m) => m.similarity)) + amountFit - 0.5 * Math.abs(po.lines.length - fields.lines.length);
    if (!best || score > best.score) best = { po, score };
  }
  return best && best.score > 0 ? best.po : null;
}

export function threeWayMatch(input: MatchInput, policy: MatchPolicy = DEFAULT_MATCH_POLICY): MatchResult {
  const { fields } = input;
  const d: Discrepancy[] = [];

  if (fields.documentType !== "invoice") {
    d.push({ code: "unsupported_document", severity: "block", message: `Document type "${fields.documentType}" is not posted as a Bill (vendor credits and statements are handled manually).`, facts: { documentType: fields.documentType } });
  }
  if (input.isDuplicate) {
    d.push({ code: "duplicate_invoice", severity: "block", message: `Invoice ${fields.invoiceNumber} from this vendor was already received.`, facts: { invoiceNumber: fields.invoiceNumber } });
  }
  for (const [k, v] of [["vendorName", fields.vendorName], ["invoiceNumber", fields.invoiceNumber], ["invoiceDate", fields.invoiceDate], ["currency", fields.currency], ["totalMinor", fields.totalMinor]] as const) {
    if (v === null || v === "") d.push({ code: "missing_field", severity: "review", message: `Required field ${k} is missing.`, facts: { field: k } });
  }

  // Arithmetic consistency of the document itself.
  if (fields.lines.length && fields.subtotalMinor !== null) {
    const lineSum = sum(fields.lines.map((l) => l.amountMinor));
    if (Math.abs(lineSum - fields.subtotalMinor) > policy.arithmeticToleranceMinor) {
      d.push({ code: "arithmetic_mismatch", severity: "review", message: `Line amounts add up to ${lineSum / 100} but the subtotal says ${fields.subtotalMinor / 100}.`, facts: { lineSum: lineSum / 100, subtotal: fields.subtotalMinor / 100, difference: (fields.subtotalMinor - lineSum) / 100 } });
    }
  }
  if (fields.totalMinor !== null && fields.subtotalMinor !== null) {
    const expectTotal = fields.subtotalMinor + (fields.taxMinor ?? 0) + (fields.freightMinor ?? 0);
    if (Math.abs(expectTotal - fields.totalMinor) > policy.arithmeticToleranceMinor) {
      d.push({ code: "arithmetic_mismatch", severity: "review", message: `Subtotal + tax + freight is ${expectTotal / 100} but the total says ${fields.totalMinor / 100}.`, facts: { computedTotal: expectTotal / 100, total: fields.totalMinor / 100, difference: (fields.totalMinor - expectTotal) / 100 } });
    }
  }

  const vendor = resolveVendor(fields, input.vendors);
  if (!vendor) d.push({ code: "vendor_unknown", severity: "review", message: `Vendor "${fields.vendorName ?? ""}" is not in the vendor master.`, facts: { vendorName: fields.vendorName } });

  const po = selectPo(fields, vendor, input.purchaseOrders, policy);
  if (!po) {
    d.push({ code: "po_not_found", severity: "review", message: fields.poNumber ? `PO ${fields.poNumber} was not found.` : "No open purchase order matches this invoice.", facts: { poNumber: fields.poNumber } });
    return { vendorId: vendor?.vendorId ?? null, poNumber: null, matchType: "none", discrepancies: d, lineMatches: [], policyVersion: policy.version };
  }
  if (po.status !== "open") d.push({ code: "po_closed", severity: "review", message: `PO ${po.poNumber} is closed.`, facts: { poNumber: po.poNumber } });
  if (vendor && po.vendorId !== vendor.vendorId) {
    d.push({ code: "po_vendor_mismatch", severity: "review", message: `PO ${po.poNumber} belongs to a different vendor.`, facts: { poNumber: po.poNumber, poVendor: po.vendorId, invoiceVendor: vendor.vendorId } });
  }
  if (fields.currency && fields.currency !== po.currency) {
    d.push({ code: "currency_mismatch", severity: "review", message: `Invoice currency ${fields.currency} differs from PO currency ${po.currency}.`, facts: { invoiceCurrency: fields.currency, poCurrency: po.currency } });
  }

  const lines = pairLines(fields, po, policy);
  const received = new Map<number, number>();
  for (const gr of input.receipts.filter((r) => r.poNumber === po.poNumber)) {
    for (const l of gr.lines) received.set(l.poLineNo, (received.get(l.poLineNo) ?? 0) + l.quantityReceived);
  }
  const reserved = input.reservedByOthers ?? {};
  for (const lm of lines) {
    const line = fields.lines[lm.invoiceLine]!;
    if (lm.poLineNo === null) {
      d.push({ code: "line_unmatched", severity: "review", message: `Invoice line "${line.description}" has no matching PO line.`, facts: { description: line.description, amount: line.amountMinor / 100 }, lineIndex: lm.invoiceLine });
      continue;
    }
    const pl = po.lines.find((p) => p.lineNo === lm.poLineNo)!;
    const expected = lm.expectedAmountMinor!;
    const tol = Math.max(Math.round(Math.abs(expected) * policy.priceTolerancePct), policy.priceToleranceAbsMinor);
    if (line.amountMinor - expected > tol) {
      d.push({
        code: "price_over_tolerance", severity: "review",
        message: `Line "${line.description}" is billed at ${line.amountMinor / 100}; the PO price gives ${expected / 100} (tolerance ${tol / 100}).`,
        facts: { billed: line.amountMinor / 100, expected: expected / 100, overBy: (line.amountMinor - expected) / 100, tolerance: tol / 100, poUnitPrice: pl.unitPrice, quantity: lm.quantity },
        lineIndex: lm.invoiceLine,
      });
    }
    const qty = lm.quantity ?? pl.quantity;
    const other = reserved[`${po.poNumber}:${pl.lineNo}`] ?? 0;
    if (po.kind === "goods") {
      const rec = received.get(pl.lineNo) ?? 0;
      if (rec === 0) {
        d.push({ code: "receipt_missing", severity: "review", message: `No goods receipt recorded for PO line ${pl.lineNo} ("${pl.description}").`, facts: { poLine: pl.lineNo, billedQty: qty }, lineIndex: lm.invoiceLine });
      } else if (qty > rec - other + 1e-9) {
        d.push({ code: "qty_over_received", severity: "review", message: `Billed quantity ${qty} exceeds received quantity ${rec - other} for PO line ${pl.lineNo}.`, facts: { billedQty: qty, receivedQty: rec, available: rec - other, overBy: qty - (rec - other), reservedByOthers: other, poLine: pl.lineNo }, lineIndex: lm.invoiceLine });
      }
    }
  }

  if (po.taxRate !== null && fields.subtotalMinor !== null && fields.taxMinor !== null) {
    const expectedTax = Math.round(fields.subtotalMinor * po.taxRate);
    const tol = Math.max(Math.round(Math.abs(expectedTax) * policy.taxTolerancePct), policy.taxToleranceAbsMinor);
    if (Math.abs(fields.taxMinor - expectedTax) > tol) {
      d.push({ code: "tax_mismatch", severity: "review", message: `Tax is ${fields.taxMinor / 100}; the PO tax rate ${(po.taxRate * 100).toFixed(2)}% gives ${expectedTax / 100}.`, facts: { tax: fields.taxMinor / 100, expectedTax: expectedTax / 100, difference: (fields.taxMinor - expectedTax) / 100, taxRatePct: Number((po.taxRate * 100).toFixed(2)) } });
    }
  }
  if ((fields.freightMinor ?? 0) > po.freightAllowanceMinor + policy.freightToleranceMinor) {
    d.push({ code: "freight_over_allowance", severity: "review", message: `Freight ${fields.freightMinor! / 100} exceeds the PO allowance ${po.freightAllowanceMinor / 100}.`, facts: { freight: fields.freightMinor! / 100, allowance: po.freightAllowanceMinor / 100, overBy: (fields.freightMinor! - po.freightAllowanceMinor) / 100 } });
  }
  return { vendorId: vendor?.vendorId ?? null, poNumber: po.poNumber, matchType: po.kind === "goods" ? "3-way" : "2-way", discrepancies: d, lineMatches: lines, policyVersion: policy.version };
}
