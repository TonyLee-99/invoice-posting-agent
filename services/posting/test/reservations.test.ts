import { afterEach, describe, expect, it } from "vitest";
import type { InvoiceFields } from "@ipa/domain";
import type { Harness } from "../src/index.ts";
import { CONFIDENT, SIM_VENDOR, createHarness } from "../src/index.ts";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const partial = (n: number, qty: number): InvoiceFields => ({
  vendorName: SIM_VENDOR.name, vendorTaxId: null, invoiceNumber: `PART-${n}`, poNumber: "PO-G-1", invoiceDate: "2026-11-02", dueDate: null,
  currency: "USD", documentType: "invoice", subtotalMinor: qty * 1000, taxMinor: 0, freightMinor: null, totalMinor: qty * 1000,
  lines: [{ description: "Steel bracket 40mm", quantity: qty, unitPrice: 10, amountMinor: qty * 1000 }],
});

describe("A17 PO-line quantity reservations", () => {
  it("two partial invoices for the same received quantity cannot both be approved, even concurrently", async () => {
    h = await createHarness();
    await h.svc.upsertPo({ poNumber: "PO-G-1", vendorId: SIM_VENDOR.vendorId, currency: "USD", kind: "goods", status: "open", taxRate: null, freightAllowanceMinor: 0, lines: [{ lineNo: 1, description: "Steel bracket 40mm", quantity: 100, unitPrice: 10 }] });
    await h.svc.addReceipt({ grNumber: "GR-G-1", poNumber: "PO-G-1", receivedAt: "2026-11-01", lines: [{ poLineNo: 1, quantityReceived: 60 }] });
    // Each invoice alone fits the 60 received; together (2 x 40 = 80) they do not.
    const results = await Promise.all([1, 2, 3, 4].map((n) => h.svc.ingest({ fields: partial(n, 40), confidence: CONFIDENT })));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === "AUTO_APPROVED")).toHaveLength(1);
    expect(statuses.filter((s) => s === "NEEDS_REVIEW")).toHaveLength(3);
    const reserved = (await h.db.query("select sum(quantity)::float8 as q from po_line_reservations where active")).rows[0].q;
    expect(reserved).toBe(40);
    // A reviewer cannot approve one of the others while the quantity is reserved.
    const waiting = results.find((r) => r.status === "NEEDS_REVIEW")!;
    const inv = await h.svc.get(waiting.id);
    await expect(h.svc.approve(waiting.id, "alice", inv.content_hash)).rejects.toThrow(/already reserved/);
    // A second receipt arrives; now the reviewer may approve.
    await h.svc.addReceipt({ grNumber: "GR-G-2", poNumber: "PO-G-1", receivedAt: "2026-11-03", lines: [{ poLineNo: 1, quantityReceived: 40 }] });
    await h.svc.approve(waiting.id, "alice", inv.content_hash);
    expect((await h.db.query("select sum(quantity)::float8 as q from po_line_reservations where active")).rows[0].q).toBe(80);
  });

  it("editing an approved invoice releases its reservation", async () => {
    h = await createHarness();
    await h.svc.upsertPo({ poNumber: "PO-G-1", vendorId: SIM_VENDOR.vendorId, currency: "USD", kind: "goods", status: "open", taxRate: null, freightAllowanceMinor: 0, lines: [{ lineNo: 1, description: "Steel bracket 40mm", quantity: 100, unitPrice: 10 }] });
    await h.svc.addReceipt({ grNumber: "GR-G-1", poNumber: "PO-G-1", receivedAt: "2026-11-01", lines: [{ poLineNo: 1, quantityReceived: 60 }] });
    const a = await h.svc.ingest({ fields: partial(1, 40), confidence: CONFIDENT });
    expect(a.status).toBe("AUTO_APPROVED");
    await h.svc.edit(a.id, "alice", { dueDate: "2026-12-30" });
    expect((await h.db.query("select coalesce(sum(quantity), 0)::float8 as q from po_line_reservations where active")).rows[0].q).toBe(0);
  });
});
