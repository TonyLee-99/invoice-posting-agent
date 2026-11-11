// Field scoring, following the IPP benchmark's published rules (README of DrewKraken/invoice-extraction-benchmark)
// so the IPP part can be cross-checked with the official Python scorer. Katana vendor labels are "name + address",
// so a predicted vendor is right when it is a prefix of the label (>= 3 chars).
import type { LlmExtraction } from "@ipa/domain";
import { normalizeInvoiceNumber, normalizeVendorName, tokenSimilarity, vendorNamesMatch } from "@ipa/domain";
import type { ManifestDoc } from "./prepare.ts";

export const SCORED_FIELDS = ["vendor_name", "vendor_tax_id", "invoice_number", "invoice_date", "due_date", "currency", "subtotal", "tax", "total", "document_type"] as const;
export type ScoredField = (typeof SCORED_FIELDS)[number];

export interface FieldScore {
  field: ScoredField;
  gt: unknown;
  pred: unknown;
  correct: boolean;
  tp: number;
  fp: number;
  fn: number;
}

const amountEq = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(Math.abs(a) - Math.abs(b)) < 0.005;

function fieldCorrect(doc: ManifestDoc, f: ScoredField, gt: unknown, pred: unknown): boolean {
  if (gt === null || gt === undefined || gt === "") return pred === null || pred === undefined || pred === "";
  if (pred === null || pred === undefined || pred === "") return false;
  switch (f) {
    case "vendor_name":
      if (doc.vendorRule === "prefix") {
        const p = normalizeVendorName(String(pred));
        return p.length >= 3 && normalizeVendorName(String(gt)).startsWith(p);
      }
      return vendorNamesMatch(String(gt), String(pred));
    case "invoice_number":
      return normalizeInvoiceNumber(String(gt)) === normalizeInvoiceNumber(String(pred));
    case "vendor_tax_id":
      return String(gt).replace(/[^0-9a-z]/gi, "").toLowerCase() === String(pred).replace(/[^0-9a-z]/gi, "").toLowerCase();
    case "subtotal":
    case "tax":
    case "total":
      return amountEq(gt as number, pred as number);
    default:
      return String(gt).toUpperCase() === String(pred).toUpperCase();
  }
}

export function scoreDoc(doc: ManifestDoc, e: LlmExtraction | null): { fields: FieldScore[]; lineF1: number | null; linesP: number; linesR: number } {
  const fields: FieldScore[] = [];
  for (const f of SCORED_FIELDS) {
    if (!doc.scored.includes(f)) continue;
    const gt = (doc.gt as unknown as Record<string, unknown>)[f] ?? null;
    const pred = e ? e[f].value : null;
    const correct = fieldCorrect(doc, f, gt, pred);
    const gtPresent = gt !== null && gt !== "";
    const predPresent = pred !== null && pred !== "";
    fields.push({ field: f, gt, pred, correct, tp: gtPresent && predPresent && correct ? 1 : 0, fp: predPresent && !correct ? 1 : 0, fn: gtPresent && !correct ? 1 : 0 });
  }
  let lineF1: number | null = null;
  let linesP = 0, linesR = 0;
  if (doc.scored.includes("lines")) {
    const gtLines = doc.gt.lines;
    const pred = e?.lines ?? [];
    const used = new Set<number>();
    let matched = 0;
    for (const g of gtLines) {
      const amounts = [g.amount, ...(g.alt_amounts ?? [])];
      let best = -1, bestSim = 0.2;
      pred.forEach((p, i) => {
        if (used.has(i) || !amounts.some((a) => amountEq(a, p.amount))) return;
        const sim = tokenSimilarity(g.description, p.description);
        if (sim >= bestSim) { best = i; bestSim = sim; }
      });
      if (best >= 0) { used.add(best); matched++; }
    }
    linesP = pred.length ? matched / pred.length : gtLines.length ? 0 : 1;
    linesR = gtLines.length ? matched / gtLines.length : 1;
    lineF1 = linesP + linesR ? (2 * linesP * linesR) / (linesP + linesR) : 0;
  }
  return { fields, lineF1, linesP, linesR };
}

export interface Aggregate {
  docs: number;
  microP: number;
  microR: number;
  microF1: number;
  accuracy: number;
  lineF1Mean: number | null;
  perField: Record<string, { n: number; accuracy: number; p: number; r: number; f1: number }>;
}

export function aggregate(rows: ReturnType<typeof scoreDoc>[]): Aggregate {
  const all = rows.flatMap((r) => r.fields);
  const prf = (xs: FieldScore[]) => {
    const tp = xs.reduce((s, x) => s + x.tp, 0), fp = xs.reduce((s, x) => s + x.fp, 0), fn = xs.reduce((s, x) => s + x.fn, 0);
    const p = tp + fp ? tp / (tp + fp) : 0, r = tp + fn ? tp / (tp + fn) : 0;
    return { p, r, f1: p + r ? (2 * p * r) / (p + r) : 0, accuracy: xs.length ? xs.filter((x) => x.correct).length / xs.length : 0 };
  };
  const micro = prf(all);
  const perField: Aggregate["perField"] = {};
  for (const f of SCORED_FIELDS) {
    const xs = all.filter((x) => x.field === f);
    if (xs.length) perField[f] = { n: xs.length, ...round(prf(xs)) };
  }
  const lf = rows.map((r) => r.lineF1).filter((x): x is number => x !== null);
  return { docs: rows.length, microP: r4(micro.p), microR: r4(micro.r), microF1: r4(micro.f1), accuracy: r4(micro.accuracy), lineF1Mean: lf.length ? r4(lf.reduce((a, b) => a + b, 0) / lf.length) : null, perField };
}

/** Percentile bootstrap CI over documents for micro F1. Seeded so results are reproducible. */
export function bootstrapF1(rows: ReturnType<typeof scoreDoc>[], iters = 2000, seed = 7): [number, number] {
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const vals: number[] = [];
  for (let i = 0; i < iters; i++) {
    const sample = rows.map(() => rows[Math.floor(rand() * rows.length)]!);
    vals.push(aggregate(sample).microF1);
  }
  vals.sort((a, b) => a - b);
  return [r4(vals[Math.floor(iters * 0.025)]!), r4(vals[Math.floor(iters * 0.975)]!)];
}

const r4 = (x: number) => Math.round(x * 10000) / 10000;
const round = (o: { p: number; r: number; f1: number; accuracy: number }) => ({ accuracy: r4(o.accuracy), p: r4(o.p), r: r4(o.r), f1: r4(o.f1) });

/** Wilson score interval for a proportion. */
export function wilson(k: number, n: number, z = 1.96): [number, number] | null {
  if (n === 0) return null;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [r4((c - m) / d), r4((c + m) / d)];
}
