"use client";
import { useEffect, useState } from "react";
import type { AuditRow, Stats } from "../../lib/api";
import { api } from "../../lib/api";
import { TopBar } from "../topbar";

export default function AuditPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [only, setOnly] = useState<number | null>(null);
  useEffect(() => {
    const inv = Number(new URLSearchParams(window.location.search).get("invoice"));
    if (inv) setOnly(inv);
    void api.audit().then(setRows);
    void api.stats().then(setStats);
  }, []);
  const shown = rows.filter((r) => only === null || r.invoice_id === only);
  return (
    <>
      <TopBar active="audit" stats={stats} />
      <div className="audit">
        <p style={{ color: "var(--muted)" }}>
          Append-only log of every state transition and human action{only ? ` for invoice ${only}` : ""}. {only && <a href="#" onClick={(e) => { e.preventDefault(); setOnly(null); }}>show all</a>}
        </p>
        <table data-testid="audit-table">
          <thead><tr><th>#</th><th>Time</th><th>Invoice</th><th>Actor</th><th>Action</th><th>Transition</th><th>Detail</th></tr></thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id}>
                <td className="mono">{r.id}</td>
                <td className="mono">{new Date(r.at).toLocaleTimeString("en-US", { hour12: false })}</td>
                <td>{r.invoice_id ? `${r.invoice_id} · ${r.invoice_number ?? ""}` : "—"}</td>
                <td>{r.actor}</td>
                <td><b>{r.action.replace(/_/g, " ")}</b></td>
                <td className="mono">{r.from_status || r.to_status ? `${r.from_status ?? ""} → ${r.to_status ?? ""}` : ""}</td>
                <td className="d" title={JSON.stringify(r.detail)}>{JSON.stringify(r.detail)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
