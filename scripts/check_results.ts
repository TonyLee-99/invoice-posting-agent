// Release-gate checks over results/*.json. `tsx scripts/check_results.ts <chaos|extraction|routing|cost|docs|all> [file]`
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const [mode = "all", file] = process.argv.slice(2);
const read = (f: string) => JSON.parse(readFileSync(path.join(ROOT, f), "utf8"));
const fails: string[] = [];
const need = (cond: boolean, msg: string) => { if (!cond) fails.push(msg); };

function chaos(f = "results/chaos.json", full = f === "results/chaos.json") {
  const r = read(f);
  const s = r.variants.all_defenses.summary;
  need(s.seeds >= (full ? 300 : 20), `${f}: seeds ${s.seeds}`);
  need(s.nonResidualSeedsWithViolation === 0, `${f}: ${s.nonResidualSeedsWithViolation} non-residual seeds violated invariants`);
  need(s.lostInvoices === 0 && s.ledgerLocalMismatches === 0 && s.staleContentPostings === 0, `${f}: lost/mismatch/stale nonzero`);
  need(s.notQuiescent === 0, `${f}: ${s.notQuiescent} seeds not quiescent after faults stopped`);
  need(s.residualSeedsWithDuplicate === s.residualDuplicatesDetectedByReconcile, `${f}: residual duplicates not all detected`);
  if (full) {
    const off = r.variants.all_off?.summary;
    need(Boolean(off) && off.seedsWithViolation / off.seeds >= 0.2, `${f}: all-off ablation violates on < 20% of seeds`);
  }
}
function extraction() {
  const r = read("results/extraction.json");
  need(r.sample.n >= 40, `extraction n=${r.sample.n}`);
  need(Array.isArray(r.llm.microF1CI95) && Array.isArray(r.baseline.microF1CI95), "extraction: missing CIs");
  need(r.errors !== undefined, "extraction: no error list");
}
function routing() {
  const r = read("results/routing.json");
  need(r.cases >= 20, `routing cases=${r.cases}`);
  need(r.chosen && "precision" in r.chosen, "routing: no chosen threshold");
}
function cost() {
  const c = read("results/cost.json");
  need(c.invoices > 0 && c.perInvoiceUsdMean >= 0, "cost.json incomplete");
  need(read("results/drafts.json").n > 0, "drafts.json empty");
}
function docs() {
  for (const d of ["PRD", "DISCOVERY", "ACCEPTANCE", "ROLLOUT", "RUNBOOK", "INCIDENTS", "EVAL", "FEEDBACK_TO_PRODUCT", "QBO_SEMANTICS", "DESIGN"]) need(existsSync(path.join(ROOT, `docs/${d}.md`)), `docs/${d}.md missing`);
  const adrs = existsSync(path.join(ROOT, "docs/decisions")) ? readdir("docs/decisions").filter((x) => /^\d{4}-.*\.md$/.test(x)) : [];
  need(adrs.length >= 4, `only ${adrs.length} ADRs`);
}
function readdir(d: string): string[] {
  return readdirSync(path.join(ROOT, d));
}

if (mode === "chaos") chaos(file);
else if (mode === "extraction") extraction();
else if (mode === "routing") routing();
else if (mode === "cost") cost();
else if (mode === "docs") docs();
else { chaos(); extraction(); routing(); cost(); docs(); }
if (fails.length) { console.error(`FAIL\n- ${fails.join("\n- ")}`); process.exit(1); }
console.log(`PASS ${mode}`);
