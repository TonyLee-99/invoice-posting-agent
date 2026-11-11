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
    expect(s.nonResidualSeedsWithViolation).toBe(0);
    expect(s.lostInvoices).toBe(0);
    expect(s.residualDuplicatesDetectedByReconcile).toBe(s.residualSeedsWithDuplicate);
    has(`**${s.nonResidualSeedsWithViolation}** duplicates in the ${s.nonResidualSeeds} non-residual seeds, **${s.duplicateBills}** in the ${s.residualEligibleSeeds} residual-risk seeds`);
    // Remote events by class; latency-only injections are reported separately from failures.
    const f = s.faultsFired as Record<string, number>;
    const sumOf = (pred: (k: string) => boolean) => Object.entries(f).filter(([k]) => pred(k)).reduce((x, [, v]) => x + v, 0);
    const remote = sumOf((k) => k !== "worker_crash" && k !== "emulator_restart");
    const latency = sumOf((k) => k.endsWith(":latency"));
    const before5xx = sumOf((k) => /error50\d_before$/.test(k));
    const lostResponse = sumOf((k) => /(error500_after|reset_after_commit|hang_after_commit)$/.test(k));
    const n = (x: number) => x.toLocaleString("en-US");
    has(`${n(remote)} injected remote events — **${n(remote - latency)} failures** (${before5xx} 5xx before commit, ${lostResponse} committed-then-response-lost`);
    has(`${sumOf((k) => k.endsWith("hang_before_commit"))} hangs without commit, ${sumOf((k) => k.endsWith("throttle429"))} throttling, ${sumOf((k) => k.endsWith("expire_token"))} token expiries) plus **${n(latency)} latency-only**`);
    has(`${n(s.invoices)} invoices, ${f.worker_crash} worker crashes, ${f.emulator_restart} emulator restarts`);
    has(`${chaos.all_off.summary.duplicateBills} duplicates, ${chaos.all_off.summary.seedsWithViolation}/100 seeds`);
    has(`**${chaos.all_off.summary.seedsWithViolation} of 100** seeds produce duplicates`);
  });
  it("extraction", () => {
    const f3 = (x: number) => (Math.round(x * 1000) / 1000).toFixed(3);
    has(`(95% CI ${f3(ex.llm.microF1CI95[0])}–${f3(ex.llm.microF1CI95[1])})`);
    has(`baseline **${f3(ex.baseline.microF1)}** (${f3(ex.baseline.microF1CI95[0])}–${f3(ex.baseline.microF1CI95[1])})`);
    has(`F1 **${f3(ex.llm.microF1)}**`);
    has(`on ${ex.sample.n} public labelled invoices`);
  });
  it("routing and official scorer", () => {
    expect(rt.chosen.precision).toBe(1);
    const ci = rt.chosen.precisionCI95.map((x: number) => x.toFixed(2)).join("–");
    has(`**${rt.chosen.autoApproved}/${rt.chosen.autoApproved}** correct (n=${rt.chosen.autoApproved}, Wilson 95% CI ${ci})`);
    has(`**${Math.round(rt.chosen.autoRate * 100)}%** auto-approved`);
    has(`**${official.key_fields.correct} / ${official.key_fields.scored}**`);
    const mt = JSON.parse(readFileSync(path.join(ROOT, "results/matching.json"), "utf8"));
    const f3m = (x: number) => (Math.round(x * 1000) / 1000).toFixed(3);
    has(`**${f3m(mt.originalEvalSample.accuracy)}** (${mt.originalEvalSample.correct}/${mt.originalEvalSample.n}) on the eval set`);
    has(`**${f3m(mt.allLabelledDocs.accuracy)}** (${mt.allLabelledDocs.correct}/${mt.allLabelledDocs.n}) on all labelled docs`);
    has(`${mt.addedFxVariants.correct}/${mt.addedFxVariants.n} added FX cases`);
    expect(rt.matcherOnLabels.accuracy).toBe(mt.originalEvalSample.accuracy);
  });
  it("cost", () => {
    has(`$${j("cost.json").perInvoiceUsdMean.toFixed(4)}`);
  });
});
