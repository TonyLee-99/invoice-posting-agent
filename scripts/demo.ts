// End-to-end demo on the real pipeline: QBO emulator + Postgres + API + worker, documents from the eval sample.
//   tsx scripts/demo.ts --serve            seed, then serve the API on :4000 with a worker loop (UI: npm run dev -w @ipa/review)
//   tsx scripts/demo.ts --export           seed, then write the static demo data into apps/review/public/demo-data
//   --backend replay|claude-cli (default replay: cached LLM calls only; claude-cli records new ones)
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { Parser } from "@ipa/extract";
import { createClient } from "@ipa/llm";
import { QboClient, QboEmulator } from "@ipa/qbo";
import type { ProcCase } from "../eval/procure.ts";
import { BASE_URL, OutboxWorker, PgTokenStore, PostingService, RecoveryDesk, buildApi, connect, invoiceDetail, listInvoices, migrate, processDocument, reconcile, stats } from "@ipa/posting";

const ROOT = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const backend = (args.includes("--backend") ? args[args.indexOf("--backend") + 1] : "replay") as "replay" | "claude-cli";
const MODEL = "claude-haiku-5-5";
const DB_NAME = "ipa_demo";

const demo = JSON.parse(readFileSync(path.join(ROOT, "eval/data/demo_runs.json"), "utf8")) as { docId: string; file: string; mime: string; proc: ProcCase }[];

// Fresh database.
const admin = new pg.Client({ connectionString: BASE_URL });
await admin.connect();
await admin.query(`drop database if exists ${DB_NAME} with (force)`);
await admin.query(`create database ${DB_NAME}`);
await admin.end();
const url = BASE_URL.replace(/\/[^/]*$/, `/${DB_NAME}`);
const db = connect(url, 20);
await migrate(db);

// Emulator with the Simulated vendor master; persisted so a restart keeps the ledger.
mkdirSync(path.join(ROOT, "data/demo"), { recursive: true });
const snap = path.join(ROOT, "data/demo/emulator.json");
if (existsSync(snap)) rmSync(snap);
const vendors = demo.flatMap((d) => (d.proc.vendor ? [d.proc.vendor] : []));
const emu = new QboEmulator({ port: 4010, snapshotPath: snap, vendors: vendors.map((v) => ({ id: v.qboVendorId, name: v.name, currency: v.currency })) });
const emuUrl = await emu.start();
const store = new PgTokenStore(db);
const t = emu.issueTokens();
await store.swap({ accessToken: t.accessToken, refreshToken: t.refreshToken, accessExpiresAt: Date.now() + 3_600_000, refreshExpiresAt: Date.now() + 8e9, realmId: emu.realmId }, 0);
const qbo = new QboClient({ apiBaseUrl: emuUrl, authorizeUrl: `${emuUrl}/connect/oauth2`, tokenUrl: `${emuUrl}/oauth2/v1/tokens/bearer`, clientId: emu.clientId, clientSecret: emu.clientSecret, redirectUri: "http://localhost:4000/oauth/callback", realmId: emu.realmId, timeoutMs: 1500 }, store);
const svc = new PostingService(db, { realmId: emu.realmId });

for (const d of demo) {
  if (d.proc.vendor) await svc.upsertVendor(d.proc.vendor);
}
for (const d of demo) {
  for (const po of d.proc.pos) if (d.proc.vendor || po.vendorId) await svc.upsertPo(po).catch(() => undefined);
  for (const gr of d.proc.receipts) await svc.addReceipt(gr);
}

const llm = createClient(backend, { callLog: backend === "replay" ? undefined : path.join(ROOT, "results/llm_calls.jsonl") });
const parser = new Parser({ cacheDir: path.join(ROOT, "cache/replay/parse"), tessdataDir: path.join(ROOT, "data/tessdata"), offline: backend === "replay" });
const deps = { svc, parser, llm, model: MODEL };
const byName = new Map<string, string>();
const log = (s: string) => process.stderr.write(`${s}\n`);

// The first timeout-after-commit exercises query-before-retry adoption in the demo data.
emu.setFaults([{ op: "create", effect: "hang_after_commit", nth: 2 }]);
let dupSource: (typeof demo)[number] | null = null;
for (const d of demo) {
  const name = path.basename(d.file);
  byName.set(name, path.join(ROOT, d.file));
  const r = await processDocument(deps, path.join(ROOT, d.file), d.mime, name);
  if (d.proc.scenario === "duplicate") dupSource = d;
  log(`${d.docId} -> ${r.status}`);
}
// Re-upload one invoice: the duplicate guard rejects the second copy.
if (dupSource) {
  const name = `resubmitted-${path.basename(dupSource.file)}`;
  byName.set(name, path.join(ROOT, dupSource.file));
  log(`resubmit -> ${(await processDocument(deps, path.join(ROOT, dupSource.file), dupSource.mime, name)).status}`);
}

const worker = new OutboxWorker(db, qbo, { requestTimeoutMs: 1500, workerId: "worker-1" });
async function drainAll() {
  for (let i = 0; i < 60; i++) {
    await worker.tick();
    const open = (await db.query("select count(*)::int as n from outbox where status in ('pending','in_flight') and available_at < now() + interval '10 seconds'")).rows[0].n;
    if (!open) return;
    await new Promise((r) => setTimeout(r, 300));
  }
}
await drainAll();

// A clerk entered one Bill by hand in QBO before the integration got to it -> never adopted, sent to recovery.
const review = (await db.query("select id, content_hash, fields from invoices where status = 'NEEDS_REVIEW' order by id")).rows;
if (review[0]) {
  const f = review[0].fields;
  const v = (await db.query("select qbo_vendor_id from vendors where vendor_id = (select vendor_id from invoices where id = $1)", [review[0].id])).rows[0];
  if (v && f.invoiceNumber) {
    emu.manualBill({ VendorRef: { value: v.qbo_vendor_id }, DocNumber: f.invoiceNumber.slice(0, 21), TxnDate: f.invoiceDate ?? undefined, CurrencyRef: { value: f.currency ?? "USD" }, Line: [{ Amount: (f.totalMinor ?? 0) / 100, DetailType: "AccountBasedExpenseLineDetail", AccountBasedExpenseLineDetail: { AccountRef: { value: "7" } } }] });
    await svc.approve(review[0].id, "maria.ap", review[0].content_hash).catch((e) => log(`approve: ${e.message}`));
  }
}
// A reviewer approves one held invoice as-is, and corrects another (the edit voids nothing yet; it needs approval).
if (review[1]) await svc.approve(review[1].id, "maria.ap", review[1].content_hash).catch((e) => log(`approve: ${e.message}`));
if (review[2]) await svc.edit(review[2].id, "maria.ap", { dueDate: "2026-12-31" }).catch((e) => log(`edit: ${e.message}`));
await drainAll();

// Someone changes a posted Bill's amount in QBO; nightly reconciliation finds it (system of record wins).
const posted = (await db.query("select bill_id from postings order by invoice_id limit 1 offset 1")).rows[0];
if (posted) emu.drift("change_amount", posted.bill_id);
const rep = await reconcile(db, qbo);
log(`reconcile: ${JSON.stringify(rep)}`);
// The controller resolves the drift by accepting the ledger value (RUNBOOK §4).
const drift = (await new RecoveryDesk(db, qbo).open()).find((x) => x.kind === "reconcile_mismatch");
if (drift) await new RecoveryDesk(db, qbo).resolve(drift.id, { action: "accept_ledger" }, "controller").catch((e) => log(`resolve: ${e.message}`));

const s = await stats(db);
log(`stats: ${JSON.stringify(s)}`);
await parser.close();

if (args.includes("--export")) {
  const out = path.join(ROOT, "apps/review/public/demo-data");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const rows = await listInvoices(db);
  writeFileSync(path.join(out, "invoices.json"), JSON.stringify(rows));
  writeFileSync(path.join(out, "stats.json"), JSON.stringify(s));
  writeFileSync(path.join(out, "audit.json"), JSON.stringify((await db.query("select a.*, i.fields->>'invoiceNumber' as invoice_number from audit_log a left join invoices i on i.id = a.invoice_id order by a.id desc")).rows));
  for (const r of rows) {
    writeFileSync(path.join(out, `invoice-${r.id}.json`), JSON.stringify(await invoiceDetail(db, r.id)));
    const file = byName.get(r.source_name);
    if (file) copyFileSync(file, path.join(out, `doc-${r.id}`));
  }
  writeFileSync(path.join(ROOT, "results/demo_run.json"), JSON.stringify({ invoices: rows.length, stats: s, reconciliation: rep, backend, model: MODEL }, null, 1) + "\n");
  log(`exported ${rows.length} invoices to ${out}`);
  await emu.stop();
  await db.end();
} else if (args.includes("--serve")) {
  const app = buildApi({ db, svc, qbo, pipeline: deps, resolveDocument: (n) => byName.get(n) ?? null });
  await app.listen({ port: 4000, host: "127.0.0.1" });
  log("API on http://127.0.0.1:4000 (worker loop running)");
  setInterval(() => void worker.tick().catch((e) => log(`worker: ${e.message}`)), 1000);
} else {
  await emu.stop();
  await db.end();
}
