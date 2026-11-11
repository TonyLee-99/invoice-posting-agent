# Incidents

Real problems hit while building and testing (2026-11-11). Nothing here is invented; each entry links to the fix.

| id | found by | symptom | root cause | fix | prevention |
|---|---|---|---|---|---|
| INC-1 | fault suite A7/A7b | editing an auto-approved invoice failed with `illegal invoice transition AUTO_APPROVED -> AUTO_APPROVED` | the transition trigger also validated same-status updates when `version` changed; edits bump `version` before moving the status | trigger validates only real status changes | all status changes go through `setStatus()`; A7/A7b stay in CI |
| INC-2 | fault suite A3 | test expected `released`, got `fenced` | the stale worker's release write was itself fenced (another worker owned the job) — correct behavior, wrong test assumption | assertion accepts either; both mean "no write by the stale owner" | tests assert the invariant (no duplicate, no local change), not an internal label |
| INC-3 | chaos ablations | every ablated variant showed ~1 duplicate Bill per invoice | emulator snapshot path reused across variants (see postmortem) | delete the snapshot before each seed | full postmortem below |
| INC-4 | live eval | the 4-invoice live eval finished its LLM calls and then hung forever | concurrent parses raced on `if (!worker) worker = await createWorker()`; several tesseract workers were created, only one terminated; leaked worker threads kept Node alive | memoize the worker *promise* | one shared OCR worker per parser; replay runs would never have caught it (no OCR on cache hits) |
| INC-5 | matcher-on-labels eval | 4 of 40 label-clean cases routed to review (`arithmetic_mismatch`, `freight_over_allowance`) | the IPP labels fold shipping into `total` without a freight field; my label converter set freight to null, so subtotal+tax != total | recover freight as total − subtotal − tax for consistent docs; PO freight allowance from the label; `should_flag` docs labelled "review" | matcher accuracy on labels went 0.90 → 0.975; the remaining miss is a dual-currency document, kept as a known miss |
| INC-6 | draft grounding check | a vendor email stated "the extra 35" — a number not in the findings (85 − 50, computed by the model) | the model does arithmetic when the facts do not give the difference | matcher now emits `overBy` / `difference` facts; drafts re-run: 10/10 grounded (was 4/10 under the same check before list-marker handling and the facts fix) | grounding check runs on every draft in the eval (`results/drafts.json`) |
| INC-7 | Playwright e2e | after approving, the reload showed a different invoice, so "wait until POSTED" timed out | selection lived only in React state; reload picked the default row | selection persisted in `?id=` | e2e reloads the page by design |
| INC-8 | PDF previews in headless Chromium | the document pane was blank in screenshots | headless Chromium has no PDF viewer | page-1 PNG previews rendered with `pdftoppm` at seed time | UI always shows an image; parsed text toggle for the rest |
| INC-9 | new unit test for the baseline | baseline read invoice number "rdhafen" from "TAX INVOICE … Nordhafen" | the label regex `no\.?` had no word boundary and `\s*` crossed into the next token | word boundary + same-line match | baseline F1 0.761 → 0.765 on the same 40 docs (reported numbers updated); unit tests for the baseline now exist |
| INC-10 | independent code review | a JPY Bill would be recorded 100× too large locally | worker/reconciler/recovery converted remote amounts with `× 100` instead of the currency-aware `toMinor` | `toMinor(amount, currency)` everywhere; adoption and reconciliation also compare due date, line accounts and total | JPY end-to-end test (`statemachine.test.ts`) |
| INC-11 | independent code review | an expired/revoked token during query-first would burn the invoice's retry budget and park it in recovery | the client wrapped auth failure on reads as generic "unavailable"; only the create path opened the auth circuit | typed `QboAuthError` on reads; worker pauses and keeps the job pending | auth-outage test (`faults.test.ts`) |
| INC-12 | independent code review | the emulator's "race" mode never actually raced | no await between the requestid check and the commit, so JavaScript ran them atomically | a processing delay in race mode; a concurrency test asserts two creations in race mode and one in serialize mode | chaos re-run with the real race window (`results/chaos.json`); that re-run also produced the first real residual duplicate (seed 233), caught by reconciliation |
| INC-13 | acceptance B4 (round 2) | the one matcher miss on the eval set: a dual-currency invoice (USD lines, NAD payable) held for `arithmetic_mismatch` | the data model had one currency per invoice, so USD lines were summed against a NAD subtotal | general FX rule: printed rate parsed deterministically, lines compared in the PO's currency, rate trusted only against a reference rate, else routed to a person; 6 matcher tests + 16 FX eval variants | full-set label check (297 docs) also exposed tax-inclusive line layouts and a label generator that ignored incomplete/inconsistent labels; both fixed and reported with before/after |

## Postmortem: INC-3 — the chaos harness leaked ledger state between runs

**Impact.** No production impact (found in the test harness). It would have made the ablation evidence (A12) wrong in
the flattering direction for the *defenses*: with every variant showing hundreds of duplicates, "defenses off ⇒
duplicates" looked overwhelming, but the numbers were not caused by the ablations at all.

**Timeline (CST, 2026-11-11; approximate, from file timestamps and the session log).**
- 04:02 first ablation trial (20 + 4×40 seeds). `all_defenses`: 0 violations. Every ablation: 40/40 seeds violating,
  578–1,295 duplicate Bills over 561 invoices.
- 04:04 suspicion: `no_query_first` keeps the stable requestid, so with no emulator restart it should almost never
  duplicate; ~1 duplicate per invoice is not explainable by the faults that fired.
- 04:06 reproduced seed 3 alone with `no_query_first`: 0 duplicates. The difference between "alone" and "in the
  run" pointed at shared state.
- 04:08 root cause: the emulator snapshot file was named `ipa-chaos-<pid>-<seed>.json`; the `all_defenses` variant ran
  first and left snapshots; each later variant re-used the same pid and seed numbers and *loaded the previous
  variant's ledger* at reset, so the creation log already contained one Bill per invoice.
- 04:10 fix: delete the snapshot before each seed. Re-run: `no_stable_requestid` 4/40 seeds, `no_query_first` 5/40,
  fencing+lease guard 0/40 (random stalls are rare), `all_off` 35/40.
- 04:11 full run committed (`results/chaos.json`): 300 seeds with all defenses, 0 violations; `all_off` 84/100.

**Root cause.** Test isolation relied on a file name instead of an explicit reset. The invariant checker read the
emulator's creation log, which is correct, but the log was not the log of this seed.

**What went well.** The invariant checker uses independent evidence (append-only creation log + the harness's own
obligation list), so a wrong number was visible rather than silently passing. A sanity bound ("can the injected faults
explain this many duplicates?") caught it.

**What changed.**
1. Snapshot deleted before every seed (`services/posting/src/chaos.ts`).
2. Deterministic per-defense ablation tests (`services/posting/test/ablations.test.ts`) that must produce exactly one
   duplicate with the defense off and zero with it on, so ablation evidence no longer depends on random chaos alone.
3. Fencing and the lease guard showed 0/100 in random chaos; the deterministic test shows why: they are redundant
   layers — a paused stale worker duplicates only when *both* are off.
