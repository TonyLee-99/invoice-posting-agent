// Shared setup for fault tests and the chaos runner: a scratch database, a QBO emulator, a client, a service,
// Simulated reference data, and invariant checks computed from independent sources (the harness's own
// obligation list and the emulator's append-only creation log), not from the service's status columns.
import type { InvoiceFields } from "@ipa/domain";
import { QboClient, QboEmulator } from "@ipa/qbo";
import type { EmulatorOptions } from "@ipa/qbo";
import type { Db } from "./db.ts";
import { createScratchDb } from "./db.ts";
import { PostingService } from "./service.ts";
import { PgTokenStore } from "./tokens.ts";
import type { WorkerOptions } from "./worker.ts";
import { OutboxWorker } from "./worker.ts";
import { MARKER_PREFIX } from "./payload.ts";

export interface Harness {
  db: Db;
  emu: QboEmulator;
  qbo: QboClient;
  svc: PostingService;
  requestTimeoutMs: number;
  newClient(): QboClient;
  worker(opts?: WorkerOptions): OutboxWorker;
  restartEmulator(opts?: Partial<EmulatorOptions>): Promise<void>;
  /** Fresh emulator + empty service tables, same database (chaos runs many seeds per database). */
  reset(opts: EmulatorOptions): Promise<void>;
  close(): Promise<void>;
}

export const SIM_VENDOR = { vendorId: "V-ACME", name: "Acme Industrial Supply LLC", aliases: [], taxId: null, qboVendorId: "56", currency: "USD" };

export async function createHarness(opts: { emulator?: EmulatorOptions; requestTimeoutMs?: number; dbPrefix?: string } = {}): Promise<Harness> {
  const scratch = await createScratchDb(opts.dbPrefix ?? "ipa_test");
  const db = scratch.db;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 150;
  const emuOpts: EmulatorOptions = { vendors: [{ id: "56", name: SIM_VENDOR.name, currency: "USD" }], ...opts.emulator };
  let emuOpts2 = emuOpts;
  let emu = new QboEmulator(emuOpts);
  let url = await emu.start();
  const store = new PgTokenStore(db);
  const t = emu.issueTokens();
  await store.swap({ accessToken: t.accessToken, refreshToken: t.refreshToken, accessExpiresAt: Date.now() + 3_600_000, refreshExpiresAt: Date.now() + 8e9, realmId: emu.realmId }, 0);
  const mkClient = () =>
    new QboClient({ apiBaseUrl: url, authorizeUrl: `${url}/connect/oauth2`, tokenUrl: `${url}/oauth2/v1/tokens/bearer`, clientId: emu.clientId, clientSecret: emu.clientSecret, redirectUri: "http://localhost/cb", realmId: emu.realmId, timeoutMs: requestTimeoutMs }, store);
  const svc = new PostingService(db, { realmId: emu.realmId });
  await svc.upsertVendor(SIM_VENDOR);
  await svc.upsertPo({ poNumber: "PO-SIM-1", vendorId: SIM_VENDOR.vendorId, currency: "USD", kind: "services", status: "open", taxRate: null, freightAllowanceMinor: 0, lines: [{ lineNo: 1, description: "Maintenance service", quantity: 1_000_000, unitPrice: 1 }] });
  const h: Harness = {
    db,
    emu,
    qbo: mkClient(),
    svc,
    requestTimeoutMs,
    newClient: mkClient,
    worker: (o: WorkerOptions = {}) => new OutboxWorker(db, mkClient(), { requestTimeoutMs, leaseMs: requestTimeoutMs * 4, backoffBaseMs: 20, backoffMaxMs: 200, ...o }),
    restartEmulator: async (more: Partial<EmulatorOptions> = {}) => {
      // Same port so existing clients keep working; state comes back from the snapshot file.
      const port = Number(new URL(url).port);
      await emu.stop();
      emu = new QboEmulator({ ...emuOpts2, ...more, port });
      url = await emu.start();
      h.emu = emu;
    },
    reset: async (o: EmulatorOptions) => {
      await emu.stop();
      await db.query(`truncate invoices, approvals, po_line_reservations, outbox, post_attempts, postings, recovery_queue, audit_log, reconciliation_runs, qbo_tokens restart identity cascade`);
      emuOpts2 = { vendors: [{ id: "56", name: SIM_VENDOR.name, currency: "USD" }], ...o };
      emu = new QboEmulator(emuOpts2);
      url = await emu.start();
      h.emu = emu;
      const tk = emu.issueTokens();
      await store.swap({ accessToken: tk.accessToken, refreshToken: tk.refreshToken, accessExpiresAt: Date.now() + 3_600_000, refreshExpiresAt: Date.now() + 8e9, realmId: emu.realmId }, 0);
      h.qbo = mkClient();
      await db.query("delete from purchase_orders where po_number <> 'PO-SIM-1'");
    },
    close: async () => {
      await emu.stop();
      await scratch.drop();
    },
  };
  return h;
}

let counter = 0;
/** A clean, auto-approvable Simulated invoice against PO-SIM-1 (2-way services match). */
export function simInvoice(n?: number, amountMinor = 12_345): InvoiceFields {
  const k = n ?? ++counter;
  return {
    vendorName: SIM_VENDOR.name, vendorTaxId: null, invoiceNumber: `SIM-${k}`, poNumber: "PO-SIM-1", invoiceDate: "2026-11-01", dueDate: "2026-12-01",
    currency: "USD", documentType: "invoice", subtotalMinor: amountMinor, taxMinor: 0, freightMinor: null, totalMinor: amountMinor,
    lines: [{ description: "Maintenance service", quantity: amountMinor / 100, unitPrice: 1, amountMinor }],
  };
}

export const CONFIDENT = { vendor_name: 0.99, invoice_number: 0.99, invoice_date: 0.99, currency: 0.99, total: 0.99 };

export type Obligations = Map<number, { totalMinor: number; invoiceNumber: string }>;

/** Ingest n invoices that auto-approve. Returns ids and the harness's own record of what was approved. */
export async function seedApproved(h: Harness, n: number, start = 1, obligations: Obligations = new Map()): Promise<{ ids: number[]; obligations: Obligations }> {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const f = simInvoice(start + i);
    const r = await h.svc.ingest({ fields: f, confidence: CONFIDENT });
    if (r.status !== "AUTO_APPROVED") throw new Error(`seed invoice routed to ${r.status}`);
    ids.push(r.id);
    obligations.set(r.id, { totalMinor: f.totalMinor!, invoiceNumber: f.invoiceNumber! });
  }
  return { ids, obligations };
}

/** Run workers until no job is due or leased, or until maxMs. Crashed workers (SimulatedCrash) are replaced. */
export async function drain(h: Harness, workers: OutboxWorker[], opts: { maxMs?: number; replace?: () => OutboxWorker; onCrash?: (e: unknown) => void } = {}): Promise<{ ms: number; crashes: number; quiescent: boolean }> {
  const t0 = Date.now();
  let crashes = 0;
  const live = [...workers];
  while (Date.now() - t0 < (opts.maxMs ?? 20_000)) {
    const res = await Promise.allSettled(live.map((w) => w.tick()));
    res.forEach((r, i) => {
      if (r.status === "rejected") {
        crashes++;
        opts.onCrash?.(r.reason);
        // The process "died": its connection state is gone; a fresh worker takes its place.
        live[i] = opts.replace ? opts.replace() : h.worker();
      }
    });
    const open = (await h.db.query("select count(*)::int as n, min(extract(epoch from (coalesce(lease_until, available_at) - now())) * 1000)::int as wait from outbox where status in ('pending', 'in_flight')")).rows[0];
    if (open.n === 0) return { ms: Date.now() - t0, crashes, quiescent: true };
    await new Promise((r) => setTimeout(r, Math.max(5, Math.min(50, open.wait ?? 10))));
  }
  return { ms: Date.now() - t0, crashes, quiescent: false };
}

export interface InvariantReport {
  /** I1: at most one ledger Bill per (vendor, DocNumber) ever created by us — checked on the append-only log. */
  duplicateCreations: { docNumber: string; count: number }[];
  /** I2: obligations neither posted nor in an open recovery item. */
  lost: number[];
  /** Obligations parked in recovery (allowed, reported). */
  inRecovery: number[];
  /** I3: local live postings without an equal ledger Bill, and our ledger Bills without a local posting. */
  localWithoutLedger: number[];
  ledgerWithoutLocal: string[];
  /** I4: posted Bill content differs from the approved content (reconstructed from ledger fields). */
  staleContent: number[];
  ok: boolean;
}

/**
 * Check invariants against independent evidence. `obligations` maps invoice id -> the content the harness
 * itself last approved (total in minor units + invoice number); it is not read from the service tables.
 */
export async function checkInvariants(h: Harness, obligations: Map<number, { totalMinor: number; invoiceNumber: string }>): Promise<InvariantReport> {
  const creations = h.emu.creations().filter((c) => (c.privateNote ?? "").startsWith(MARKER_PREFIX));
  const byDoc = new Map<string, number>();
  for (const c of creations) byDoc.set(`${c.vendorId}|${c.docNumber}`, (byDoc.get(`${c.vendorId}|${c.docNumber}`) ?? 0) + 1);
  const duplicateCreations = [...byDoc.entries()].filter(([, n]) => n > 1).map(([k, count]) => ({ docNumber: k.split("|")[1]!, count }));

  const ledger = h.emu.liveBills();
  const postings = (await h.db.query("select * from postings where voided_at is null")).rows;
  const openRec = new Set((await h.db.query("select invoice_id from recovery_queue where resolved_at is null and invoice_id is not null")).rows.map((r) => Number(r.invoice_id)));
  const postedIds = new Set(postings.map((p) => Number(p.invoice_id)));
  const lost: number[] = [];
  const inRecovery: number[] = [];
  const staleContent: number[] = [];
  for (const [id, ob] of obligations) {
    if (postedIds.has(id)) {
      const p = postings.find((x) => Number(x.invoice_id) === id)!;
      const bill = ledger.find((b) => b.Id === p.bill_id);
      if (bill && (Math.round(bill.TotalAmt * 100) !== ob.totalMinor || bill.DocNumber !== ob.invoiceNumber)) staleContent.push(id);
    } else if (openRec.has(id)) inRecovery.push(id);
    else lost.push(id);
  }
  const localWithoutLedger = postings.filter((p) => !ledger.some((b) => b.Id === p.bill_id && Math.round(b.TotalAmt * 100) === Number(p.total_minor))).map((p) => Number(p.invoice_id));
  const ourLedger = ledger.filter((b) => (b.PrivateNote ?? "").startsWith(MARKER_PREFIX));
  const ledgerWithoutLocal = ourLedger.filter((b) => !postings.some((p) => p.bill_id === b.Id)).map((b) => b.Id);
  const ok = duplicateCreations.length === 0 && lost.length === 0 && localWithoutLedger.length === 0 && ledgerWithoutLocal.length === 0 && staleContent.length === 0;
  return { duplicateCreations, lost, inRecovery, localWithoutLedger, ledgerWithoutLocal, staleContent, ok };
}

