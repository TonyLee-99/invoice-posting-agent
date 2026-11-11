// `make qbo-live-demo`: post ~10 Simulated invoices to the real QBO sandbox through the real pipeline (ingest ->
// match -> route -> outbox -> worker), kill a worker process mid-post (SIGKILL after the remote write, before the
// local commit), recover with a second worker, run reconciliation, and check: one Bill per DocNumber in the
// sandbox, ledger == local. Writes results/qbo_live_demo.json. Skips without credentials.
//   --n 10        number of invoices      --cleanup   delete the demo Bills from the sandbox afterwards
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { INTUIT } from "@ipa/qbo";
import { BASE_URL, CONFIDENT, OutboxWorker, PostingService, connect, migrate, reconcile } from "@ipa/posting";
import type { InvoiceFields } from "@ipa/domain";
import { RESULTS, ROOT, liveClient, redactRealm } from "./live.ts";

const args = process.argv.slice(2);
const N = Number(args.includes("--n") ? args[args.indexOf("--n") + 1] : "10");
const TIMEOUT_MS = Number(process.env.QBO_LIVE_TIMEOUT_MS ?? 4000);
const LEASE_MS = TIMEOUT_MS * 4;
const { qbo, realmId, tokenFile, clientId, clientSecret } = liveClient(TIMEOUT_MS);

const vendors = ((await qbo.rawQuery("select * from Vendor where Active = true MAXRESULTS 5")).Vendor ?? []) as { Id: string; DisplayName: string; CurrencyRef?: { value: string } }[];
const account = ((await qbo.rawQuery("select * from Account where AccountType = 'Expense' MAXRESULTS 1")).Account as { Id: string }[] | undefined)?.[0];
if (!vendors.length || !account) {
  console.log("ERROR: the sandbox company needs active Vendors and an Expense account.");
  process.exit(1);
}

// Fresh local database for the live run.
const DB = process.env.QBO_LIVE_DB ?? "ipa_live";
const admin = new pg.Client({ connectionString: BASE_URL });
await admin.connect();
await admin.query(`drop database if exists ${DB} with (force)`);
await admin.query(`create database ${DB}`);
await admin.end();
const url = BASE_URL.replace(/\/[^/]*$/, `/${DB}`);
const db = connect(url, 10);
await migrate(db);
const acct = account.Id;
const svc = new PostingService(db, { realmId, accounts: { expense: acct, tax: acct, freight: acct, adjustment: acct } });

// **Simulated** vendor master / POs mapped onto the sandbox's own vendors.
for (const v of vendors) {
  await svc.upsertVendor({ vendorId: `V-${v.Id}`, name: v.DisplayName, aliases: [], taxId: null, qboVendorId: v.Id, currency: v.CurrencyRef?.value ?? "USD" });
  await svc.upsertPo({ poNumber: `PO-LIVE-${v.Id}`, vendorId: `V-${v.Id}`, currency: v.CurrencyRef?.value ?? "USD", kind: "services", status: "open", taxRate: null, freightAllowanceMinor: 0, lines: [{ lineNo: 1, description: "Professional services", quantity: 1, unitPrice: 100_000 }] });
}
const stamp = Date.now().toString(36).toUpperCase().slice(-6);
const expected = new Map<number, { doc: string; totalMinor: number }>();
for (let i = 0; i < N; i++) {
  const v = vendors[i % vendors.length]!;
  const total = 10_000 + i * 1_337;
  const doc = `IPA-LD-${stamp}-${i + 1}`;
  const fields: InvoiceFields = {
    vendorName: v.DisplayName, vendorTaxId: null, invoiceNumber: doc, poNumber: `PO-LIVE-${v.Id}`, invoiceDate: new Date().toISOString().slice(0, 10), dueDate: null,
    currency: v.CurrencyRef?.value ?? "USD", documentType: "invoice", subtotalMinor: total, taxMinor: 0, freightMinor: null, totalMinor: total,
    lines: [{ description: "Professional services", quantity: 1, unitPrice: total / 100, amountMinor: total }],
  };
  const r = await svc.ingest({ fields, confidence: CONFIDENT, sourceName: `live-demo-${i + 1}` });
  if (r.status !== "AUTO_APPROVED") throw new Error(`invoice ${doc} routed to ${r.status}`);
  expected.set(r.id, { doc, totalMinor: total });
}

// Fault injection: a real worker process is SIGKILLed after its first remote write, before recording it.
const env = {
  ...process.env, DATABASE_URL: url, QBO_API_BASE: process.env.QBO_API_BASE ?? INTUIT.sandboxApi, QBO_TOKEN_URL: process.env.QBO_TOKEN_URL ?? INTUIT.tokenUrl, QBO_TOKEN_STORE: `file:${tokenFile}`, QBO_CLIENT_ID: clientId, QBO_CLIENT_SECRET: clientSecret,
  QBO_REALM_ID: realmId, QBO_TIMEOUT_MS: String(TIMEOUT_MS), WORKER_LEASE_MS: String(LEASE_MS), WORKER_ID: "victim", WORKER_PAUSE_AT: "after_remote_write",
};
const tsx = path.join(ROOT, "node_modules/.bin/tsx");
const victim = spawn(tsx, [path.join(ROOT, "services/posting/src/bin/worker.ts")], { env, stdio: ["ignore", "pipe", "ignore"] });
await new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("worker never reached the kill point")), 60_000);
  victim.stdout.on("data", (d: Buffer) => { if (d.toString().includes("PAUSED")) { clearTimeout(t); resolve(); } });
});
victim.kill("SIGKILL");
await new Promise((r) => victim.on("exit", r));
console.log("killed the worker process after its remote write; recovering with a new worker after the lease expires");

const worker = new OutboxWorker(db, qbo, { workerId: "rescuer", requestTimeoutMs: TIMEOUT_MS, leaseMs: LEASE_MS, backoffBaseMs: 500, backoffMaxMs: 5000 });
const t0 = Date.now();
while (Date.now() - t0 < 180_000) {
  await worker.tick();
  const open = (await db.query("select count(*)::int as n from outbox where status in ('pending','in_flight')")).rows[0].n as number;
  if (!open) break;
  await new Promise((r) => setTimeout(r, 1000));
}
const rep = await reconcile(db, qbo);

// Independent checks against the sandbox itself.
const perDoc: { doc: string; billsInSandbox: number; totalMatches: boolean }[] = [];
for (const [, e] of expected) {
  const bills = await qbo.queryBillsByDocNumber(e.doc);
  perDoc.push({ doc: e.doc, billsInSandbox: bills.length, totalMatches: bills.length === 1 && Math.round(bills[0]!.TotalAmt * 100) === e.totalMinor });
}
const posted = (await db.query("select count(*)::int as n, count(*) filter (where adopted)::int as adopted from postings")).rows[0];
const openRecovery = (await db.query("select kind, count(*)::int as n from recovery_queue where resolved_at is null group by kind")).rows;
const out = {
  generatedAt: new Date().toISOString(), environment: "sandbox", realm: redactRealm(realmId), invoices: N,
  fault: "worker process SIGKILLed after its first remote write, before the local commit",
  postedLocally: posted.n, adoptedAfterUncertainty: posted.adopted, duplicateDocNumbers: perDoc.filter((p) => p.billsInSandbox > 1).length,
  missingInSandbox: perDoc.filter((p) => p.billsInSandbox === 0).length, ledgerTotalsMatch: perDoc.every((p) => p.totalMatches),
  reconciliation: rep, openRecovery, perDoc,
};
mkdirSync(RESULTS, { recursive: true });
writeFileSync(path.join(RESULTS, "qbo_live_demo.json"), JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify({ posted: out.postedLocally, adopted: out.adoptedAfterUncertainty, duplicates: out.duplicateDocNumbers, missing: out.missingInSandbox, reconciliation: rep.status }));

if (args.includes("--cleanup")) {
  for (const p of perDoc) for (const b of await qbo.queryBillsByDocNumber(p.doc)) await qbo.deleteBill(b.Id, b.SyncToken, randomUUID());
  console.log("demo Bills deleted from the sandbox");
}
await db.end();
