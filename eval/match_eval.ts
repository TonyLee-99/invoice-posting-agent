// Matcher on label fields, no LLM: `tsx eval/match_eval.ts` -> results/matching.json
// Reports (1) the original 40-document eval sample, (2) all 297 labelled documents, (3) added dual-currency variants.
// POs, receipts, vendor master and FX reference rates are **Simulated** from the labels (eval/procure.ts).
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { route, threeWayMatch } from "@ipa/matching";
import type { ManifestDoc } from "./prepare.ts";
import type { ProcCase } from "./procure.ts";
import { expectedV1, gtFields, procurementFor } from "./procure.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const docs = (JSON.parse(readFileSync(path.join(ROOT, "eval/data/manifest.json"), "utf8")) as { docs: ManifestDoc[] }).docs;
const evalSample = new Set((JSON.parse(readFileSync(path.join(ROOT, "eval/data/demo_runs.json"), "utf8")) as { docId: string }[]).map((x) => x.docId));

function outcome(fields: ReturnType<typeof gtFields>, proc: ProcCase) {
  const m = threeWayMatch({ fields, vendors: proc.vendor ? [proc.vendor] : [], purchaseOrders: proc.pos, receipts: proc.receipts, isDuplicate: proc.isDuplicate, fxRates: proc.fxRates });
  const r = route({ match: m, totalMinor: fields.totalMinor, confidence: null, humanVerified: true }, { version: "eval", minFieldConfidence: 0.9, autoApproveCapMinor: 1e12, autoApproveEnabled: true });
  return { got: r.decision === "AUTO_APPROVE" ? "clean" : r.decision === "REJECT" ? "reject" : "review", codes: m.discrepancies.map((d) => d.code) };
}

const rows = docs.map((d) => {
  const proc = procurementFor(d);
  const o = outcome(gtFields(d), proc);
  return { docId: d.docId, scenario: proc.scenario, dualCurrency: Boolean(d.gt.secondary), expected: proc.expected, expectedV1: expectedV1(d, proc), ...o };
});

// Added cases: each dual-currency document under four FX conditions, expected outcome fixed by the policy.
const variants = docs.filter((d) => d.gt.secondary).flatMap((d) => {
  const base = procurementFor(d);
  const f = gtFields(d);
  const pair = Object.keys(base.fxRates)[0]!;
  const ref = base.fxRates[pair]!;
  const cases: { variant: string; fields: typeof f; proc: ProcCase; expected: string }[] = [
    { variant: "reference_agrees", fields: f, proc: base, expected: base.expected },
    { variant: "reference_off_3pct", fields: f, proc: { ...base, fxRates: { [pair]: ref * 1.03 } }, expected: base.expected === "reject" ? "reject" : "review" },
    { variant: "no_reference_rate", fields: f, proc: { ...base, fxRates: {} }, expected: base.expected === "reject" ? "reject" : "review" },
    { variant: "rate_not_printed", fields: { ...f, exchangeRate: null }, proc: base, expected: base.expected === "reject" ? "reject" : "review" },
  ];
  return cases.map((c) => ({ docId: d.docId, variant: c.variant, expected: c.expected, ...outcome(c.fields, c.proc) }));
});

const acc = (xs: { expected: string; got: string }[]) => ({ n: xs.length, correct: xs.filter((x) => x.expected === x.got).length, accuracy: xs.length ? Math.round((xs.filter((x) => x.expected === x.got).length / xs.length) * 10000) / 10000 : null });
const original = rows.filter((r) => evalSample.has(r.docId));
const out = {
  note: "Matcher + routing on label fields (isolates the deterministic matcher). Procurement data Simulated from labels.",
  originalEvalSample: { ...acc(original), generatorV1: acc(original.map((r) => ({ expected: r.expectedV1, got: r.got }))), before: { n: 40, correct: 39, accuracy: 0.975, source: "results/routing.json before the dual-currency rule (commit c89f34a)" }, misses: original.filter((x) => x.expected !== x.got) },
  allLabelledDocs: { ...acc(rows), misses: rows.filter((x) => x.expected !== x.got) },
  allLabelledDocsGeneratorV1: { ...acc(rows.map((r) => ({ expected: r.expectedV1, got: r.got }))), note: "same matcher, v1 expected-outcome rule (did not account for labels that are themselves incomplete or inconsistent)" },
  dualCurrencyDocs: { ...acc(rows.filter((r) => r.dualCurrency)), docs: rows.filter((r) => r.dualCurrency) },
  addedFxVariants: { ...acc(variants), cases: variants },
};
writeFileSync(path.join(ROOT, "results/matching.json"), JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify({ original: acc(original), all: acc(rows), allV1: acc(rows.map((r) => ({ expected: r.expectedV1, got: r.got }))), dual: acc(rows.filter((r) => r.dualCurrency)), fxVariants: acc(variants) }));
