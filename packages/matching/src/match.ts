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
  | "amount_over_cap"
  | "fx_rate_missing"
  | "fx_rate_unverified"
  | "fx_rate_mismatch";

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
  /** Stated document FX rate must be within this of the reference (treasury) rate. */
  fxTolerancePct: number;
  /** Converted line sum vs subtotal on dual-currency documents (per-line rounding on the document). */
  fxArithmeticTolerancePct: number;
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
  fxTolerancePct: 0.01,
  fxArithmeticTolerancePct: 0.005,
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
  /** Reference FX rates, key "USD/NAD" = NAD per 1 USD. Without one, a dual-currency invoice goes to a person. */
  fxRates?: Record<string, number>;
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

/**
 * Express the line amounts in `target` currency using only the rate printed on the document (either direction
 * between fxBase and the payable currency), or null if that is not possible.
 */
function linesIn(fields: InvoiceFields, target: string): InvoiceFields | null {
  const lineCcy = fields.lineCurrency ?? fields.currency ?? target;
  if (lineCcy === target) return fields;
  const rate = fields.exchangeRate;
  if (!rate || !fields.fxBase || !fields.currency) return null;
  let factor: number | null = null;
  if (lineCcy === fields.fxBase && target === fields.currency) factor = rate;
  else if (lineCcy === fields.currency && target === fields.fxBase) factor = 1 / rate;
  if (factor === null) return null;
  const f = factor;
  return { ...fields, lineCurrency: target, lines: fields.lines.map((l) => ({ ...l, unitPrice: l.unitPrice === null ? null : l.unitPrice * f, amountMinor: Math.round(l.amountMinor * f) })) };
}

export function threeWayMatch(input: MatchInput, policy: MatchPolicy = DEFAULT_MATCH_POLICY): MatchResult {
  const d: Discrepancy[] = [];
  const original = input.fields;
  const lineCcy = original.lineCurrency ?? original.currency;
  const otherCcy = original.fxBase ?? (lineCcy !== original.currency ? lineCcy : null);
  const dualCurrency = Boolean(original.currency && otherCcy && otherCcy !== original.currency);
  if (dualCurrency) {
    // General rule for dual-currency documents: normalise with the rate printed on the document, and only trust
    // that rate if it agrees with a reference rate; otherwise a person checks it. Never guess a rate.
    const pair = `${otherCcy}/${original.currency}`;
    const ref = input.fxRates?.[pair];
    if (!original.exchangeRate) {
      d.push({ code: "fx_rate_missing", severity: "review", message: `Lines are in ${otherCcy} but the amount payable is in ${original.currency}, and no exchange rate is printed.`, facts: { lineCurrency: otherCcy, currency: original.currency } });
    } else if (ref === undefined) {
      d.push({ code: "fx_rate_unverified", severity: "review", message: `The document's rate 1 ${otherCcy} = ${original.exchangeRate} ${original.currency} cannot be checked: no reference rate for ${pair}.`, facts: { pair, statedRate: original.exchangeRate } });
    } else if (Math.abs(original.exchangeRate / ref - 1) > policy.fxTolerancePct) {
      d.push({ code: "fx_rate_mismatch", severity: "review", message: `The document's rate 1 ${otherCcy} = ${original.exchangeRate} ${original.currency} differs from the reference rate ${ref} by more than ${policy.fxTolerancePct * 100}%.`, facts: { pair, statedRate: original.exchangeRate, referenceRate: ref, tolerancePct: policy.fxTolerancePct * 100 } });
    }
  }
  // From here on, arithmetic is checked in the payable currency.
  const fields = (original.currency ? linesIn(original, original.currency) : original) ?? { ...original, lines: [] };

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
    const tolerance = dualCurrency ? Math.max(policy.arithmeticToleranceMinor, Math.round(Math.abs(fields.subtotalMinor) * policy.fxArithmeticTolerancePct)) : policy.arithmeticToleranceMinor;
    // Lines may be printed tax-inclusive (common with VAT in ZA/NA): then they add up to subtotal + tax.
    const taxInclusive = fields.taxMinor !== null && fields.taxMinor !== 0 && Math.abs(lineSum - (fields.subtotalMinor + fields.taxMinor)) <= tolerance;
    if (Math.abs(lineSum - fields.subtotalMinor) > tolerance && !taxInclusive) {
      d.push({ code: "arithmetic_mismatch", severity: "review", message: `Line amounts add up to ${lineSum / 100} but the subtotal says ${fields.subtotalMinor / 100}.`, facts: { lineSum: lineSum / 100, subtotal: fields.subtotalMinor / 100, difference: (fields.subtotalMinor - lineSum) / 100 } });
    }
  }
  if (fields.totalMinor !== null && fields.subtotalMinor !== null) {
    const expectTotal = fields.subtotalMinor + (fields.taxMinor ?? 0) + (fields.freightMinor ?? 0);
    if (Math.abs(expectTotal - fields.totalMinor) > policy.arithmeticToleranceMinor) {
      d.push({ code: "arithmetic_mismatch", severity: "review", message: `Subtotal + tax + freight is ${expectTotal / 100} but the total says ${fields.totalMinor / 100}.`, facts: { computedTotal: expectTotal / 100, total: fields.totalMinor / 100, difference: (fields.totalMinor - expectTotal) / 100 } });
    }
  }

  const vendor = resolveVendor(original, input.vendors);
  if (!vendor) d.push({ code: "vendor_unknown", severity: "review", message: `Vendor "${fields.vendorName ?? ""}" is not in the vendor master.`, facts: { vendorName: fields.vendorName } });

  const po = selectPo(original, vendor, input.purchaseOrders, policy);
  if (!po) {
    d.push({ code: "po_not_found", severity: "review", message: fields.poNumber ? `PO ${fields.poNumber} was not found.` : "No open purchase order matches this invoice.", facts: { poNumber: fields.poNumber } });
    return { vendorId: vendor?.vendorId ?? null, poNumber: null, matchType: "none", discrepancies: d, lineMatches: [], policyVersion: policy.version };
  }
  if (po.status !== "open") d.push({ code: "po_closed", severity: "review", message: `PO ${po.poNumber} is closed.`, facts: { poNumber: po.poNumber } });
  if (vendor && po.vendorId !== vendor.vendorId) {
    d.push({ code: "po_vendor_mismatch", severity: "review", message: `PO ${po.poNumber} belongs to a different vendor.`, facts: { poNumber: po.poNumber, poVendor: po.vendorId, invoiceVendor: vendor.vendorId } });
  }
  // Compare lines with the PO in the PO's currency: either the document's line currency or (with a printed rate)
  // the payable currency. Anything else is a currency mismatch for a person.
  const inPo = original.currency || original.lineCurrency ? linesIn(original, po.currency) : original;
  if (!inPo) {
    d.push({ code: "currency_mismatch", severity: "review", message: `Invoice currency ${original.currency} differs from PO currency ${po.currency}.`, facts: { invoiceCurrency: original.currency, lineCurrency: original.lineCurrency ?? null, poCurrency: po.currency } });
  }
  const poFields = inPo ?? fields;
  const lines = pairLines(poFields, po, policy);
  const received = new Map<number, number>();
  for (const gr of input.receipts.filter((r) => r.poNumber === po.poNumber)) {
    for (const l of gr.lines) received.set(l.poLineNo, (received.get(l.poLineNo) ?? 0) + l.quantityReceived);
  }
  const reserved = input.reservedByOthers ?? {};
  for (const lm of lines) {
    const line = poFields.lines[lm.invoiceLine]!;
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
