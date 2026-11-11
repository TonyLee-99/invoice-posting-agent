import { describe, expect, it } from "vitest";
import type { GoodsReceipt, InvoiceFields, PurchaseOrder, Vendor } from "@ipa/domain";
import { route, threeWayMatch } from "../src/index.ts";
import type { MatchInput } from "../src/index.ts";

const vendor: Vendor = { vendorId: "V1", name: "Nordhafen Workshop Supplies GmbH", aliases: [], taxId: null, qboVendorId: "56", currency: "EUR" };
const other: Vendor = { vendorId: "V2", name: "Pennine Tyre & Parts Limited", aliases: [], taxId: null, qboVendorId: "57", currency: "EUR" };

const fields = (over: Partial<InvoiceFields> = {}): InvoiceFields => ({
  vendorName: "Nordhafen Workshop Supplies GmbH & Co. KG", vendorTaxId: null, invoiceNumber: "IN0089266", poNumber: null,
  invoiceDate: "2026-04-30", dueDate: null, currency: "EUR", documentType: "invoice",
  subtotalMinor: 300000, taxMinor: 57000, freightMinor: null, totalMinor: 357000,
  lines: [
    { description: "Brake pads, trailer axle set", quantity: 10, unitPrice: 100, amountMinor: 100000 },
    { description: "Hydraulic hose 1/2in, per metre", quantity: 40, unitPrice: 50, amountMinor: 200000 },
  ],
  ...over,
});

const po = (over: Partial<PurchaseOrder> = {}): PurchaseOrder => ({
  poNumber: "PO-1", vendorId: "V1", currency: "EUR", kind: "goods", status: "open", taxRate: 0.19, freightAllowanceMinor: 0,
  lines: [
    { lineNo: 1, description: "Brake pads trailer axle set", quantity: 10, unitPrice: 100 },
    { lineNo: 2, description: "Hydraulic hose 1/2in per metre", quantity: 40, unitPrice: 50 },
  ],
  ...over,
});

const gr = (q1: number, q2: number, n = "GR-1"): GoodsReceipt => ({ grNumber: n, poNumber: "PO-1", receivedAt: "2026-04-20", lines: [{ poLineNo: 1, quantityReceived: q1 }, { poLineNo: 2, quantityReceived: q2 }] });

const input = (over: Partial<MatchInput> = {}): MatchInput => ({ fields: fields(), vendors: [vendor, other], purchaseOrders: [po()], receipts: [gr(10, 40)], ...over });
const codes = (i: MatchInput) => threeWayMatch(i).discrepancies.map((d) => d.code);
const conf = { vendor_name: 0.99, invoice_number: 0.99, invoice_date: 0.99, currency: 0.99, total: 0.99 };

describe("threeWayMatch", () => {
  it("clean 3-way match has no discrepancies and auto-approves with confident fields", () => {
    const m = threeWayMatch(input());
    expect(m.discrepancies).toEqual([]);
    expect(m.matchType).toBe("3-way");
    expect(route({ match: m, totalMinor: 357000, confidence: conf }).decision).toBe("AUTO_APPROVE");
  });
  it("price within tolerance passes; over tolerance is flagged", () => {
    expect(codes(input({ purchaseOrders: [po({ lines: [{ lineNo: 1, description: "Brake pads trailer axle set", quantity: 10, unitPrice: 99 }, po().lines[1]!] })] }))).toEqual([]);
    expect(codes(input({ purchaseOrders: [po({ lines: [{ lineNo: 1, description: "Brake pads trailer axle set", quantity: 10, unitPrice: 90 }, po().lines[1]!] })] }))).toEqual(["price_over_tolerance"]);
  });
  it("partial receipts are summed; short receipt is flagged", () => {
    expect(codes(input({ receipts: [gr(4, 40, "GR-1"), { ...gr(6, 0, "GR-2") }] }))).toEqual([]);
    expect(codes(input({ receipts: [gr(4, 40)] }))).toEqual(["qty_over_received"]);
    expect(codes(input({ receipts: [] }))).toEqual(["receipt_missing", "receipt_missing"]);
  });
  it("quantities reserved by other approved invoices are not available", () => {
    expect(codes(input({ reservedByOthers: { "PO-1:1": 5 } }))).toEqual(["qty_over_received"]);
  });
  it("tax, freight, currency and arithmetic checks", () => {
    expect(codes(input({ purchaseOrders: [po({ taxRate: 0.07 })] }))).toEqual(["tax_mismatch"]);
    expect(codes(input({ fields: fields({ freightMinor: 5000, totalMinor: 362000 }) }))).toEqual(["freight_over_allowance"]);
    expect(codes(input({ fields: fields({ freightMinor: 5000, totalMinor: 362000 }), purchaseOrders: [po({ freightAllowanceMinor: 5000 })] }))).toEqual([]);
    expect(codes(input({ purchaseOrders: [po({ currency: "USD" })] }))).toContain("currency_mismatch");
    expect(codes(input({ fields: fields({ totalMinor: 360000 }) }))).toEqual(["arithmetic_mismatch"]);
  });
  it("selects the right PO among the vendor's open POs without a printed PO number", () => {
    const distractor = po({ poNumber: "PO-0", lines: [{ lineNo: 1, description: "Angle grinder discs 115mm", quantity: 5, unitPrice: 20 }] });
    const m = threeWayMatch(input({ purchaseOrders: [distractor, po()] }));
    expect(m.poNumber).toBe("PO-1");
  });
  it("2-way match for services ignores receipts but checks ordered quantity", () => {
    const svc = po({ kind: "services" });
    expect(threeWayMatch(input({ purchaseOrders: [svc], receipts: [] })).discrepancies).toEqual([]);
    expect(threeWayMatch(input({ purchaseOrders: [svc], receipts: [] })).matchType).toBe("2-way");
  });
  it("unknown vendor / missing PO go to review; duplicates and credit notes are rejected", () => {
    expect(codes(input({ vendors: [other] }))).toEqual(["vendor_unknown", "po_not_found"]);
    const dup = threeWayMatch(input({ isDuplicate: true }));
    expect(route({ match: dup, totalMinor: 357000, confidence: conf }).decision).toBe("REJECT");
    const credit = threeWayMatch(input({ fields: fields({ documentType: "credit_note" }) }));
    expect(route({ match: credit, totalMinor: 357000, confidence: conf }).decision).toBe("REJECT");
  });
});

describe("route", () => {
  const m = () => threeWayMatch(input());
  it("low confidence, missing confidence and cap send to review", () => {
    expect(route({ match: m(), totalMinor: 357000, confidence: { ...conf, total: 0.5 } }).decision).toBe("NEEDS_REVIEW");
    expect(route({ match: m(), totalMinor: 357000, confidence: null }).decision).toBe("NEEDS_REVIEW");
    expect(route({ match: m(), totalMinor: 357000, confidence: conf }, { version: "t", minFieldConfidence: 0.9, autoApproveCapMinor: 1000, autoApproveEnabled: true }).decision).toBe("NEEDS_REVIEW");
  });
  it("kill switch disables all auto-approval", () => {
    expect(route({ match: m(), totalMinor: 357000, confidence: conf }, { version: "t", minFieldConfidence: 0.9, autoApproveCapMinor: 1e9, autoApproveEnabled: false }).decision).toBe("NEEDS_REVIEW");
  });
  it("human-verified fields skip confidence gating but not matching", () => {
    expect(route({ match: m(), totalMinor: 357000, confidence: null, humanVerified: true }).decision).toBe("AUTO_APPROVE");
  });
});

describe("dual-currency documents (lines in one currency, amount payable in another)", () => {
  // Lines and PO in USD; the vendor prints 1 USD = 18.392 NAD and asks for payment in NAD.
  const usdPo = po({ currency: "USD", taxRate: null, kind: "services", lines: [{ lineNo: 1, description: "Customs clearance fee", quantity: 1, unitPrice: 136.39 }, { lineNo: 2, description: "Documentation fee", quantity: 1, unitPrice: 26.02 }] });
  const dual = (over: Partial<InvoiceFields> = {}): InvoiceFields => fields({
    currency: "NAD", lineCurrency: "USD", fxBase: "USD", exchangeRate: 18.392, subtotalMinor: 298_700, taxMinor: 0, totalMinor: 298_700,
    lines: [{ description: "Customs clearance fee", quantity: 1, unitPrice: 136.39, amountMinor: 13_639 }, { description: "Documentation fee", quantity: 1, unitPrice: 26.02, amountMinor: 2_602 }],
    ...over,
  });
  const nadVendor = { ...vendor, currency: "NAD" };
  const run = (f: InvoiceFields, fxRates?: Record<string, number>) => threeWayMatch({ fields: f, vendors: [nadVendor], purchaseOrders: [usdPo], receipts: [], fxRates }).discrepancies.map((x) => x.code);

  it("converts with the printed rate and passes when a reference rate agrees", () => {
    expect(run(dual(), { "USD/NAD": 18.4 })).toEqual([]);
  });
  it("routes to a person when no reference rate exists or the printed rate is off by more than 1%", () => {
    expect(run(dual())).toEqual(["fx_rate_unverified"]);
    expect(run(dual(), { "USD/NAD": 17.5 })).toEqual(["fx_rate_mismatch"]);
  });
  it("routes to a person when the rate is not printed (never guesses)", () => {
    const codes = run(dual({ exchangeRate: null }), { "USD/NAD": 18.4 });
    expect(codes[0]).toBe("fx_rate_missing");
  });
  it("still catches a real price problem after conversion", () => {
    const cheaper = { ...usdPo, lines: [{ ...usdPo.lines[0]!, unitPrice: 120 }, usdPo.lines[1]!] };
    const m = threeWayMatch({ fields: dual(), vendors: [nadVendor], purchaseOrders: [cheaper], receipts: [], fxRates: { "USD/NAD": 18.4 } });
    expect(m.discrepancies.map((x) => x.code)).toEqual(["price_over_tolerance"]);
  });
  it("a PO raised in the payable currency is compared after converting the lines", () => {
    const nadPo = { ...usdPo, currency: "NAD", lines: usdPo.lines.map((l) => ({ ...l, unitPrice: Math.round(l.unitPrice * 18.392 * 100) / 100 })) };
    const m = threeWayMatch({ fields: dual(), vendors: [nadVendor], purchaseOrders: [nadPo], receipts: [], fxRates: { "USD/NAD": 18.392 } });
    expect(m.discrepancies).toEqual([]);
  });
  it("lines read from the payable-currency column are converted back to the PO currency", () => {
    const nadLines = dual({ lineCurrency: "NAD", lines: [{ description: "Customs clearance fee", quantity: 1, unitPrice: null, amountMinor: 250_848 }, { description: "Documentation fee", quantity: 1, unitPrice: null, amountMinor: 47_856 }] });
    expect(run(nadLines, { "USD/NAD": 18.4 })).toEqual([]);
  });
  it("an ordinary invoice in a third currency is still a currency mismatch", () => {
    expect(threeWayMatch({ fields: fields({ currency: "GBP" }), vendors: [vendor], purchaseOrders: [po()], receipts: [gr(10, 40)] }).discrepancies.map((x) => x.code)).toEqual(["currency_mismatch"]);
  });
});
