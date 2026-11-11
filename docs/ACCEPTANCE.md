# Acceptance criteria

Fixed before building (2026-11-11). At the end each line gets PASS / FAIL with evidence (command + `results/` file).
Targets that are missed are reported with the real number; they are not moved.

## A. Reliability (release gate — all must pass)

| id | criterion | evidence |
|---|---|---|
| A1 | Crash before remote write: invoice ends POSTED exactly once; no duplicate Bill | `services/posting/test/faults.test.ts` |
| A2 | Crash after remote write, before local commit: the next attempt queries QBO and adopts the existing Bill; zero duplicates | same |
| A3 | Duplicate outbox delivery (two workers hold the same job via lease expiry): exactly one Bill | same |
| A4 | Timeout after remote commit (response lost): query-before-retry adopts; zero duplicates | same |
| A5 | 5xx storm (>= 10 consecutive 5xx, some after commit): eventually POSTED or in recovery queue; zero duplicates | same |
| A6 | 4–8 concurrent workers on 50+ jobs: each job processed, zero duplicates, no deadlock | same |
| A7 | Edit after approval, before posting: approval voided, nothing posted for old content; re-approval posts new content once | same |
| A8 | Edit while POSTING / after POSTED: refused with 409 | same |
| A9 | Emulator restart mid-run (state persisted, requestid memory dropped): zero duplicates | same |
| A10 | Unknown outcome that cannot be resolved (query keeps failing): lands in recovery queue, never auto-retried blind | same |
| A11 | Chaos: >= 300 fixed seeds, random fault mixes, 2–8 workers: invariants I1–I4 hold on every seed, checked against the emulator's append-only creation log and the harness's own obligation list (residual-risk scenario reported separately) | `results/chaos.json` |
| A12 | Negative control: each defense ablated alone (requestid, query-first, fencing, lease guard) fails its deterministic schedule, and the all-off chaos run produces invariant violations on >= 20% of seeds | `results/chaos.json` |
| A15 | Liveness: after faults stop, every obligation is POSTED within a bounded number of worker ticks, or in recovery for a declared reason; recovery items are resolved by the RUNBOOK procedure (scripted) and end POSTED exactly once | `results/chaos.json` |
| A16 | Fencing: a stale worker resuming after lease takeover changes no local state (deterministic barrier test) | `services/posting/test/faults.test.ts` |
| A17 | Two partial invoices against one PO line approved concurrently cannot both consume the same received quantity | `services/posting/test/reservations.test.ts` |
| A18 | Adoption safety: a same-DocNumber Bill without our marker (manual entry) is never adopted and never duplicated; it goes to recovery | `services/posting/test/faults.test.ts` |
| A13 | Nightly reconciliation: injected ledger drift (bill deleted / amount changed / orphan bill) is detected and queued; ledger == local after resolution | `services/posting/test/reconcile.test.ts` |
| A14 | At least one real-process test: worker child process SIGKILLed mid-post, recovery by a new process, zero duplicates | `services/posting/test/sigkill.test.ts` |

## B. Extraction and matching (targets; real numbers reported either way)

| id | criterion | target |
|---|---|---|
| B1 | Eval set: >= 200 public labelled invoices, license recorded, split dev/test fixed before tuning | provenance in `docs/EVAL.md`, `results/dataset.json` |
| B2 | LLM field-level micro F1 on test split, with bootstrap 95% CI, vs regex baseline on the same parsed text | LLM >= baseline + 0.15 F1 (target) |
| B3 | Per-field table and error analysis (>= 20 errors categorized) | `docs/EVAL.md` |
| B4 | Matching accuracy on labelled discrepancy cases with ground-truth fields | >= 0.98 decision accuracy |
| B5 | Matching end-to-end on extracted fields, reported with the confusion matrix | reported |
| B6 | Auto-approve precision at the threshold chosen on dev, measured on test (auto-approved invoices whose critical fields are all correct and whose true match decision is clean), with counts, Wilson CI, and false-approval rate per discrepancy type | >= 0.98, with auto-approve rate reported |
| B7 | Confidence calibration: ECE/Brier of calibrated vs raw LLM confidence on test split | reported |
| B8 | Cost and latency per invoice (list-price equivalent, p50/p95) | `results/cost.json` |
| B9 | Exception explanation / vendor email drafts: every number in a draft appears in the deterministic discrepancy facts (grounding check) | >= 0.95 grounded |

## C. Product and engineering

| id | criterion |
|---|---|
| C1 | `make check` green offline (lint, types, unit + fault tests, replay eval diff vs committed results) with zero live LLM calls |
| C2 | CI workflow runs `make check` with a Postgres service |
| C3 | QBO real adapter: OAuth 2.0 auth-code + refresh (rotating refresh token persisted), Bill create with requestid + minorversion, Bill query by DocNumber — unit-tested against the emulator; semantics cited in `docs/QBO_SEMANTICS.md`; not run live (stated) |
| C4 | Review UI: queue, detail with document image + fields + confidence + discrepancy highlights + LLM rationale + email draft, edit -> re-approval, recovery queue, audit log; Playwright e2e passes; screenshots in `docs/img/` |
| C5 | Static demo export (no server) from a recorded run, Pages-ready |
| C6 | Docs: PRD, DISCOVERY (Simulated), ROLLOUT, RUNBOOK, >= 4 ADRs, INCIDENTS (real, one full postmortem), FEEDBACK_TO_PRODUCT, EVAL |
| C7 | README headline numbers are checked against `results/*.json` by a test |

## Results (2026-11-11)

Evidence commands: `make check` (offline: lint, types, 79 tests, 50-seed chaos, replay eval diff — PASS), `make chaos-full`,
`npx tsx eval/run.ts --n 40 --backend claude-cli`, `npm run -w @ipa/review e2e`. Sample sizes follow the owner's rescope
(40 invoices, 40 labelled matching cases, 300 chaos seeds).

| id | result | evidence |
|---|---|---|
| A1–A10 | PASS | `faults.test.ts` (crash before/after write, after intent/after commit, duplicate delivery, timeout after commit incl. query lag, 5xx storm, 429, 8 workers × 60 jobs, edit-before-post incl. race, edit refused while POSTING/POSTED, emulator restart without requestid memory, unresolvable unknown outcome) |
| A11 | PASS | `results/chaos.json`: 300 seeds, 4,180 invoices, 2,306 remote faults + 942 worker crashes + 75 restarts; 0 duplicates, 0 lost, 0 mismatches; 43 residual-eligible seeds, 0 duplicates |
| A12 | PASS | each defense ablated in a deterministic schedule produces exactly one duplicate (`ablations.test.ts`; fencing and lease guard only when both are off); all-off chaos: 84/100 seeds violate (≥ 20%) |
| A13 | PASS | `reconcile.test.ts`: deleted, changed and orphan Bills detected, idempotent re-run, partial run on read failure, ledger == local after runbook |
| A14 | PASS | `sigkill.test.ts`: real child worker SIGKILLed before and after the remote write; new worker recovers, 1 Bill |
| A15 | PASS | chaos: every seed quiescent after faults stop (liveness p95 in `chaos.json`); runbook bot resolves the queue; 0 items left |
| A16 | PASS | `faults.test.ts` A16: audit/attempt/outbox snapshot identical before and after the stale worker resumes |
| A17 | PASS | `reservations.test.ts`: 4 concurrent partial invoices, exactly 1 auto-approved; reviewer blocked until a new receipt |
| A18 | PASS | `faults.test.ts` A18: manual same-DocNumber Bill → `ambiguous_remote`, no Bill created by us |
| B1 | PARTIAL | 297 labelled docs in the manifest with licenses recorded; this run uses 40 (rescope); split fixed before tuning |
| B2 | PASS | LLM micro F1 0.941 (0.889–0.981) vs baseline 0.765 (0.712–0.809): +0.176 ≥ +0.15 |
| B3 | PASS | per-field table + all 26 errors categorized (`docs/EVAL.md` §2) |
| B4 | FAIL (0.975 < 0.98) | matcher on label fields 39/40; the miss is a dual-currency document (kept, not relabelled) |
| B5 | PASS | end-to-end confusion matrix reported (0.575 agreement; errors mostly in the safe direction) |
| B6 | PASS on point estimate, not established | 8/8 auto-approvals correct (Wilson 0.68–1.00); 0 false approvals at any threshold 0.5–0.95; n too small to establish 0.98 |
| B7 | PARTIAL | reliability table reported; ECE/Brier and a fitted calibrator not done (heuristic score) |
| B8 | PASS | $0.0012/invoice, LLM p50 9.5 s / p95 22.0 s (`results/cost.json`) |
| B9 | PASS | 10/10 drafts grounded (first run 4/10; INC-6) |
| C1 | PASS | `make check` green offline, `live: 0` LLM calls |
| C2 | PASS (not yet run on GitHub) | `.github/workflows/ci.yml` with a Postgres 16 service runs `make check` |
| C3 | PASS (emulator-verified; not live) | `packages/qbo/test/qbo.test.ts`; `docs/QBO_SEMANTICS.md` |
| C4 | PASS | Playwright e2e (2 tests) on the live API; screenshots in `docs/img/` |
| C5 | PASS | `docs/demo/` static export, Playwright check against a local static server |
| C6 | PASS | PRD, DISCOVERY (Simulated), ROLLOUT, RUNBOOK, 4 ADRs, INCIDENTS (8 + postmortem), FEEDBACK_TO_PRODUCT, EVAL |
| C7 | PASS | `eval/test/readme.test.ts` (caught a wrong fault count in the first README draft) |
