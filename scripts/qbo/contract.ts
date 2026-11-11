// `make qbo-contract`: check the QBO behaviors the posting protocol relies on (docs/QBO_SEMANTICS.md) against the
// real sandbox, and write results/qbo_live_contract.json. Creates a handful of clearly marked test Bills
// (DocNumber "IPA-CT-…", PrivateNote "ipa-contract") and deletes them at the end. Skips without credentials.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Bill, BillCreate } from "@ipa/qbo";
import { FileTokenStore } from "@ipa/qbo";
import { RESULTS, liveClient, redactRealm } from "./live.ts";

const { qbo, realmId, tokenFile } = liveClient();
const stamp = Date.now().toString(36).toUpperCase();
const created: Bill[] = [];
const checks: Record<string, unknown> = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const vendor = ((await qbo.rawQuery("select * from Vendor where Active = true MAXRESULTS 1")).Vendor as { Id: string; DisplayName: string }[] | undefined)?.[0];
const account = ((await qbo.rawQuery("select * from Account where AccountType = 'Expense' MAXRESULTS 1")).Account as { Id: string; Name: string }[] | undefined)?.[0];
if (!vendor || !account) {
  console.log("ERROR: the sandbox company needs at least one active Vendor and one Expense account (default sandbox companies have both).");
  process.exit(1);
}
const bill = (doc: string, amount: number): BillCreate => ({
  VendorRef: { value: vendor.Id }, DocNumber: doc, TxnDate: new Date().toISOString().slice(0, 10), PrivateNote: "ipa-contract",
  Line: [{ Amount: amount, Description: "contract check", DetailType: "AccountBasedExpenseLineDetail", AccountBasedExpenseLineDetail: { AccountRef: { value: account.Id } } }],
});
const keep = (r: Awaited<ReturnType<typeof qbo.createBill>>) => {
  if (r.kind === "created" && !created.some((b) => b.Id === r.bill.Id)) created.push(r.bill);
  return r;
};

// 1. Repeat requestid: same request twice -> same Bill Id, one Bill (QBO_SEMANTICS row 1).
{
  const rid = randomUUID();
  const doc = `IPA-CT-${stamp}-1`;
  const a = keep(await qbo.createBill(bill(doc, 11.11), rid));
  const b = keep(await qbo.createBill(bill(doc, 11.11), rid));
  await sleep(2000);
  const found = await qbo.queryBillsByDocNumber(doc);
  checks.repeat_requestid = { first: a.kind, second: b.kind, sameId: a.kind === "created" && b.kind === "created" && a.bill.Id === b.bill.Id, billsWithDocNumber: found.length, pass: found.length === 1 };
}
// 2. Same requestid, different body: does QBO return the original response (row 1 detail)?
{
  const rid = randomUUID();
  const doc = `IPA-CT-${stamp}-2`;
  const a = keep(await qbo.createBill(bill(doc, 22.22), rid));
  const b = keep(await qbo.createBill(bill(doc, 99.99), rid));
  checks.requestid_different_body = { first: a.kind, second: b.kind, secondReturnedOriginal: a.kind === "created" && b.kind === "created" && a.bill.Id === b.bill.Id && b.bill.TotalAmt === 22.22, observedOnly: true };
}
// 3. Concurrent same requestid (row 6, undocumented): two simultaneous requests.
{
  const rid = randomUUID();
  const doc = `IPA-CT-${stamp}-3`;
  const [a, b] = await Promise.all([qbo.createBill(bill(doc, 33.33), rid), qbo.createBill(bill(doc, 33.33), rid)]);
  keep(a);
  keep(b);
  await sleep(2000);
  const found = await qbo.queryBillsByDocNumber(doc);
  for (const f of found) if (!created.some((c) => c.Id === f.Id)) created.push(f);
  checks.concurrent_same_requestid = { results: [a.kind, b.kind], billsWithDocNumber: found.length, dedupedWhileInFlight: found.length === 1, observedOnly: true };
}
// 4. DocNumber query freshness after create (row 9): poll until visible.
{
  const doc = `IPA-CT-${stamp}-4`;
  const r = keep(await qbo.createBill(bill(doc, 44.44), randomUUID()));
  const t0 = Date.now();
  let visibleAfterMs: number | null = null;
  for (const wait of [0, 100, 250, 500, 1000, 2000, 4000, 8000]) {
    await sleep(wait);
    if ((await qbo.queryBillsByDocNumber(doc)).length) {
      visibleAfterMs = Date.now() - t0;
      break;
    }
  }
  checks.docnumber_query_freshness = { created: r.kind, visibleAfterMs, pass: visibleAfterMs !== null };
}
// 5. Duplicate DocNumber with a different requestid (row 8): accepted or rejected?
{
  const doc = `IPA-CT-${stamp}-1`;
  const r = keep(await qbo.createBill(bill(doc, 11.11), randomUUID()));
  checks.duplicate_docnumber_new_requestid = { result: r.kind, acceptedDuplicate: r.kind === "created", observedOnly: true };
}
// 6. Token refresh rotation (row 11): force a refresh; the new access token must work; record whether the refresh token changed.
{
  const store = new FileTokenStore(tokenFile);
  const before = (await store.load())!;
  await qbo.refresh((await qbo.currentAccessToken())!);
  const after = (await store.load())!;
  const works = (await qbo.rawQuery("select count(*) from Bill")).totalCount !== undefined;
  checks.token_refresh_rotation = { refreshed: after.version === before.version + 1, refreshTokenChanged: after.tokens.refreshToken !== before.tokens.refreshToken, newAccessTokenWorks: works, pass: after.version === before.version + 1 && works };
}

// Clean up the contract Bills (sandbox only).
let deleted = 0;
for (const b of created) {
  const fresh = await qbo.getBill(b.Id);
  if (fresh && (await qbo.deleteBill(fresh.Id, fresh.SyncToken, randomUUID()))) deleted++;
}
const out = { generatedAt: new Date().toISOString(), environment: "sandbox", realm: redactRealm(realmId), minorVersion: 75, checks, billsCreated: created.length, billsDeleted: deleted };
mkdirSync(RESULTS, { recursive: true });
writeFileSync(path.join(RESULTS, "qbo_live_contract.json"), JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify(checks, null, 1));
