import type { LlmExtraction } from "@ipa/domain";
import { parseAmount, parseDate } from "@ipa/domain";

// Regex/heuristic baseline over the same parsed text the LLM sees. It is a fair, not a strawman, baseline:
// label-driven patterns of the kind a rules-based capture tool uses. Tuned only on the dev split.

const AMOUNT = /-?\(?(?:[A-Z]{3}|[$€£R])?\s?-?\d{1,3}(?:[ .,'’]\d{3})*(?:[.,]\d{2})\)?(?:\s?(?:CR|-))?/g;
const CODES = ["EUR", "GBP", "USD", "ZAR", "NAD", "ZMW", "CAD", "AUD", "CHF", "BWP", "KES"];

function amountsIn(line: string): number[] {
  return (line.match(AMOUNT) ?? []).map((m) => parseAmount(m)).filter((x): x is number => x !== null);
}

function lastAmountOn(lines: string[], label: RegExp, exclude?: RegExp): number | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (label.test(l) && !(exclude && exclude.test(l))) {
      const a = amountsIn(l.replace(/\d{1,2}(?:[.,]\d+)?\s?%/g, " "));
      if (a.length) return Math.abs(a[a.length - 1]!);
    }
  }
  return null;
}

const f = <T>(value: T | null, confidence = 0.5) => ({ value, confidence });

export function baselineExtract(text: string): LlmExtraction {
  const lines = text.split(/\n/).map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim());
  const joined = lines.join("\n");

  const num = joined.match(/(?:invoice|inv|tax invoice|credit note|bill)\s*(?:no\.?|number|num|nr|#)\s*[:.#]?\s*([A-Z0-9][A-Z0-9\-/]{2,})/i)
    ?? joined.match(/\b(?:invoice|inv)\s*[:#]\s*([A-Z0-9][A-Z0-9\-/]{2,})/i);
  const po = joined.match(/\b(?:p\.?o\.?|purchase order|order)\s*(?:no\.?|number|#)?\s*[:.#]?\s*([A-Z0-9][A-Z0-9\-/]{2,})/i);

  const monthFirst = /\$|USD|\bUS\b/.test(joined) && !/€|£|\bEUR\b|\bGBP\b|\bZAR\b/.test(joined);
  const dateNear = (label: RegExp): string | null => {
    for (const l of lines) {
      if (!label.test(l)) continue;
      const after = l.slice(l.search(label));
      const d = parseDate(after.replace(label, " "), monthFirst);
      if (d) return d;
    }
    return null;
  };
  const invoiceDate = dateNear(/(?:invoice date|date of issue|issue date|tax point|date issued|\bdate\b)\s*[:.]?/i);
  const dueDate = dateNear(/(?:due date|payment due|due by|due)\s*[:.]?/i);

  const codeCounts = CODES.map((c) => [c, (joined.match(new RegExp(`\\b${c}\\b`, "g")) ?? []).length] as const).sort((a, b) => b[1] - a[1]);
  let currency: string | null = codeCounts[0]![1] > 0 ? codeCounts[0]![0] : null;
  if (!currency) currency = /€/.test(joined) ? "EUR" : /£/.test(joined) ? "GBP" : /\bR\s?\d/.test(joined) ? "ZAR" : /\$/.test(joined) ? "USD" : null;

  const total = lastAmountOn(lines, /\b(grand total|total due|amount due|balance due|total payable|invoice total|total)\b/i, /sub\s*-?total|total (net|vat|tax)|net worth/i)
    ?? lastAmountOn(lines, /\btotal\b/i);
  const subtotal = lastAmountOn(lines, /\b(sub\s*-?total|net total|total net|net amount|net worth|total excl)/i);
  const tax = lastAmountOn(lines, /\b(vat|tax|gst|mwst|sales tax)\b/i, /tax id|vat (no|reg|number)|ust-id|\bid\b|tax invoice|incl/i);
  const freight = lastAmountOn(lines, /\b(shipping|freight|delivery|carriage)\b/i, /deliver to|delivery address|delivery note/i);

  // Vendor: text after a "Seller/From/Supplier" label, else the first line that is not a document title.
  let vendor: string | null = null;
  const sellerIdx = lines.findIndex((l) => /^\s*(seller|from|supplier|vendor)\s*:?/i.test(l));
  if (sellerIdx >= 0) {
    const sameLine = lines[sellerIdx]!.replace(/^\s*(seller|from|supplier|vendor)\s*:?\s*/i, "").split(/\s{3,}|client:|bill to/i)[0]!.trim();
    vendor = sameLine || (lines[sellerIdx + 1] ?? "").split(/\s{3,}/)[0]!.trim() || null;
  } else {
    const first = lines.find((l) => !/^(tax\s+)?invoice|credit note|statement|page \d/i.test(l.trim()));
    vendor = first ? first.replace(/^(tax\s+)?invoice\s*/i, "").split(/\s{3,}/).filter(Boolean).pop() ?? null : null;
  }
  const taxId = joined.match(/(?:tax\s*id|vat\s*(?:no|reg(?:istration)?\s*no|number)|ust-idnr)\s*[:.]?\s*([A-Z]{0,2}[\d][\d\- ]{5,})/i);

  // Line items: rows with a description followed by at least two numbers; amount = last non-percentage number,
  // or for "net / VAT% / gross" tables the number before the VAT percentage.
  const items: LlmExtraction["lines"] = [];
  for (const l of lines) {
    if (/\b(sub\s*-?total|total|vat|tax|balance|amount due|summary)\b/i.test(l)) continue;
    const m = l.match(/^\s*(?:\d{1,3}[.)]\s+)?([A-Za-z][^\d]*?.*?)\s{2,}(.+)$/);
    if (!m) continue;
    const nums = amountsIn(m[2]!);
    if (nums.length < 2) continue;
    const pct = m[2]!.search(/\d{1,2}\s?%/);
    let amount = nums[nums.length - 1]!;
    if (pct >= 0) {
      const before = amountsIn(m[2]!.slice(0, pct));
      if (before.length) amount = before[before.length - 1]!;
    }
    const qty = parseAmount((m[2]!.match(/^\s*(\d+(?:[.,]\d+)?)\b/) ?? [])[1] ?? null);
    items.push({ description: m[1]!.trim(), quantity: qty, unit_price: nums.length >= 3 ? nums[nums.length - 2]! : null, amount });
  }

  const docType = /credit\s*note|credit\s*memo/i.test(joined) ? "credit_note" : /\bstatement\b/i.test(joined) && !/invoice/i.test(joined) ? "other" : "invoice";
  return {
    vendor_name: f(vendor),
    vendor_tax_id: f(taxId ? taxId[1]!.trim() : null),
    invoice_number: f(num ? num[1]! : null),
    po_number: f(po ? po[1]! : null),
    invoice_date: f(invoiceDate),
    due_date: f(dueDate),
    currency: f(currency),
    subtotal: f(subtotal),
    tax: f(tax),
    freight: f(freight),
    total: f(total),
    document_type: f(docType as "invoice" | "credit_note" | "other"),
    lines: items,
    lines_confidence: 0.5,
    notes: null,
  };
}
