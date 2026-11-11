import { describe, expect, it } from "vitest";
import { contentHash, normalizeInvoiceNumber, normalizeVendorName, parseAmount, parseDate, toMinor, vendorNamesMatch } from "../src/index.ts";
import type { InvoiceFields } from "../src/index.ts";

describe("money", () => {
  it.each([
    ["1,234.56", 1234.56], ["1.234,56", 1234.56], ["$ 889,20", 889.2], ["1 234,56", 1234.56], ["(12.00)", -12],
    ["R -45.10", -45.1], ["12.00 CR", -12], ["1,234", 1234], ["EUR 6.702,90", 6702.9], ["", null], ["abc", null],
  ])("parseAmount(%s) = %s", (raw, expected) => {
    expect(parseAmount(raw)).toBe(expected);
  });
  it("rounds to minor units without float noise", () => {
    expect(toMinor(1.005)).toBe(101);
    expect(toMinor(0.1 + 0.2)).toBe(30);
    expect(toMinor(-12.345)).toBe(-1235);
    expect(toMinor(100, "JPY")).toBe(100);
  });
});

describe("dates", () => {
  it.each([
    ["30.04.2026", false, "2026-04-30"], ["09/18/2015", true, "2015-09-18"], ["09/18/2015", false, "2015-09-18"],
    ["2026-04-30", false, "2026-04-30"], ["3 March 2026", false, "2026-03-03"], ["Mar 3, 2026", false, "2026-03-03"],
    ["31/02/2026", false, null],
  ])("parseDate(%s, monthFirst=%s) = %s", (raw, mf, expected) => {
    expect(parseDate(raw, mf)).toBe(expected);
  });
});

describe("normalization", () => {
  it("vendor names", () => {
    expect(normalizeVendorName("Nordhafen Workshop Supplies GmbH & Co. KG")).toBe("nordhafen workshop supplies");
    expect(vendorNamesMatch("Pennine Tyre & Parts Limited", "PENNINE TYRE AND PARTS LTD")).toBe(true);
    expect(vendorNamesMatch("Acme Corp", "Globex Corp")).toBe(false);
  });
  it("invoice numbers", () => {
    expect(normalizeInvoiceNumber("Invoice # IN-0042")).toBe("in0042");
    expect(normalizeInvoiceNumber("97159829")).toBe("97159829");
  });
});

describe("content hash", () => {
  const base: InvoiceFields = {
    vendorName: "A", vendorTaxId: null, invoiceNumber: "1", poNumber: null, invoiceDate: "2026-01-01", dueDate: null,
    currency: "USD", documentType: "invoice", subtotalMinor: 100, taxMinor: 0, freightMinor: null, totalMinor: 100,
    lines: [{ description: "x", quantity: 1, unitPrice: 1, amountMinor: 100 }],
  };
  it("is independent of key order and changes on any edit", () => {
    const reordered = JSON.parse(JSON.stringify({ lines: base.lines, ...base })) as InvoiceFields;
    expect(contentHash(reordered)).toBe(contentHash(base));
    expect(contentHash({ ...base, totalMinor: 101 })).not.toBe(contentHash(base));
  });
});
