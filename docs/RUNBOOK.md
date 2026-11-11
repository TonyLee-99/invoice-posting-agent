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
  the query (DESIGN §5). Reconciliation detects it: it happened once in 43 such chaos seeds (seed 233) and was caught
  as an `orphan_remote_bill`. Void the extra Bill in QBO (§4).
- Do not "fix" a stuck POSTING invoice by editing status in SQL; the transition trigger rejects it on purpose.

## Run against the QuickBooks sandbox (live)
Nothing here has been run live yet; the same scripts are rehearsed against the emulator in CI
(`services/posting/test/live_rehearsal.test.ts`).

One-time setup (owner):
1. developer.intuit.com → create an app (QuickBooks Online and Payments) → **Development / sandbox keys**; scope
   **Accounting** (`com.intuit.quickbooks.accounting`). A sandbox company is created with the developer account.
2. Redirect URI in the app's Development settings, exactly: `http://localhost:8777/callback`.
3. Store the keys in the login keychain (prompts for the value; nothing on the command line or in history):
   `security add-generic-password -s qbo-client-id -a "$USER" -w` and
   `security add-generic-password -s qbo-client-secret -a "$USER" -w`.
4. `make qbo-auth` — starts a server on 127.0.0.1:8777, opens Intuit's consent page, receives `code` + `realmId`,
   checks `state`, exchanges the code, and writes `private/qbo_tokens.json` + `private/qbo_realm.json` (mode 0600,
   gitignored, never printed). If port 8777 is busy the script says so and exits.

Runs:
- `make qbo-contract` → `results/qbo_live_contract.json`: repeat requestid, same requestid with a different body,
  concurrent same requestid, DocNumber query freshness, duplicate DocNumber with a new requestid, token refresh
  rotation. Creates `IPA-CT-…` Bills marked `ipa-contract` and deletes them afterwards. Update rows 5, 6, 8, 9 of
  `docs/QBO_SEMANTICS.md` from the result.
- `make qbo-live-demo` → `results/qbo_live_demo.json`: 10 Simulated invoices mapped onto the sandbox's own vendors
  and first Expense account, posted through ingest → match → route → outbox → worker; one worker **process** is
  SIGKILLed after its first remote write and a second worker recovers after the lease expires; then reconciliation
  and an independent per-DocNumber check in the sandbox (expect 10 Bills, 0 duplicates, ledger totals equal). Add
  `--cleanup` (`npx tsx scripts/qbo/live_demo.ts --n 10 --cleanup`) to delete the demo Bills afterwards.
- All three print `SKIP: …` and exit 0 when keychain items or tokens are missing.
- Tokens: access token ~1 h, refreshed automatically under a file lock (refresh tokens rotate; the newest is kept).
  To disconnect, revoke the app in the sandbox company and delete `private/qbo_tokens.json`.
