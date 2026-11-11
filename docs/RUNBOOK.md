# Runbook

## Run
- API + worker: `make demo` (local, emulator) or `tsx services/posting/src/bin/worker.ts` per worker process with
  `DATABASE_URL`, `QBO_*` env (see `services/posting/src/config.ts`). Workers are stateless; run 2+ for availability.
- Migrations: `migrate()` runs on start; schema in `services/posting/migrations/`.
- Rollback: stop workers (outbox rows wait), deploy the previous version, start workers. Never delete outbox rows.

## Alerts
| alert | meaning | action |
|---|---|---|
| recovery item open > 24 h | an invoice is parked with an uncertain or conflicting outcome | §3 |
| reconciliation `partial` | QBO unavailable during the nightly run | rerun; nothing was concluded from missing pages |
| reconciliation `orphan_remote_bill` | a Bill with our marker no posting claims: a duplicate or a lost link | §4 |
| auth circuit open | token refresh failed (revoked app, expired refresh token) | re-run OAuth connect; jobs stay pending |
| outbox oldest pending > 1 h | workers down or QBO throttling | check workers, 429 rate |

## 3. Recovery queue procedures (scripted in `services/posting/src/recovery.ts`; the chaos runner uses the same code)
- **unknown_outcome** (timeouts/5xx exhausted the retry budget): wait the quiet period (no attempt younger than the
  lease) → query QBO by DocNumber + vendor. One Bill with our marker and equal content → `adopt`. None → `retry`
  (same requestid). Anything else → treat as ambiguous.
- **ambiguous_remote** (a same-DocNumber Bill exists without our marker, or several): open QBO. If a clerk keyed it
  by hand and it is the same invoice → `adopt` with `override.reason`. If it is a different invoice reusing the
  number → fix the invoice number (vendor query) and `close_not_posted`, then re-submit.
- **remote_rejected** (QBO validation fault): fix master data (vendor, account, currency) → `close_not_posted` → edit
  and re-approve. Never retry the same payload.
- Every resolution re-queries the ledger and stores the evidence on the item.

## 4. Reconciliation differences (ledger is the system of record)
- **ledger_differs**: someone edited the Bill in QBO. Confirm with AP → `accept_ledger` (local record takes the ledger
  values). If the edit was wrong, fix it in QBO and rerun reconciliation.
- **missing_in_ledger**: the Bill was deleted in QBO. Confirm intent → `acknowledge_deleted` (posting voided, invoice
  closed). To re-post, re-submit the invoice (new approval).
- **orphan_remote_bill**: void the extra Bill in QBO (this service never deletes ledger data) → `confirm_duplicate_voided`.

## On-call notes
- A duplicate is still possible in one documented case: requestid memory lost **and** the first write invisible to
  the query (DESIGN §5). Reconciliation detects it; in 43 such chaos seeds none occurred, but it is not ruled out.
- Do not "fix" a stuck POSTING invoice by editing status in SQL; the transition trigger rejects it on purpose.
