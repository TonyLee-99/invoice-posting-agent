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
