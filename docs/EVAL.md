# Evaluation

Every number below is in `results/` and was produced by the command shown. Sample sizes are small on purpose (owner's
rescope: numbers must be real, not large); every size is a knob.

| what | command | file |
|---|---|---|
| extraction, routing, drafts, cost (n = 40) | `npx tsx eval/run.ts --n 40 --backend claude-cli` (live) / `--backend replay --check` (CI) | `extraction.json`, `routing.json`, `drafts.json`, `cost.json` |
| official IPP scorer cross-check | see §2 | `ipp_official_scores.json` |
| chaos (300 seeds + 4 ablations × 100) | `make chaos-full` | `chaos.json` |
| ROI assumption model | `npx tsx scripts/roi.ts` | `roi.json` |

**Scale up:** `make data && npx tsx eval/run.ts --n 297 --backend claude-cli` (the manifest has 297 labelled
documents; ~300 Haiku calls, about $0.36 list-price equivalent at the measured $0.0012/invoice).

## 1. Data and provenance

| set | docs in manifest | license (verified on the dataset card / repo, 2026-11-11) | who wrote the labels |
|---|---|---|---|
| Invoice Extraction Benchmark v1 (InvoiceParser Pro, HF `drew-ipp/invoice-extraction-benchmark`) | 181 (113 text-layer PDFs, 53 photos/handwritten JPEGs, 15 scans) | data CC BY 4.0, code MIT | the publisher (generated documents with answer keys); the publisher sells an extraction product |
| Katana "Sparrow" invoices (HF `katanaml-org/invoices-donut-data-v1`), from Kozłowski & Weichbroth (2021), Mendeley Data | 116 of the first 120 rows (4 rows had no labels and are excluded) | MIT on the HF card | Katana ML team annotations |

Both sets are **generated documents, not real company invoices**. Neither label set was written or edited by me.
Splits are fixed by a hash of the group id (IPP variants of one base document share a group): 65 dev / 232 test.
Nothing was tuned on test; the prompt was written once (`extract-v1`) before the first run, and the routing threshold
0.9 was fixed in the policy before the run (the sweep is reported, not used to choose it).

**This run:** 40 test-split documents — 24 IPP (round-robin over its 10 categories) + 16 Katana; 18 parsed from the
PDF text layer, 22 by OCR (tesseract.js).

**Simulated:** POs, goods receipts and the vendor master are generated from each invoice's *label* with one controlled
discrepancy chosen by hash (`eval/procure.ts`): 23 clean, 3 price within tolerance, 4 price over tolerance, 3 tax rate,
2 currency, 1 each of duplicate, missing PO, unknown vendor, missing receipt, partial receipts.

## 2. Field extraction (LLM vs regex baseline, same parsed text)

Model `claude-haiku-5-5` via `claude -p` (subscription; cost reported as list-price equivalent). Baseline:
`packages/extract/src/baseline.ts`, label-driven regexes over the identical text.

| | micro P | micro R | **micro F1 (95% bootstrap CI)** | field accuracy | line-item F1 (mean per doc) |
|---|---|---|---|---|---|
| LLM | 0.964 | 0.919 | **0.941 (0.889–0.981)** | 0.919 | 0.900 |
| regex baseline | 0.838 | 0.697 | **0.761 (0.710–0.805)** | 0.697 | 0.704 |

By source: IPP 0.913 vs 0.736; Katana 0.991 vs 0.813. Target was baseline + 0.15 F1: met (+0.180), but the CIs come
from 40 documents.

Per-field accuracy (LLM / baseline): vendor 0.975 / 0.575 · invoice no. 0.900 / 0.850 · invoice date 0.875 / 0.825 ·
due date 0.750 / 0.813 · currency 1.000 / 0.500 · subtotal 0.925 / 0.400 · tax 0.900 / 0.450 · total 0.925 / 0.900 ·
document type 0.958 / 0.958 · vendor tax id 0.938 / 0.938. The baseline is better on due date (LLM misses printed
due dates on photos).

**External judge.** The IPP part was re-scored with the publisher's official scorer (`scorer/evaluate.py`,
`--allow-missing`, 24 docs): 184 / 208 key fields correct (88.5%), 19 / 24 documents fully correct, line items mean
F1 0.833. Field-level counts agree with our scorer (e.g. invoice number 20/24, invoice date 19/24, due date 12/16).
The official scorer also checks flags (0 of 1 inconsistent and 0 of 1 multi-invoice files flagged — we do not emit
flags; the matcher's `arithmetic_mismatch` does that job downstream).

### Error analysis (all 26 LLM field errors)
| cause | errors | example |
|---|---|---|
| OCR on handwritten invoice books | 8 | `handwritten-invoice-book-poor-6`: total 7227.30 read as 2227.20 (OCR) |
| OCR on phone photos (motion blur, screen photo) | 8 | `photo-motion-blur-moderate`: totals not recovered at all |
| multi-invoice file answered as one "other" document with nulls | 8 | `hard-multiple-invoices-3` (the label expects the first invoice) |
| dual-currency layout | 1 | `currency-dual-usd-nad-4`: tax 0 returned as null |
| OCR digit error in tax id | 1 | `999-83-6062` → `999-833-6062` |

17 of 26 errors are on OCR input. Fix direction: a vision-capable model call for low-OCR-confidence pages (not done).

### Confidence reliability (routing confidence of the 5 critical fields, 184 field instances)
| confidence bin | n | accuracy |
|---|---|---|
| < 0.5 | 9 | 0.333 |
| 0.5–0.8 | 10 | 0.700 |
| 0.8–0.9 | 19 | 0.947 |
| 0.9–0.95 | 74 | 0.959 |
| ≥ 0.95 | 72 | 1.000 |

The score is monotone in accuracy but is a heuristic (LLM self-report × grounding × arithmetic × OCR discount), not a
fitted calibrator; with 40 docs a fitted model would overfit. ECE/Brier were not computed (B7 partial).

## 3. Matching and routing

- **Matcher on label fields** (isolates the deterministic matcher): 39 / 40 = 0.975 of expected outcomes. The miss is a
  dual-currency document whose labelled lines do not sum to its subtotal. Caveat: scenarios were generated by me with
  rules that mirror the matcher's, so this mainly checks the implementation, not the policy.
- **End to end on extracted fields** (threshold 0.9): 23 / 40 = 0.575 match the expected outcome. Confusion:
  clean → auto 8, clean → review 16; reject → reject 4; review → review 11, review → reject 1. The errors are in the
  safe direction except one review case rejected (an invoice the LLM typed as `other`).
- **Auto-approval** at 0.9: 8 of 40 auto-approved (20%), precision 8/8 = 1.00 (Wilson 95% CI 0.68–1.00). Zero false
  approvals at every threshold from 0.5 (18 auto-approved) to 0.95; target ≥ 0.98 precision is met on the point
  estimate, but 8 approvals cannot establish it — the CI lower bound is 0.68.

## 4. Explanations and vendor email drafts
10 drafts on held invoices; a draft is grounded when every number in it appears in the deterministic findings or the
invoice header (numbered-list markers excluded). Final run: **10 / 10 grounded**. First run under the same check:
4 / 10 — the model computed differences ("the extra 35") that were not in the facts; the matcher now supplies
`overBy`/`difference` (INC-6).

## 5. Cost and latency (40 invoices, 50 calls)
$0.0012 per invoice (list-price equivalent, Haiku 5.5), $0.048 total. LLM latency per invoice p50 9.5 s, p95 22.0 s;
parse p50 1.8 s, p95 14.4 s (OCR). Owner policy: Haiku for all runs; a Sonnet 5.5 comparison was not run.

## 6. Reliability (fault injection)
`results/chaos.json`, 300 seeds with all defenses: 4,180 invoices, 3,323 injected remote faults plus worker crashes,
stalls, edits and emulator restarts: **0 duplicate Bills, 0 lost invoices, 0 ledger/local mismatches, every seed
quiescent after faults stopped**. 43 seeds were pre-classified as residual-risk eligible (requestid memory lost while
a write could be invisible or a stale request could land); none produced a duplicate. Ablations (100 seeds each):
no stable requestid 14/100 seeds violate (29 duplicates); no query-first 12/100 (22); no fencing + no lease guard 0/100
(random stalls are rare — the deterministic test shows the duplicate when both are off); all defenses off 84/100
(353 duplicates). Claims are scoped to these injected scenarios.

## 7. ROI (Simulated assumption model)
`results/roi.json`: with the measured 20% auto-approval rate and assumed inputs (600 invoices/month, 6 min manual vs
2.5 min review, $38/h, 0.2% manual duplicate rate), base case ≈ $2,233/month; sensitivity grid over auto-rate
(0–60%) and review minutes (1.5–4). The inputs other than auto-rate and LLM cost are assumptions, not measurements.

## Holdout policy
Test-split documents were never used for prompt or rule changes. Changes made after seeing results (freight recovery
in label conversion, `overBy` facts) affect the Simulated label conversion and the draft facts, not the extractor;
they are listed in `docs/INCIDENTS.md`.
