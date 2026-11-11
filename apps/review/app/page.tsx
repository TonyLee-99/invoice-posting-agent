"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Detail, Fields, ListRow, Stats } from "../lib/api";
import { STATIC, api, money } from "../lib/api";
import { TopBar } from "./topbar";

const FILTERS = ["ALL", "NEEDS_REVIEW", "RECOVERY", "POSTED", "RECONCILED", "REJECTED"] as const;
const FIELD_ROWS: { key: keyof Fields; label: string; conf?: string; money?: boolean }[] = [
  { key: "vendorName", label: "Vendor", conf: "vendor_name" },
  { key: "invoiceNumber", label: "Invoice no.", conf: "invoice_number" },
  { key: "invoiceDate", label: "Invoice date", conf: "invoice_date" },
  { key: "dueDate", label: "Due date", conf: "due_date" },
  { key: "currency", label: "Currency", conf: "currency" },
  { key: "poNumber", label: "PO number", conf: "po_number" },
  { key: "subtotalMinor", label: "Subtotal", conf: "subtotal", money: true },
  { key: "taxMinor", label: "Tax", conf: "tax", money: true },
  { key: "freightMinor", label: "Freight", conf: "freight", money: true },
  { key: "totalMinor", label: "Total", conf: "total", money: true },
];

function Conf({ v }: { v: number | undefined }) {
  if (v === undefined) return <span />;
  const cls = v >= 0.9 ? "hi" : v >= 0.7 ? "mid" : "lo";
  return <span className={`conf ${cls}`} title="routing confidence">{v.toFixed(2)}</span>;
}

const toInput = (f: Fields, k: keyof Fields, isMoney?: boolean) => {
  const v = f[k];
  if (v === null || v === undefined) return "";
  return isMoney ? ((v as number) / 100).toFixed(2) : String(v);
};

export default function ReviewPage() {
  const [rows, setRows] = useState<ListRow[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("ALL");
  const [sel, setSel] = useState<number | null>(null);
  const [d, setD] = useState<Detail | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showText, setShowText] = useState(false);

  const load = useCallback(async () => {
    const [l, s] = await Promise.all([api.list(), api.stats()]);
    setRows(l);
    setStats(s);
    return l;
  }, []);

  useEffect(() => {
    void load().then((l) => {
      const want = Number(new URLSearchParams(window.location.search).get("id"));
      const first = l.find((r) => r.id === want) ?? l.find((r) => r.status === "NEEDS_REVIEW") ?? l[0];
      if (first) setSel(first.id);
    });
  }, [load]);

  useEffect(() => {
    if (sel === null) return;
    setErr(null);
    setDraft({});
    void api.detail(sel).then(setD).catch((e: Error) => setErr(e.message));
  }, [sel]);

  const shown = useMemo(() => rows.filter((r) => filter === "ALL" || r.status === filter), [rows, filter]);
  const inv = d?.invoice;
  const f = inv?.fields;
  const conf = inv?.extraction_meta?.confidence ?? {};
  const reasons = inv?.match?.route?.reasons ?? inv?.match?.discrepancies ?? [];
  const flaggedLines = new Set(reasons.filter((r) => r.lineIndex !== undefined).map((r) => r.lineIndex));
  const editable = inv && ["NEEDS_REVIEW", "MATCHED", "AUTO_APPROVED", "APPROVED", "REJECTED"].includes(inv.status) && !STATIC;
  const dirty = Object.keys(draft).length > 0;
  const fieldFlag = (k: string) => reasons.some((r) => (r.facts?.field as string | undefined) === k || (k === "totalMinor" && r.code === "arithmetic_mismatch") || (k === "taxMinor" && r.code === "tax_mismatch") || (k === "currency" && r.code === "currency_mismatch") || (k === "vendorName" && r.code === "vendor_unknown"));

  async function act(fn: () => Promise<Detail>) {
    setBusy(true);
    setErr(null);
    try {
      const next = await fn();
      setD(next);
      setDraft({});
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function saveEdit() {
    if (!inv || !f) return;
    const patch: Partial<Fields> = {};
    for (const [k, v] of Object.entries(draft)) {
      const row = FIELD_ROWS.find((r) => r.key === k)!;
      (patch as Record<string, unknown>)[k] = v === "" ? null : row.money ? Math.round(Number(v) * 100) : v;
    }
    void act(() => api.edit(inv.id, patch, inv.version));
  }

  const isPdf = inv?.source_mime === "application/pdf";
  return (
    <>
      <TopBar active="review" stats={stats} />
      {STATIC && <div className="banner">Static demo recorded from a real run (QuickBooks emulator, cached LLM calls). Actions are disabled; run locally for the live pipeline.</div>}
      <div className={`shell ${STATIC ? "withbanner" : ""}`}>
        <div className="col queue" data-testid="queue">
          <div className="filters">
            {FILTERS.map((x) => (
              <button key={x} className={`chip ${filter === x ? "on" : ""}`} onClick={() => setFilter(x)}>
                {x === "ALL" ? `All ${rows.length}` : `${x.replace("_", " ").toLowerCase()} ${rows.filter((r) => r.status === x).length}`}
              </button>
            ))}
          </div>
          {shown.map((r) => (
            <div key={r.id} className={`row ${sel === r.id ? "sel" : ""}`} onClick={() => setSel(r.id)} data-testid={`row-${r.id}`}>
              <div className="v">{r.vendor ?? "(vendor not read)"}</div>
              <div className="amt">{money(r.total_minor, r.currency)}</div>
              <div className="n">#{r.invoice_number ?? "—"} · {r.reasons.slice(0, 2).join(", ") || "clean"}</div>
              <div><span className={`pill s-${r.status}`}>{r.status.replace("_", " ")}</span></div>
            </div>
          ))}
          {!shown.length && <div className="empty">Nothing here.</div>}
        </div>

        <div className="col doc">
          <div className="bar">
            <span>{inv?.source_name ?? ""}</span>
            <span>
              {inv?.extraction_meta?.parse?.method === "text_layer" ? "PDF text layer" : inv?.extraction_meta?.parse ? `OCR (${((inv.extraction_meta.parse.ocrConfidence ?? 0) * 100).toFixed(0)}%)` : ""}
              {" · "}
              <a href="#" onClick={(e) => { e.preventDefault(); setShowText(!showText); }}>{showText ? "show document" : "show parsed text"}</a>
            </span>
          </div>
          <div className="view">
            {inv && !showText && (isPdf ? <iframe src={api.documentUrl(inv.id)} title="document" /> : <img src={api.documentUrl(inv.id)} alt="invoice document" />)}
            {inv && showText && <pre>{(inv as unknown as { parsed_text?: string }).parsed_text}</pre>}
          </div>
        </div>

        <div className="col detail" data-testid="detail">
          {!inv || !f ? (
            <div className="empty">{err ?? "Select an invoice."}</div>
          ) : (
            <>
              <div className="sec">
                <div className="head">
                  <h2>{f.vendorName ?? "Unknown vendor"}</h2>
                  <span className={`pill s-${inv.status}`} data-testid="status">{inv.status.replace("_", " ")}</span>
                </div>
                <div className="meta">
                  Invoice #{f.invoiceNumber ?? "—"} · {money(f.totalMinor, f.currency)} · {inv.match?.matchType ?? "no"} match{inv.match?.poNumber ? ` vs ${inv.match.poNumber}` : ""} · v{inv.version}
                </div>
                <div className="hash" title="approvals bind to this hash">content {inv.content_hash.slice(0, 16)}…</div>
              </div>

              {reasons.length > 0 && (
                <div className="sec" data-testid="reasons">
                  <h3>Why it was held <span>{reasons.length}</span></h3>
                  {reasons.map((r, i) => (
                    <div key={i} className={`reason ${r.severity === "block" ? "block" : ""}`}>
                      <div>{r.message}</div>
                      <code>{r.code}</code>
                    </div>
                  ))}
                </div>
              )}

              {inv.explanation && (inv.explanation.explanation || inv.explanation.error) && (
                <div className="sec">
                  <h3>Assistant draft <span>{inv.extraction_meta?.model ?? ""}</span></h3>
                  <div className="ai">
                    <div className="tag">Explanation (LLM, advisory)</div>
                    <p>{inv.explanation.explanation ?? inv.explanation.error}</p>
                    {inv.explanation.email_body && (
                      <>
                        <div className="tag" style={{ marginTop: 10 }}>Vendor email draft — not sent</div>
                        <div className="email"><b>{inv.explanation.email_subject}</b>{"\n\n"}{inv.explanation.email_body}</div>
                      </>
                    )}
                  </div>
                </div>
              )}

              <div className="sec">
                <h3>Extracted fields <span>{editable ? "editable — any edit voids approval" : "read-only"}</span></h3>
                <div className="grid">
                  {FIELD_ROWS.map((row) => (
                    <FieldRow key={row.key} row={row} value={draft[row.key] ?? toInput(f, row.key, row.money)} original={toInput(f, row.key, row.money)}
                      flag={fieldFlag(row.key)} conf={row.conf ? conf[row.conf] : undefined} disabled={!editable}
                      onChange={(v) => setDraft((p) => { const n = { ...p, [row.key]: v }; if (v === toInput(f, row.key, row.money)) delete n[row.key]; return n; })} />
                  ))}
                </div>
              </div>

              <div className="sec">
                <h3>Lines <span>{f.lines.length}</span></h3>
                <table className="lines">
                  <thead><tr><th>Description</th><th>Qty</th><th>Unit</th><th style={{ textAlign: "right" }}>Amount</th></tr></thead>
                  <tbody>
                    {f.lines.map((l, i) => (
                      <tr key={i} className={flaggedLines.has(i) ? "flagged" : ""}>
                        <td>{l.description}</td><td className="num">{l.quantity ?? ""}</td><td className="num">{l.unitPrice ?? ""}</td><td className="num">{money(l.amountMinor, null)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="sec">
                <div className="actions">
                  {dirty ? (
                    <button className="primary" disabled={busy} onClick={saveEdit} data-testid="save">Save edit (voids approval)</button>
                  ) : (
                    <button className="primary" disabled={busy || inv.status !== "NEEDS_REVIEW" || STATIC} onClick={() => act(() => api.approve(inv.id, inv.content_hash))} data-testid="approve">
                      Approve this version
                    </button>
                  )}
                  {dirty && <button onClick={() => setDraft({})}>Discard</button>}
                  <button className="danger" disabled={busy || inv.status !== "NEEDS_REVIEW" || STATIC} onClick={() => act(() => api.reject(inv.id, "rejected in review"))}>Reject</button>
                  {err && <span className="err" data-testid="error">{err}</span>}
                </div>
              </div>

              <PostingSection d={d!} />
              <div className="sec">
                <h3>History <a href={`audit${STATIC ? ".html" : ""}?invoice=${inv.id}`}>full audit log</a></h3>
                <ul className="timeline">
                  {d!.audit.map((a) => (
                    <li key={a.id}><span className="t">{new Date(a.at).toLocaleTimeString("en-US", { hour12: false })}</span><span><span className="a">{a.action.replace(/_/g, " ")}</span> <span className="who">· {a.actor}{a.to_status ? ` → ${a.to_status}` : ""}</span></span></li>
                  ))}
                </ul>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function FieldRow(p: { row: (typeof FIELD_ROWS)[number]; value: string; original: string; flag: boolean; conf: number | undefined; disabled: boolean; onChange: (v: string) => void }) {
  return (
    <>
      <label htmlFor={`f-${p.row.key}`}>{p.row.label}</label>
      <input id={`f-${p.row.key}`} data-testid={`field-${p.row.key}`} value={p.value} disabled={p.disabled}
        className={p.value !== p.original ? "changed" : p.flag ? "flag" : ""} onChange={(e) => p.onChange(e.target.value)} />
      <Conf v={p.conf} />
    </>
  );
}

function PostingSection({ d }: { d: Detail }) {
  if (!d.posting && !d.attempts.length && !d.recovery.length && !d.approvals.length) return null;
  return (
    <div className="sec" data-testid="posting">
      <h3>Approval & posting</h3>
      <div className="kv">
        {d.approvals.map((a) => (
          <FragmentKV key={a.id} k={`approval #${a.id}`} v={`${a.approver} · ${a.approved_content_hash.slice(0, 10)}… ${a.voided_at ? `· VOIDED (${a.void_reason})` : "· valid"}`} />
        ))}
        {d.attempts.map((a, i) => (
          <FragmentKV key={`t${i}`} k={`attempt ${a.attempt_no}`} v={`${a.outcome ?? "in flight"}${a.http_status ? ` (${a.http_status})` : ""} · ${a.worker} · requestid ${a.request_id.slice(0, 8)}…`} />
        ))}
        {d.posting && <FragmentKV k="QBO Bill" v={`Id ${d.posting.bill_id} · DocNumber ${d.posting.doc_number} · ${money(d.posting.total_minor, null)}${d.posting.adopted ? " · adopted after uncertain outcome" : ""}`} />}
        {d.recovery.map((r) => (
          <FragmentKV key={`r${r.id}`} k={`recovery #${r.id}`} v={`${r.kind}${r.resolved_at ? ` · resolved: ${r.resolution} by ${r.resolved_by}` : " · OPEN"}`} />
        ))}
      </div>
    </div>
  );
}

function FragmentKV({ k, v }: { k: string; v: string }) {
  return (<><span>{k}</span><span className="mono">{v}</span></>);
}
