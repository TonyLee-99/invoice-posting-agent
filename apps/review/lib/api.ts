// Data access for the review UI. Live mode calls the posting API; static mode (GitHub Pages demo) reads JSON
// recorded from a real run by scripts/demo.ts, and all write actions are disabled.
export const STATIC = process.env.NEXT_PUBLIC_STATIC === "1";
const API = process.env.NEXT_PUBLIC_API ?? "http://localhost:4000";
const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export interface Reason { code: string; severity: string; message: string; facts: Record<string, unknown>; lineIndex?: number }
export interface Line { description: string; quantity: number | null; unitPrice: number | null; amountMinor: number }
export interface Fields {
  vendorName: string | null; vendorTaxId: string | null; invoiceNumber: string | null; poNumber: string | null;
  invoiceDate: string | null; dueDate: string | null; currency: string | null; documentType: string;
  subtotalMinor: number | null; taxMinor: number | null; freightMinor: number | null; totalMinor: number | null; lines: Line[];
}
export interface ListRow { id: number; status: string; decision: string | null; source_name: string; vendor: string | null; invoice_number: string | null; total_minor: number | null; currency: string | null; reasons: string[]; open_recovery: number; updated_at: string }
export interface Detail {
  invoice: {
    id: number; status: string; decision: string | null; source_name: string; source_mime: string; fields: Fields; content_hash: string; version: number;
    match: { poNumber: string | null; matchType: string; discrepancies: Reason[]; route?: { decision: string; reasons: Reason[] } } | null;
    extraction_meta: { confidence?: Record<string, number> | null; parse?: { method: string; ocrConfidence: number | null }; model?: string; costUsd?: number; latencyMs?: number } | null;
    explanation: { explanation?: string; email_subject?: string; email_body?: string; error?: string } | null;
  };
  audit: { id: number; at: string; actor: string; action: string; from_status: string | null; to_status: string | null; detail: Record<string, unknown> }[];
  attempts: { attempt_no: number; worker: string; request_id: string; outcome: string | null; remote_bill_id: string | null; http_status: number | null; error: string | null; started_at: string }[];
  posting: { bill_id: string; doc_number: string; total_minor: number; adopted: boolean; posted_at: string } | null;
  recovery: { id: number; kind: string; detail: Record<string, unknown>; opened_at: string; resolved_at: string | null; resolution: string | null; resolved_by: string | null }[];
  approvals: { id: number; approved_content_hash: string; approver: string; created_at: string; voided_at: string | null; void_reason: string | null }[];
}
export interface AuditRow { id: number; at: string; actor: string; action: string; invoice_id: number | null; invoice_number: string | null; from_status: string | null; to_status: string | null; detail: Record<string, unknown> }
export interface Stats { byStatus: Record<string, number>; openRecovery: number; lastReconciliation: { status: string; counts: Record<string, number>; finished_at: string } | null }

async function get<T>(live: string, file: string): Promise<T> {
  const r = await fetch(STATIC ? `${BASE}/demo-data/${file}` : `${API}${live}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}
async function post<T>(p: string, body: unknown): Promise<T> {
  if (STATIC) throw new Error("This is a static demo recorded from a real run; actions are disabled.");
  const r = await fetch(`${API}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? r.statusText);
  return j as T;
}

export const api = {
  list: () => get<ListRow[]>("/api/invoices", "invoices.json"),
  detail: (id: number) => get<Detail>(`/api/invoices/${id}`, `invoice-${id}.json`),
  stats: () => get<Stats>("/api/stats", "stats.json"),
  audit: () => get<AuditRow[]>("/api/audit", "audit.json"),
  documentUrl: (id: number) => (STATIC ? `${BASE}/demo-data/doc-${id}` : `${API}/api/invoices/${id}/document`),
  approve: (id: number, contentHash: string) => post<Detail>(`/api/invoices/${id}/approve`, { contentHash, actor: "reviewer" }),
  reject: (id: number, reason: string) => post<Detail>(`/api/invoices/${id}/reject`, { reason, actor: "reviewer" }),
  edit: (id: number, patch: Partial<Fields>, version: number) => post<Detail>(`/api/invoices/${id}/edit`, { patch, version, actor: "reviewer" }),
};

export function money(minor: number | null | undefined, cur: string | null | undefined): string {
  if (minor === null || minor === undefined) return "—";
  return `${(minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur ?? ""}`.trim();
}
