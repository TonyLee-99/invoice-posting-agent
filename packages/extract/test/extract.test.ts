import { describe, expect, it } from "vitest";
import type { LLMClient, LLMRequest, LLMResponse } from "@ipa/llm";
import { baselineExtract, fieldConfidence, grounded, llmExtract, toFields } from "../src/index.ts";

const TEXT = `TAX INVOICE          Nordhafen Workshop Supplies GmbH
Invoice Number:           IN0089266
Date:            30.04.2026
Description            Qty          Unit Price            Amount
Brake pads, trailer axle set            1           1.151,18            1.151,18
Subtotal            1.151,18 €
MwSt 19%            218,72 €
TOTAL            1.369,90 €`;

const f = (value: unknown, confidence = 0.95) => ({ value, confidence });
const GOOD = {
  vendor_name: f("Nordhafen Workshop Supplies GmbH"), vendor_tax_id: f(null), invoice_number: f("IN0089266"), po_number: f(null),
  invoice_date: f("2026-04-30"), due_date: f(null), currency: f("EUR"), subtotal: f(1151.18), tax: f(218.72), freight: f(null), total: f(1369.9),
  document_type: f("invoice"), lines: [{ description: "Brake pads, trailer axle set", quantity: 1, unit_price: 1151.18, amount: 1151.18 }], lines_confidence: 0.9, notes: null,
};

class Scripted implements LLMClient {
  readonly name = "scripted";
  calls: LLMRequest[] = [];
  constructor(private readonly replies: string[]) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.calls.push(req);
    return { text: this.replies.shift() ?? "", model: req.model, backend: "scripted", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, latencyMs: 0, cached: false, cacheKey: "" };
  }
}

describe("llmExtract", () => {
  it("validates with zod and repairs once", async () => {
    const llm = new Scripted(['{"vendor_name": "oops"}', "```json\n" + JSON.stringify(GOOD) + "\n```"]);
    const r = await llmExtract(llm, TEXT, "m");
    expect(r.ok).toBe(true);
    expect(r.repaired).toBe(true);
    expect(llm.calls[1]!.prompt).toContain("failed validation");
  });
  it("gives up after one repair (the invoice then goes to a person)", async () => {
    const r = await llmExtract(new Scripted(["no json", "still no json"]), TEXT, "m");
    expect(r.ok).toBe(false);
    expect(r.calls).toHaveLength(2);
  });
});

describe("fields and confidence", () => {
  it("converts to integer minor units", () => {
    const fields = toFields(GOOD as never);
    expect(fields.totalMinor).toBe(136990);
    expect(fields.lines[0]!.amountMinor).toBe(115118);
  });
  it("discounts values that are not grounded in the text", () => {
    expect(grounded("total", 1369.9, TEXT)).toBe(true);
    expect(grounded("total", 1396.9, TEXT)).toBe(false);
    expect(grounded("invoice_date", "2026-04-30", TEXT)).toBe(true);
    const c = fieldConfidence({ ...GOOD, invoice_number: f("IN0089299") } as never, TEXT, { ocr: false });
    expect(c.invoice_number).toBeLessThan(0.6);
    expect(c.total).toBeCloseTo(0.95, 2);
  });
});

describe("regex baseline", () => {
  it("reads the labelled header fields from the same text", () => {
    const b = baselineExtract(TEXT);
    expect(b.invoice_number.value).toBe("IN0089266");
    expect(b.invoice_date.value).toBe("2026-04-30");
    expect(b.total.value).toBe(1369.9);
    expect(b.currency.value).toBe("EUR");
  });
});
