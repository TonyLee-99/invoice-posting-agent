import type { Stats } from "../lib/api";
import { STATIC } from "../lib/api";

export function TopBar({ active, stats }: { active: "review" | "audit"; stats: Stats | null }) {
  const s = stats?.byStatus ?? {};
  const posted = (s.POSTED ?? 0) + (s.RECONCILED ?? 0);
  return (
    <div className="top">
      <div className="brand">AP Review <span>/ invoice-posting-agent</span></div>
      <nav>
        <a href={STATIC ? "./" : "/"} className={active === "review" ? "on" : ""}>Review queue</a>
        <a href={STATIC ? "audit.html" : "/audit"} className={active === "audit" ? "on" : ""}>Audit log</a>
      </nav>
      <div className="kpis">
        <span>Needs review <b>{s.NEEDS_REVIEW ?? 0}</b></span>
        <span>Posted <b>{posted}</b></span>
        <span>Recovery queue <b>{stats?.openRecovery ?? 0}</b></span>
        <span>Last reconciliation <b>{stats?.lastReconciliation ? `${stats.lastReconciliation.status}` : "—"}</b></span>
      </div>
    </div>
  );
}
