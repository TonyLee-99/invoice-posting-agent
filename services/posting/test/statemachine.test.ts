import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Harness } from "../src/index.ts";
import { CONFIDENT, checkInvariants, createHarness, drain, reconcile, seedApproved, simInvoice } from "../src/index.ts";

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

describe("state machine + outbox", () => {
  it("happy path: ingest -> auto-approve -> post -> reconcile", async () => {
    const { ids, obligations } = await seedApproved(h, 3);
    const outbox = await h.db.query("select count(*)::int as n from outbox where status = 'pending'");
    expect(outbox.rows[0].n).toBe(3);
    const d = await drain(h, [h.worker()]);
    expect(d.quiescent).toBe(true);
    for (const id of ids) expect((await h.svc.get(id)).status).toBe("POSTED");
    const rep = await reconcile(h.db, h.qbo);
    expect(rep).toMatchObject({ status: "complete", reconciled: 3, missing: 0, changed: 0, orphans: 0 });
    for (const id of ids) expect((await h.svc.get(id)).status).toBe("RECONCILED");
    expect((await checkInvariants(h, obligations)).ok).toBe(true);
    const audit = await h.db.query("select action from audit_log where invoice_id = $1 order by id", [ids[0]]);
    expect(audit.rows.map((r) => r.action)).toEqual(["ingest", "match", "auto_approve", "approval_created", "posting_intent", "bill_created", "reconciled"]);
  });

  it("the database refuses illegal transitions", async () => {
    const { ids } = await seedApproved(h, 1);
    await expect(h.db.query("update invoices set status = 'POSTED' where id = $1", [ids[0]])).rejects.toThrow(/illegal invoice transition AUTO_APPROVED -> POSTED/);
  });

  it("a second copy of the same invoice is rejected as a duplicate", async () => {
    await seedApproved(h, 1, 500);
    const dup = await h.svc.ingest({ fields: simInvoice(500), confidence: CONFIDENT });
    expect(dup.status).toBe("REJECTED");
    expect((await h.svc.get(dup.id)).match?.discrepancies.map((d) => d.code)).toContain("duplicate_invoice");
  });

  it("low confidence routes to review; approval is bound to the content hash the reviewer saw", async () => {
    const r = await h.svc.ingest({ fields: simInvoice(600), confidence: { ...CONFIDENT, total: 0.4 } });
    expect(r.status).toBe("NEEDS_REVIEW");
    await expect(h.svc.approve(r.id, "alice", "stale-hash")).rejects.toThrow(/changed since it was displayed/);
    const inv = await h.svc.get(r.id);
    await h.svc.approve(r.id, "alice", inv.content_hash);
    expect((await h.svc.get(r.id)).status).toBe("APPROVED");
    await drain(h, [h.worker()]);
    expect((await h.svc.get(r.id)).status).toBe("POSTED");
  });

  it("at most one live outbox job per invoice", async () => {
    const { ids } = await seedApproved(h, 1, 700);
    // A second (valid) approval for the same invoice, so only the live-job index can reject the insert.
    await h.db.query("update approvals set voided_at = now() where invoice_id = $1", [ids[0]]);
    const ap = (await h.db.query("insert into approvals (invoice_id, approved_content_hash, approved_version, approver) values ($1, 'x', 1, 't') returning id", [ids[0]])).rows[0].id;
    await expect(
      h.db.query("insert into outbox (invoice_id, approval_id, idempotency_key, request_id, realm_id, doc_number, vendor_ref, payload, payload_hash, status) values ($1,$2,'k2','r2','x','d','v','{}','h','pending')", [ids[0], ap]),
    ).rejects.toThrow(/outbox_one_live_per_invoice/);
  });

  it("zero-decimal currencies are recorded in their own minor units (JPY)", async () => {
    await h.reset({ vendors: [{ id: "56", name: "Acme Industrial Supply LLC", currency: "USD" }, { id: "77", name: "Kyoto Parts KK", currency: "JPY" }] });
    await h.svc.upsertVendor({ vendorId: "V-JP", name: "Kyoto Parts KK", aliases: [], taxId: null, qboVendorId: "77", currency: "JPY" });
    await h.svc.upsertPo({ poNumber: "PO-JP-1", vendorId: "V-JP", currency: "JPY", kind: "services", status: "open", taxRate: null, freightAllowanceMinor: 0, lines: [{ lineNo: 1, description: "Machining service", quantity: 1, unitPrice: 50_000 }] });
    const fields = { ...simInvoice(800), vendorName: "Kyoto Parts KK", poNumber: "PO-JP-1", currency: "JPY", subtotalMinor: 45_000, totalMinor: 45_000, lines: [{ description: "Machining service", quantity: 1, unitPrice: 45_000, amountMinor: 45_000 }] };
    const r = await h.svc.ingest({ fields, confidence: CONFIDENT });
    expect(r.status).toBe("AUTO_APPROVED");
    await drain(h, [h.worker()]);
    const p = (await h.db.query("select total_minor, currency from postings where invoice_id = $1", [r.id])).rows[0];
    expect(p).toEqual({ total_minor: 45_000, currency: "JPY" });
    expect((await reconcile(h.db, h.qbo)).changed).toBe(0);
  });
});
