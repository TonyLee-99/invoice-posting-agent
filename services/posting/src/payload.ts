import type { InvoiceFields } from "@ipa/domain";
import { canonicalJson, fromMinor, sha256 } from "@ipa/domain";
import type { BillCreate, BillLine } from "@ipa/qbo";

export const MARKER_PREFIX = "ipa-ref:";

export interface AccountMap {
  expense: string;
  tax: string;
  freight: string;
  adjustment: string;
}

export const DEFAULT_ACCOUNTS: AccountMap = { expense: "7", tax: "8", freight: "9", adjustment: "10" };

/** QBO Bill DocNumber is limited to 21 characters; longer vendor numbers get a stable short form. */
export function docNumberFor(invoiceNumber: string): string {
  const clean = invoiceNumber.trim();
  if (clean.length <= 21) return clean;
  return `${clean.slice(0, 12)}~${sha256(clean).slice(0, 8)}`;
}

export function markerFor(requestId: string): string {
  return `${MARKER_PREFIX}${requestId}`;
}

const line = (amountMinor: number, currency: string, description: string, account: string): BillLine => ({
  Amount: fromMinor(amountMinor, currency),
  Description: description.slice(0, 4000),
  DetailType: "AccountBasedExpenseLineDetail",
  AccountBasedExpenseLineDetail: { AccountRef: { value: account } },
});

/**
 * Build the exact Bill payload stored in the outbox. Lines + tax + freight always sum to the approved total;
 * any gap (rounding, or a difference a person approved) becomes an explicit adjustment line.
 */
export function buildBill(fields: InvoiceFields, opts: { qboVendorId: string; requestId: string; accounts?: AccountMap }): { payload: string; docNumber: string; payloadHash: string; bill: BillCreate } {
  if (!fields.invoiceNumber || fields.totalMinor === null || !fields.currency) throw new Error("invoice number, total and currency are required to post");
  const acc = opts.accounts ?? DEFAULT_ACCOUNTS;
  const cur = fields.currency;
  // Dual-currency documents: the Bill is in the payable currency, so lines are converted with the printed rate
  // (the approved total stays authoritative; rounding differences go to the adjustment line below).
  if (fields.lineCurrency && fields.lineCurrency !== cur) {
    if (!fields.exchangeRate) throw new Error("dual-currency invoice without an exchange rate cannot be posted");
  }
  const rate = fields.lineCurrency && fields.lineCurrency !== cur ? fields.exchangeRate! : 1; // lines in fxBase -> payable
  const srcLines = fields.lines.map((l) => ({ ...l, amountMinor: Math.round(l.amountMinor * rate) }));
  const lines: BillLine[] = [];
  if (srcLines.length) {
    for (const l of srcLines) lines.push(line(l.amountMinor, cur, l.description, acc.expense));
  } else if (fields.subtotalMinor !== null) {
    lines.push(line(fields.subtotalMinor, cur, `Invoice ${fields.invoiceNumber}`, acc.expense));
  }
  if (fields.taxMinor) lines.push(line(fields.taxMinor, cur, "Tax", acc.tax));
  if (fields.freightMinor) lines.push(line(fields.freightMinor, cur, "Freight", acc.freight));
  const sumMinor = srcLines.length
    ? srcLines.reduce((s, l) => s + l.amountMinor, 0) + (fields.taxMinor ?? 0) + (fields.freightMinor ?? 0)
    : (fields.subtotalMinor ?? 0) + (fields.taxMinor ?? 0) + (fields.freightMinor ?? 0);
  const gap = fields.totalMinor - sumMinor;
  if (gap !== 0 || lines.length === 0) lines.push(line(gap === 0 ? fields.totalMinor : gap, cur, "Adjustment to approved invoice total", acc.adjustment));
  const docNumber = docNumberFor(fields.invoiceNumber);
  const bill: BillCreate = {
    VendorRef: { value: opts.qboVendorId },
    DocNumber: docNumber,
    ...(fields.invoiceDate ? { TxnDate: fields.invoiceDate } : {}),
    ...(fields.dueDate ? { DueDate: fields.dueDate } : {}),
    CurrencyRef: { value: cur },
    PrivateNote: `${markerFor(opts.requestId)} inv:${fields.invoiceNumber}`.slice(0, 4000),
    Line: lines,
  };
  const payload = canonicalJson(bill);
  return { payload, docNumber, payloadHash: sha256(payload), bill };
}
