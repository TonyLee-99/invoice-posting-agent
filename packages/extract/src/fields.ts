import type { InvoiceFields, LlmExtraction, ScalarField } from "@ipa/domain";
import { SCALAR_FIELDS, parseAmount, parseDate, toMinor } from "@ipa/domain";

/** Extraction -> canonical posting fields (integer minor units). Credit-note magnitudes stay positive. */
export function toFields(e: LlmExtraction): InvoiceFields {
  const cur = e.currency.value ?? "USD";
  const m = (v: number | null) => (v === null ? null : toMinor(Math.abs(v), cur));
  return {
    vendorName: e.vendor_name.value,
    vendorTaxId: e.vendor_tax_id.value,
    invoiceNumber: e.invoice_number.value,
    poNumber: e.po_number.value,
    invoiceDate: e.invoice_date.value,
    dueDate: e.due_date.value,
    currency: e.currency.value,
    documentType: e.document_type.value ?? "invoice",
    subtotalMinor: m(e.subtotal.value),
    taxMinor: m(e.tax.value),
    freightMinor: m(e.freight.value),
    totalMinor: m(e.total.value),
    lines: e.lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unit_price, amountMinor: toMinor(l.amount, cur) })),
  };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Is the value literally supported by the source text (after normalization)? */
export function grounded(field: ScalarField, value: unknown, text: string): boolean {
  if (value === null || value === undefined) return true; // "absent" claims are not checkable this way
  if (field === "document_type" || field === "currency") return true;
  if (typeof value === "number") {
    const target = Math.round(Math.abs(value) * 100);
    const found = text.match(/\d[\d ., ']*\d/g) ?? [];
    return found.some((t) => {
      const a = parseAmount(t);
      return a !== null && Math.round(Math.abs(a) * 100) === target;
    });
  }
  if (field === "invoice_date" || field === "due_date") {
    const tokens = text.match(/\d{1,4}[-/. ]\d{1,2}[-/. ]\d{2,4}|\d{1,2}\s+[A-Za-z]{3,9}\.?,?\s+\d{2,4}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{2,4}/g) ?? [];
    return tokens.some((t) => parseDate(t, false) === value || parseDate(t, true) === value);
  }
  return norm(text).includes(norm(String(value)));
}

/**
 * Routing confidence per field: the model's own number, discounted when the value is not grounded in the text
 * or the document's arithmetic does not close, and for OCR input. Reliability of this score is measured in
 * results/extraction.json (calibration table); it is a heuristic, not a fitted model.
 */
export function fieldConfidence(e: LlmExtraction, text: string, opts: { ocr: boolean }): Partial<Record<ScalarField, number>> {
  const sub = e.subtotal.value ?? 0;
  const lineSum = e.lines.reduce((s, l) => s + l.amount, 0);
  const totalOk = e.total.value !== null && Math.abs(sub + (e.tax.value ?? 0) + (e.freight.value ?? 0) - e.total.value) < 0.015;
  const linesOk = !e.lines.length || Math.abs(lineSum - sub) < 0.015;
  const out: Partial<Record<ScalarField, number>> = {};
  for (const f of SCALAR_FIELDS) {
    const v = e[f].value;
    let c = e[f].confidence;
    if (!grounded(f, v, text)) c *= 0.6;
    if (["subtotal", "tax", "total", "freight"].includes(f) && !(totalOk && linesOk)) c *= 0.7;
    if (opts.ocr) c *= 0.95;
    out[f] = Math.round(c * 1000) / 1000;
  }
  return out;
}
