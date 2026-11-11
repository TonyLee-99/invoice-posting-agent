// README numbers must come from results/*.json; this test fails if either side changes without the other.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
const j = (f: string) => JSON.parse(readFileSync(path.join(ROOT, "results", f), "utf8"));
const chaos = j("chaos.json").variants;
const ex = j("extraction.json");
const rt = j("routing.json");
const official = j("ipp_official_scores.json").summary;

const has = (s: string) => expect(readme, `README should contain "${s}"`).toContain(s);

describe("README matches results/", () => {
  it("chaos headline", () => {
    const s = chaos.all_defenses.summary;
    expect(s.duplicateBills).toBe(0);
    expect(s.lostInvoices).toBe(0);
    // Remote faults injected by the emulator; worker crashes and restarts are counted separately.
    const remote = Object.entries(s.faultsFired as Record<string, number>).filter(([k]) => k !== "worker_crash" && k !== "emulator_restart").reduce((a, [, v]) => a + v, 0);
    has(`${s.seeds} randomized fault-injection seeds (${s.invoices.toLocaleString("en-US")} invoices, ${remote.toLocaleString("en-US")} injected remote faults, ${s.faultsFired.worker_crash} worker crashes)`);
    has(`${s.faultsFired.worker_crash} worker crashes`);
    has(`${chaos.all_off.summary.duplicateBills} duplicates, ${chaos.all_off.summary.seedsWithViolation}/100 seeds`);
  });
  it("extraction", () => {
    const f3 = (x: number) => (Math.round(x * 1000) / 1000).toFixed(3);
    has(`${f3(ex.llm.microF1)} F1 vs ${f3(ex.baseline.microF1)}`);
    has(`(95% CI ${f3(ex.llm.microF1CI95[0])}–${f3(ex.llm.microF1CI95[1])})`);
    has(`baseline **${f3(ex.baseline.microF1)}** (${f3(ex.baseline.microF1CI95[0])}–${f3(ex.baseline.microF1CI95[1])})`);
    has(`F1 **${f3(ex.llm.microF1)}**`);
    has(`on ${ex.sample.n} public labelled invoices`);
  });
  it("routing and official scorer", () => {
    expect(rt.chosen.precision).toBe(1);
    has(`precision **${rt.chosen.autoApproved}/${rt.chosen.autoApproved}**`);
    has(`**${Math.round(rt.chosen.autoRate * 100)}%** auto`);
    has(`**${official.key_fields.correct} / ${official.key_fields.scored}**`);
    has(`**${rt.matcherOnLabels.accuracy}** (39/40)`);
  });
  it("cost", () => {
    has(`$${j("cost.json").perInvoiceUsdMean.toFixed(4)}`);
  });
});
