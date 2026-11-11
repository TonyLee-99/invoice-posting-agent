import Fastify from "fastify";
import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { QboClient } from "@ipa/qbo";
import type { Db } from "./db.ts";
import type { PostingService } from "./service.ts";
import type { PipelineDeps } from "./pipeline.ts";
import { processDocument } from "./pipeline.ts";
import { reconcile } from "./reconcile.ts";
import type { Resolution } from "./recovery.ts";
import { RecoveryDesk } from "./recovery.ts";

export interface ApiDeps {
  db: Db;
  svc: PostingService;
  qbo: QboClient;
  pipeline: PipelineDeps | null;
  /** Map stored source names to files on disk (demo documents live under data/). */
  resolveDocument: (sourceName: string) => string | null;
}

export async function listInvoices(db: Db, status?: string) {
  const r = await db.query(
    `select i.id, i.status, i.decision, i.source_name, i.source_mime, i.fields->>'vendorName' as vendor, i.fields->>'invoiceNumber' as invoice_number,
            (i.fields->>'totalMinor')::bigint as total_minor, i.fields->>'currency' as currency, i.updated_at,
            coalesce((select jsonb_agg(d->>'code') from jsonb_array_elements(i.match->'route'->'reasons') d), '[]') as reasons,
            (select count(*) from recovery_queue q where q.invoice_id = i.id and q.resolved_at is null)::int as open_recovery
       from invoices i ${status ? "where i.status = $1" : ""} order by i.id`,
    status ? [status] : [],
  );
  return r.rows;
}

export async function invoiceDetail(db: Db, id: number) {
  const inv = (await db.query("select * from invoices where id = $1", [id])).rows[0];
  if (!inv) return null;
  const [audit, attempts, posting, recovery, approvals] = await Promise.all([
    db.query("select id, at, actor, action, from_status, to_status, detail from audit_log where invoice_id = $1 order by id", [id]),
    db.query("select a.attempt_no, a.worker, a.request_id, a.started_at, a.finished_at, a.outcome, a.remote_bill_id, a.http_status, a.error from post_attempts a join outbox o on o.id = a.outbox_id where o.invoice_id = $1 order by a.id", [id]),
    db.query("select * from postings where invoice_id = $1", [id]),
    db.query("select * from recovery_queue where invoice_id = $1 order by id", [id]),
    db.query("select id, approved_content_hash, approved_version, approver, created_at, voided_at, void_reason from approvals where invoice_id = $1 order by id", [id]),
  ]);
  return { invoice: inv, audit: audit.rows, attempts: attempts.rows, posting: posting.rows[0] ?? null, recovery: recovery.rows, approvals: approvals.rows };
}

export async function stats(db: Db) {
  const byStatus = (await db.query("select status, count(*)::int as n from invoices group by status")).rows;
  const openRecovery = (await db.query("select count(*)::int as n from recovery_queue where resolved_at is null")).rows[0].n;
  const lastRecon = (await db.query("select * from reconciliation_runs order by id desc limit 1")).rows[0] ?? null;
  return { byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])), openRecovery, lastReconciliation: lastRecon };
}

export function buildApi(d: ApiDeps) {
  const app = Fastify({ logger: false, bodyLimit: 20 * 1024 * 1024 });
  app.setErrorHandler((err: Error & { status?: number; code?: string }, _req, reply) => {
    const status = err.status ?? (err.code === "23505" ? 409 : 500);
    void reply.status(status).send({ error: err.message });
  });
  app.addHook("onRequest", async (_req, reply) => {
    reply.header("access-control-allow-origin", "*");
    reply.header("access-control-allow-headers", "content-type");
  });
  app.options("/*", async (_req, reply) => reply.status(204).send());
  app.addContentTypeParser(["application/pdf", "image/png", "image/jpeg"], { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  app.get("/api/health", async () => ({ ok: true }));
  app.get("/api/stats", async () => stats(d.db));
  app.get<{ Querystring: { status?: string } }>("/api/invoices", async (req) => listInvoices(d.db, req.query.status));
  app.get<{ Params: { id: string } }>("/api/invoices/:id", async (req, reply) => (await invoiceDetail(d.db, Number(req.params.id))) ?? reply.status(404).send({ error: "not found" }));
  app.get<{ Params: { id: string } }>("/api/invoices/:id/document", async (req, reply) => {
    const inv = (await d.db.query("select source_name, source_mime from invoices where id = $1", [Number(req.params.id)])).rows[0];
    const file = inv ? d.resolveDocument(inv.source_name) : null;
    if (!file) return reply.status(404).send({ error: "no document" });
    return reply.type(file.endsWith(".png") ? "image/png" : inv.source_mime).send(createReadStream(file));
  });
  /** Upload: raw body with the document's content type; ?name=<file name>. */
  app.post<{ Querystring: { name?: string } }>("/api/invoices", async (req, reply) => {
    if (!d.pipeline) return reply.status(503).send({ error: "pipeline disabled" });
    const mime = String(req.headers["content-type"] ?? "").split(";")[0]!;
    const name = req.query.name ?? `upload-${Date.now()}`;
    const dir = path.join(os.tmpdir(), "ipa-uploads");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, path.basename(name));
    writeFileSync(file, req.body as Buffer);
    return processDocument(d.pipeline, file, mime, name);
  });
  app.post<{ Params: { id: string }; Body: { contentHash: string; actor?: string } }>("/api/invoices/:id/approve", async (req) => {
    await d.svc.approve(Number(req.params.id), req.body.actor ?? "reviewer", req.body.contentHash);
    return invoiceDetail(d.db, Number(req.params.id));
  });
  app.post<{ Params: { id: string }; Body: { reason: string; actor?: string } }>("/api/invoices/:id/reject", async (req) => {
    await d.svc.reject(Number(req.params.id), req.body.actor ?? "reviewer", req.body.reason);
    return invoiceDetail(d.db, Number(req.params.id));
  });
  app.post<{ Params: { id: string }; Body: { patch: Record<string, unknown>; version?: number; actor?: string } }>("/api/invoices/:id/edit", async (req) => {
    await d.svc.edit(Number(req.params.id), req.body.actor ?? "reviewer", req.body.patch, req.body.version);
    return invoiceDetail(d.db, Number(req.params.id));
  });
  app.get("/api/recovery", async () => (await d.db.query("select q.*, i.fields->>'invoiceNumber' as invoice_number from recovery_queue q left join invoices i on i.id = q.invoice_id order by q.id")).rows);
  app.post<{ Params: { id: string }; Body: Resolution & { actor?: string } }>("/api/recovery/:id/resolve", async (req) => {
    await new RecoveryDesk(d.db, d.qbo).resolve(Number(req.params.id), req.body, req.body.actor ?? "controller");
    return { ok: true };
  });
  app.get<{ Querystring: { limit?: string } }>("/api/audit", async (req) => (await d.db.query("select a.*, i.fields->>'invoiceNumber' as invoice_number from audit_log a left join invoices i on i.id = a.invoice_id order by a.id desc limit $1", [Number(req.query.limit ?? 200)])).rows);
  app.post("/api/reconcile", async () => reconcile(d.db, d.qbo));
  return app;
}
