import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const confidence = z.number().min(0).max(1);

/** One extracted scalar with the model's self-reported confidence. */
export const fieldOf = <T extends z.ZodTypeAny>(value: T) =>
  z.object({ value: value.nullable(), confidence });

export const ExtractedLine = z.object({
  description: z.string(),
  quantity: z.number().nullable(),
  unit_price: z.number().nullable(),
  amount: z.number(),
});

/** Shape the LLM must return. Amounts are major units as printed (credit notes may be negative). */
export const LlmExtraction = z.object({
  vendor_name: fieldOf(z.string()),
  vendor_tax_id: fieldOf(z.string()),
  invoice_number: fieldOf(z.string()),
  po_number: fieldOf(z.string()),
  invoice_date: fieldOf(isoDate),
  due_date: fieldOf(isoDate),
  currency: fieldOf(z.string().regex(/^[A-Z]{3}$/)),
  subtotal: fieldOf(z.number()),
  tax: fieldOf(z.number()),
  freight: fieldOf(z.number()),
  total: fieldOf(z.number()),
  document_type: fieldOf(z.enum(["invoice", "credit_note", "other"])),
  lines: z.array(ExtractedLine),
  lines_confidence: confidence,
  notes: z.string().nullable().optional(),
});
export type LlmExtraction = z.infer<typeof LlmExtraction>;

export const SCALAR_FIELDS = [
  "vendor_name",
  "vendor_tax_id",
  "invoice_number",
  "po_number",
  "invoice_date",
  "due_date",
  "currency",
  "subtotal",
  "tax",
  "freight",
  "total",
  "document_type",
] as const;
export type ScalarField = (typeof SCALAR_FIELDS)[number];

/** Fields that must be right for a Bill to be posted without a human looking at it. */
export const CRITICAL_FIELDS: readonly ScalarField[] = ["vendor_name", "invoice_number", "invoice_date", "currency", "total"];

/** Canonical, editable, posting-relevant invoice content. Its hash binds approvals. */
export const InvoiceLine = z.object({
  description: z.string(),
  quantity: z.number().nullable(),
  unitPrice: z.number().nullable(),
  amountMinor: z.number().int(),
});
export type InvoiceLine = z.infer<typeof InvoiceLine>;

export const InvoiceFields = z.object({
  vendorName: z.string().nullable(),
  vendorTaxId: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  poNumber: z.string().nullable(),
  invoiceDate: isoDate.nullable(),
  dueDate: isoDate.nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  documentType: z.enum(["invoice", "credit_note", "other"]),
  subtotalMinor: z.number().int().nullable(),
  taxMinor: z.number().int().nullable(),
  freightMinor: z.number().int().nullable(),
  totalMinor: z.number().int().nullable(),
  lines: z.array(InvoiceLine),
  /**
   * Dual-currency documents. `fxBase` + `exchangeRate`: the rate printed on the document (1 fxBase = exchangeRate x
   * currency, where `currency` is the payable currency). `lineCurrency`: the currency the line amounts are in (fxBase
   * or currency). Absent on ordinary invoices, so existing content hashes are unchanged.
   */
  lineCurrency: z.string().regex(/^[A-Z]{3}$/).nullable().optional(),
  fxBase: z.string().regex(/^[A-Z]{3}$/).nullable().optional(),
  exchangeRate: z.number().positive().nullable().optional(),
});
export type InvoiceFields = z.infer<typeof InvoiceFields>;

export const Vendor = z.object({
  vendorId: z.string(),
  name: z.string(),
  aliases: z.array(z.string()).default([]),
  taxId: z.string().nullable().default(null),
  qboVendorId: z.string(),
  currency: z.string(),
});
export type Vendor = z.infer<typeof Vendor>;

export const PoLine = z.object({
  lineNo: z.number().int(),
  description: z.string(),
  quantity: z.number(),
  unitPrice: z.number(),
});
export type PoLine = z.infer<typeof PoLine>;

export const PurchaseOrder = z.object({
  poNumber: z.string(),
  vendorId: z.string(),
  currency: z.string(),
  kind: z.enum(["goods", "services"]),
  status: z.enum(["open", "closed"]),
  taxRate: z.number().nullable(),
  freightAllowanceMinor: z.number().int(),
  lines: z.array(PoLine),
});
export type PurchaseOrder = z.infer<typeof PurchaseOrder>;

export const GoodsReceipt = z.object({
  grNumber: z.string(),
  poNumber: z.string(),
  receivedAt: isoDate,
  lines: z.array(z.object({ poLineNo: z.number().int(), quantityReceived: z.number() })),
});
export type GoodsReceipt = z.infer<typeof GoodsReceipt>;
