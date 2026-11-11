// `make qbo-cleanup`: delete every Bill this project created in the sandbox (PrivateNote starts with "ipa-ref:" or
// "ipa-contract"), so a new live demo starts from a ledger without our earlier Bills. Sandbox only.
import { randomUUID } from "node:crypto";
import { liveClient } from "./live.ts";

const { qbo } = liveClient();
let start = 1;
const ours: { Id: string; SyncToken: string }[] = [];
while (true) {
  const page = await qbo.listBills(start, 100);
  for (const b of page) if ((b.PrivateNote ?? "").startsWith("ipa-ref:") || (b.PrivateNote ?? "").startsWith("ipa-contract")) ours.push(b);
  if (page.length < 100) break;
  start += 100;
}
let deleted = 0;
for (const b of ours) if (await qbo.deleteBill(b.Id, b.SyncToken, randomUUID())) deleted++;
console.log(`deleted ${deleted} of ${ours.length} project Bills from the sandbox`);
