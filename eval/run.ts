// End-to-end evaluation. `tsx eval/run.ts --n 40 --backend claude-cli` (live, records caches) or
// `--backend replay --check` (offline, zero LLM calls, diffs against committed results/).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { LlmExtraction, ScalarField } from "@ipa/domain";
import { CRITICAL_FIELDS } from "@ipa/domain";
import { Parser, applyStatedFx, baselineExtract, fieldConfidence, llmExtract, toFields } from "@ipa/extract";
import type { LLMResponse } from "@ipa/llm";
import { createClient, extractJson } from "@ipa/llm";
import type { Discrepancy } from "@ipa/matching";
import { route, threeWayMatch } from "@ipa/matching";
import type { ManifestDoc } from "./prepare.ts";
import { gtFields, procurementFor } from "./procure.ts";
import { aggregate, bootstrapF1, scoreDoc, wilson } from "./score.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const arg = (k: string, d: string) => (args.includes(k) ? args[args.indexOf(k) + 1]! : d);
const N = Number(arg("--n", "40"));
const BACKEND = arg("--backend", "replay") as "replay" | "claude-cli";
const MODEL = arg("--model", "claude-haiku-5-5");
const DRAFTS_N = Number(arg("--drafts-n", "10"));
const CHECK = args.includes("--check");
const OUT = path.join(ROOT, arg("--out", "results"));
const THRESHOLD = 0.9; // fixed before the run (DEFAULT_ROUTING_POLICY); the sweep below is reported, not used to pick it

const manifest = JSON.parse(readFileSync(path.join(ROOT, "eval/data/manifest.json"), "utf8")) as { docs: ManifestDoc[] };
const hkey = (s: string) => createHash("sha256").update(`sample-v1:${s}`).digest("hex");

/** Deterministic stratified sample from the test split: 60% IPP (round-robin over categories), 40% Katana. */
function sample(n: number): ManifestDoc[] {
  const test = manifest.docs.filter((d) => d.split === "test").sort((a, b) => hkey(a.docId).localeCompare(hkey(b.docId)));
  const ipp = test.filter((d) => d.source === "ipp");
  const kat = test.filter((d) => d.source === "katana");
  const nIpp = Math.min(ipp.length, Math.round(n * 0.6));
  const cats = [...new Set(ipp.map((d) => d.category))].sort();
  const byCat = new Map(cats.map((c) => [c, ipp.filter((d) => d.category === c)]));
  const picked: ManifestDoc[] = [];
  while (picked.length < nIpp) for (const c of cats) { const x = byCat.get(c)!.shift(); if (x && picked.length < nIpp) picked.push(x); }
  return [...picked, ...kat.slice(0, n - picked.length)];
}

const docs = sample(N);
const llm = createClient(BACKEND === "replay" ? "replay" : "claude-cli", { callLog: BACKEND === "replay" ? undefined : path.join(ROOT, "results/llm_calls.jsonl") });
const parser = new Parser({ cacheDir: path.join(ROOT, "cache/replay/parse"), tessdataDir: path.join(ROOT, "data/tessdata"), offline: BACKEND === "replay" });

interface DocRun {
  doc: ManifestDoc;
  parse: { method: string; ms: number; chars: number; ocrConfidence: number | null };
  llm: LlmExtraction | null;
  llmError: string | null;
  repaired: boolean;
  baseline: LlmExtraction;
  conf: Partial<Record<ScalarField, number>> | null;
  calls: LLMResponse[];
  text: string;
}

const runs: DocRun[] = [];
await Promise.all(
  docs.map(async (doc, i) => {
    await new Promise((r) => setTimeout(r, i)); // keep output order stable-ish; concurrency is capped in the client
    const p = await parser.parse(path.join(ROOT, doc.file), doc.mime, doc.sha256);
    const r = await llmExtract(llm, p.text, MODEL);
    runs.push({
      doc, parse: { method: p.method, ms: p.ms, chars: p.text.length, ocrConfidence: p.ocrConfidence }, llm: r.extraction, llmError: r.error, repaired: r.repaired,
      baseline: baselineExtract(p.text), conf: r.extraction ? fieldConfidence(r.extraction, p.text, { ocr: p.method !== "text_layer" }) : null, calls: r.calls, text: p.text,
    });
    process.stderr.write(".");
  }),
);
await parser.close();
runs.sort((a, b) => a.doc.docId.localeCompare(b.doc.docId));
process.stderr.write("\n");

// ---- extraction ------------------------------------------------------------------------------------------
const scoredLlm = runs.map((r) => scoreDoc(r.doc, r.llm));
const scoredBase = runs.map((r) => scoreDoc(r.doc, r.baseline));
const bySource = (src: string, which: typeof scoredLlm) => aggregate(which.filter((_, i) => runs[i]!.doc.source === src));
const errors = runs.flatMap((r, i) => scoredLlm[i]!.fields.filter((f) => !f.correct).map((f) => ({ docId: r.doc.docId, category: r.doc.category, parse: r.parse.method, field: f.field, gt: f.gt, pred: f.pred })));

// Confidence reliability: bucket the routing confidence of critical fields against correctness.
const bins = [0, 0.5, 0.8, 0.9, 0.95, 1.0001];
const calib = bins.slice(0, -1).map((lo, b) => ({ lo, hi: Math.min(1, bins[b + 1]!), n: 0, correct: 0 }));
runs.forEach((r, i) => {
  if (!r.conf) return;
  for (const f of scoredLlm[i]!.fields) {
    if (!(CRITICAL_FIELDS as readonly string[]).includes(f.field)) continue;
    const c = r.conf[f.field as ScalarField] ?? 0;
    const bin = calib.find((x, k) => c >= x.lo && (c < bins[k + 1]!))!;
    bin.n++;
    if (f.correct) bin.correct++;
  }
});

const extraction = {
  sample: { n: runs.length, ipp: runs.filter((r) => r.doc.source === "ipp").length, katana: runs.filter((r) => r.doc.source === "katana").length, split: "test", byParse: count(runs.map((r) => r.parse.method)), byCategory: count(runs.map((r) => r.doc.category)) },
  model: MODEL,
  promptVersion: "extract-v1",
  llm: { ...aggregate(scoredLlm), microF1CI95: bootstrapF1(scoredLlm), ipp: bySource("ipp", scoredLlm), katana: bySource("katana", scoredLlm), schemaFailures: runs.filter((r) => !r.llm).length, repaired: runs.filter((r) => r.repaired).length },
  baseline: { ...aggregate(scoredBase), microF1CI95: bootstrapF1(scoredBase), ipp: bySource("ipp", scoredBase), katana: bySource("katana", scoredBase) },
  calibration: calib.map((b) => ({ ...b, accuracy: b.n ? Math.round((b.correct / b.n) * 1000) / 1000 : null })),
  errors,
};

// ---- matching + routing ---------------------------------------------------------------------------------
const cases = runs.map((r) => ({ r, proc: procurementFor(r.doc) }));
function decide(fields: ReturnType<typeof gtFields>, proc: ReturnType<typeof procurementFor>, conf: DocRun["conf"], human: boolean, threshold: number) {
  const m = threeWayMatch({ fields, vendors: proc.vendor ? [proc.vendor] : [], purchaseOrders: proc.pos, receipts: proc.receipts, isDuplicate: proc.isDuplicate, fxRates: proc.fxRates });
  const rt = route({ match: m, totalMinor: fields.totalMinor, confidence: conf, humanVerified: human }, { version: "eval", minFieldConfidence: threshold, autoApproveCapMinor: 1e12, autoApproveEnabled: true });
  return { m, rt, outcome: rt.decision === "AUTO_APPROVE" ? "clean" : rt.decision === "REJECT" ? "reject" : "review" };
}
const gtRuns = cases.map(({ r, proc }) => ({ docId: r.doc.docId, scenario: proc.scenario, expected: proc.expected, got: decide(gtFields(r.doc), proc, null, true, THRESHOLD).outcome }));
const confusion = (xs: { expected: string; got: string }[]) => {
  const c: Record<string, Record<string, number>> = {};
  for (const x of xs) ((c[x.expected] ??= {})[x.got] = (c[x.expected]![x.got] ?? 0) + 1);
  return c;
};
const criticalRight = (i: number) => scoredLlm[i]!.fields.filter((f) => (CRITICAL_FIELDS as readonly string[]).includes(f.field)).every((f) => f.correct);
const sweep = [0.5, 0.7, 0.8, 0.85, 0.9, 0.95, 0.99].map((t) => {
  const outs = cases.map(({ r, proc }, i) => ({ i, proc, d: r.llm ? decide(applyStatedFx(toFields(r.llm), r.text), proc, r.conf, false, t) : null }));
  const auto = outs.filter((o) => o.d?.outcome === "clean");
  const good = auto.filter((o) => o.proc.expected === "clean" && criticalRight(o.i));
  return { threshold: t, autoApproved: auto.length, autoRate: round(auto.length / cases.length), precision: auto.length ? round(good.length / auto.length) : null, precisionCI95: wilson(good.length, auto.length), falseApprovals: auto.filter((o) => !(o.proc.expected === "clean" && criticalRight(o.i))).map((o) => ({ docId: runs[o.i]!.doc.docId, scenario: o.proc.scenario, criticalFieldsRight: criticalRight(o.i) })) };
});
const e2e = cases.map(({ r, proc }) => ({ docId: r.doc.docId, scenario: proc.scenario, expected: proc.expected, got: r.llm ? decide(applyStatedFx(toFields(r.llm), r.text), proc, r.conf, false, THRESHOLD).outcome : "review" }));
const routing = {
  note: "POs, receipts and vendor master are Simulated from labels; expected outcome is part of the generated label.",
  cases: cases.length,
  scenarios: count(cases.map((c) => c.proc.scenario)),
  matcherOnLabels: { accuracy: round(gtRuns.filter((x) => x.expected === x.got).length / gtRuns.length), confusion: confusion(gtRuns), misses: gtRuns.filter((x) => x.expected !== x.got) },
  endToEndOnExtracted: { threshold: THRESHOLD, accuracy: round(e2e.filter((x) => x.expected === x.got).length / e2e.length), confusion: confusion(e2e), misses: e2e.filter((x) => x.expected !== x.got) },
  thresholdSweep: sweep,
  chosen: sweep.find((s) => s.threshold === THRESHOLD),
};

// ---- exception explanations + vendor email drafts ---------------------------------------------------------
const DRAFT_SYSTEM = `You help an accounts-payable clerk. You get the invoice header and the deterministic match findings (JSON).
Write (1) "explanation": 2-3 plain-English sentences for the clerk on why the invoice was held and what to check, and
(2) a short, polite vendor email asking for a corrected invoice or confirmation. Use ONLY numbers that appear in the input. Do not decide anything; do not promise payment.
Return ONLY JSON: {"explanation": string, "email_subject": string, "email_body": string}.`;
const reviewCases = cases.filter(({ r, proc }) => r.llm && decide(applyStatedFx(toFields(r.llm), r.text), proc, r.conf, true, THRESHOLD).m.discrepancies.length > 0).slice(0, DRAFTS_N);
const drafts = [];
for (const { r, proc } of reviewCases) {
  const f = applyStatedFx(toFields(r.llm!), r.text);
  const d = decide(f, proc, r.conf, true, THRESHOLD);
  const input = { invoice: { vendor: f.vendorName, invoiceNumber: f.invoiceNumber, invoiceDate: f.invoiceDate, currency: f.currency, total: f.totalMinor === null ? null : f.totalMinor / 100, poNumber: d.m.poNumber }, findings: d.m.discrepancies.map((x: Discrepancy) => ({ code: x.code, message: x.message, facts: x.facts })) };
  const resp = await llm.complete({ model: MODEL, system: DRAFT_SYSTEM, prompt: JSON.stringify(input), purpose: "draft", effort: "low" });
  type Draft = { explanation: string; email_subject: string; email_body: string };
  let out: Draft | null;
  try { out = extractJson(resp.text) as Draft; } catch { out = null; }
  // Dates may be reworded ("24 April 2025"), so their parts count as given.
  const allowed = new Set((JSON.stringify(input).match(/\d+(?:\.\d+)?/g) ?? []).map(normNum));
  // Numbered-list markers ("1. ") are not quantities; everything else must appear in the input.
  const prose = out ? `${out.explanation} ${out.email_subject} ${out.email_body}`.replace(/(^|\n)\s*\d+[.)]\s/g, "$1") : "";
  const used = (prose.match(/\d+(?:[.,]\d+)*/g) ?? []).map((x) => normNum(x.replace(/,(?=\d{3})/g, "")));
  const ungrounded = used.filter((x) => !allowed.has(x));
  drafts.push({ docId: r.doc.docId, scenario: proc.scenario, codes: d.m.discrepancies.map((x) => x.code), ok: Boolean(out), ungroundedNumbers: ungrounded, grounded: Boolean(out) && ungrounded.length === 0, draft: out, costUsd: resp.costUsd, latencyMs: resp.latencyMs, calls: [resp] });
  r.calls.push(resp);
}
const draftsOut = { n: drafts.length, grounded: drafts.filter((d) => d.grounded).length, groundedRate: drafts.length ? round(drafts.filter((d) => d.grounded).length / drafts.length) : null, drafts: drafts.map(({ calls: _c, ...x }) => x) };

// ---- cost / latency -------------------------------------------------------------------------------------
const perDoc = runs.map((r) => ({ cost: r.calls.reduce((s, c) => s + c.costUsd, 0), llmMs: r.calls.reduce((s, c) => s + c.latencyMs, 0), parseMs: r.parse.ms, calls: r.calls.length }));
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? null; };
const cost = {
  model: MODEL, backend: "claude-cli (subscription; costs are list-price equivalents reported by the CLI)", invoices: runs.length,
  llmCalls: perDoc.reduce((s, x) => s + x.calls, 0),
  totalUsd: round(perDoc.reduce((s, x) => s + x.cost, 0), 6),
  perInvoiceUsdMean: round(perDoc.reduce((s, x) => s + x.cost, 0) / runs.length, 6),
  llmLatencyMsP50: pct(perDoc.map((x) => x.llmMs), 0.5), llmLatencyMsP95: pct(perDoc.map((x) => x.llmMs), 0.95),
  parseMsP50: pct(perDoc.map((x) => x.parseMs), 0.5), parseMsP95: pct(perDoc.map((x) => x.parseMs), 0.95),
};

// ---- IPP official-format predictions (for scorer/evaluate.py) ---------------------------------------------
const ippPred = { system: `invoice-posting-agent ${MODEL} extract-v1`, run_date: "2026-11-11", documents: Object.fromEntries(runs.filter((r) => r.doc.source === "ipp").map((r) => [r.doc.docId.slice(4), r.llm ? { vendor_name: r.llm.vendor_name.value, invoice_number: r.llm.invoice_number.value, invoice_date: r.llm.invoice_date.value, due_date: r.llm.due_date.value, currency: r.llm.currency.value, subtotal: r.llm.subtotal.value, tax: r.llm.tax.value, total_amount: r.llm.total.value, document_type: r.llm.document_type.value, line_items: r.llm.lines.map((l) => ({ description: l.description, amount: l.amount })), flagged: false, references: [] } : {}])) };

// Demo bundle for the review UI / static export: parsed text + extraction + confidence per doc (no images inlined).
const demo = runs.map((r, i) => ({ docId: r.doc.docId, file: r.doc.file, mime: r.doc.mime, source: r.doc.source, category: r.doc.category, parse: r.parse, text: r.text, extraction: r.llm, confidence: r.conf, proc: cases[i]!.proc }));

const files: Record<string, unknown> = { "extraction.json": extraction, "routing.json": routing, "drafts.json": draftsOut, "cost.json": cost, "ipp_predictions.json": ippPred };
mkdirSync(OUT, { recursive: true });
let diff = 0;
for (const [name, body] of Object.entries(files)) {
  const text = JSON.stringify(body, null, 1) + "\n";
  const target = path.join(OUT, name);
  if (CHECK) {
    let prev: string;
    try { prev = readFileSync(target, "utf8"); } catch { prev = ""; }
    if (prev !== text) { diff++; process.stderr.write(`DIFF ${name}\n`); }
  } else writeFileSync(target, text);
}
if (!CHECK) writeFileSync(path.join(ROOT, "eval/data/demo_runs.json"), JSON.stringify(demo) + "\n");
console.log(JSON.stringify({ n: runs.length, llmF1: extraction.llm.microF1, baselineF1: extraction.baseline.microF1, live: llm.stats.live, cached: llm.stats.cached, costUsd: round(llm.stats.costUsd, 4), check: CHECK ? (diff ? "FAIL" : "PASS") : "written" }));
if (CHECK && diff) process.exit(1);

function count(xs: string[]) { const c: Record<string, number> = {}; for (const x of xs) c[x] = (c[x] ?? 0) + 1; return c; }
function round(x: number, d = 4) { const f = 10 ** d; return Math.round(x * f) / f; }
function normNum(s: string) { const n = Number(s.replace(/,/g, "")); return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : s; }
