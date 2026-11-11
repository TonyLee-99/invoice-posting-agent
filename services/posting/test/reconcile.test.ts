import { afterEach, describe, expect, it } from "vitest";
import type { Harness } from "../src/index.ts";
import { RecoveryDesk, checkInvariants, createHarness, drain, reconcile, seedApproved } from "../src/index.ts";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe("A13 nightly reconciliation (ledger is the system of record)", () => {
  it("detects deleted, changed and orphan Bills, queues them, and ends ledger == local after runbook resolution", async () => {
    h = await createHarness();
    const { ids, obligations } = await seedApproved(h, 4);
    await drain(h, [h.worker()]);
    const postings = (await h.db.query("select invoice_id, bill_id from postings order by invoice_id")).rows;
    const billOf = (i: number) => postings.find((p) => Number(p.invoice_id) === ids[i])!.bill_id as string;
    const job3 = (await h.db.query("select request_id, payload from outbox where invoice_id = $1", [ids[2]])).rows[0];

    h.emu.drift("delete", billOf(0)); // someone deleted it in QBO
    h.emu.drift("change_amount", billOf(1)); // someone edited the amount in QBO
    const orphan = h.emu.manualBill({ ...JSON.parse(job3.payload) }); // a second Bill carrying our marker = duplicate

    const rep = await reconcile(h.db, h.qbo, { pageSize: 2 });
    expect(rep).toMatchObject({ status: "complete", checked: 4, missing: 1, changed: 1, orphans: 1, reconciled: 2 });
    const open = (await h.db.query("select id, kind, detail->>'issue' as issue, bill_id from recovery_queue where resolved_at is null order by id")).rows;
    expect(open.map((r) => [r.kind, r.issue])).toEqual([["reconcile_mismatch", "missing_in_ledger"], ["reconcile_mismatch", "ledger_differs"], ["orphan_remote_bill", null]]);

    // Re-running is idempotent: no new items.
    await reconcile(h.db, h.qbo);
    expect((await h.db.query("select count(*)::int as n from recovery_queue where resolved_at is null")).rows[0].n).toBe(3);

    const desk = new RecoveryDesk(h.db, h.qbo);
    await desk.resolve(open[0].id, { action: "acknowledge_deleted", reason: "vendor cancelled; AP deleted in QBO" }, "controller");
    await desk.resolve(open[1].id, { action: "accept_ledger" }, "controller");
    await expect(desk.resolve(open[2].id, { action: "confirm_duplicate_voided" }, "controller")).rejects.toThrow(/still exists/);
    h.emu.drift("delete", orphan.Id); // the person voids the duplicate in QBO
    await desk.resolve(open[2].id, { action: "confirm_duplicate_voided" }, "controller");

    const rep2 = await reconcile(h.db, h.qbo);
    expect(rep2).toMatchObject({ missing: 0, changed: 0, orphans: 0 });
    obligations.delete(ids[0]!); // acknowledged as deleted: no longer an obligation
    obligations.set(ids[1]!, { totalMinor: 12_345 + 1000, invoiceNumber: "SIM-2" }); // ledger value accepted
    const inv = await checkInvariants(h, obligations);
    expect(inv.localWithoutLedger).toEqual([]);
    expect(inv.ledgerWithoutLocal).toEqual([]);
    expect(inv.lost).toEqual([]);
    expect((await h.svc.get(ids[1]!)).status).toBe("RECONCILED");
  });

  it("an unavailable ledger page makes the run partial; nothing is concluded from a failed read", async () => {
    h = await createHarness();
    await seedApproved(h, 3);
    await drain(h, [h.worker()]);
    h.emu.setFaults([{ op: "read", effect: "error500_before", nth: 2 }]);
    const rep = await reconcile(h.db, h.qbo);
    expect(rep.status).toBe("partial");
    expect((await h.db.query("select count(*)::int as n from recovery_queue")).rows[0].n).toBe(0);
  });
});
