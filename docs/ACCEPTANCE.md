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
