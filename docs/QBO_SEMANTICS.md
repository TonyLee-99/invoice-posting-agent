# QuickBooks Online semantics we rely on, and how the emulator differs

The real adapter (`packages/qbo/src/client.ts`) is written against Intuit's documentation but has **not been run
against a live QBO company** (no Intuit developer account yet). Every posting result in this repo is
**emulator-verified**. Checked 2026-11-11.

## Assumption matrix

| # | Behavior we rely on | Source | Status |
|---|---|---|---|
| 1 | `requestid` query parameter on write requests; a repeated requestid returns the original response instead of re-executing | Intuit, "Basic ID and field definitions" — https://static.developer.intuit.com/output_html/qbo/docs/learn/learn-basic-field-definitions.html ; Intuit help article "What is RequestId and its usage" — https://help.developer.intuit.com/s/article/What-is-RequestId-and-its-usage | documented |
| 2 | requestid must be unique per company (realm), max 50 chars (36 for batch) | same page | documented |
| 3 | Without a requestid a retried create makes a second entity | same page ("the server would create a duplicate invoice with a new entity ID") | documented |
| 4 | DocNumber is not an idempotency key; query for the transaction before retrying a failed create | same page, DocNumber section | documented |
| 5 | How long requestids are remembered | not published by Intuit | **unknown** — emulator default 10 min, lost on restart |
| 6 | Behavior of two *concurrent* requests with the same requestid | not documented | **unknown** — emulator has `serialize` (default) and `race` modes; chaos uses both |
| 7 | Bill DocNumber max 21 chars; filterable in queries (`select * from Bill where DocNumber = '…'`) | Intuit Bill entity reference (DocNumber "max 21 chars, filterable, sortable") | documented (via help-forum quote of the reference) |
| 8 | Duplicate DocNumber on a Bill is accepted (company preference "warn on duplicate bill number" is a UI warning) | not confirmed for the API | **assumed pessimistically**: emulator accepts duplicates, so our own defenses are what is tested |
| 9 | Query results visible immediately after create | not documented | **assumed pessimistically**: emulator `queryLagMs` injects read-after-write lag |
| 10 | Minor versions 1–74 retired 2025-08-01; requests are served as 75; we pin `minorversion=75` | https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api/minor-versions ; Intuit developer blog (Medium) "Changes to our Accounting API…" | documented |
| 11 | OAuth 2.0 auth-code flow: authorize `https://appcenter.intuit.com/connect/oauth2`, token `https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer`, scope `com.intuit.quickbooks.accounting`, access token ~1 h, refresh token rotates and the newest must be stored | Intuit OAuth 2.0 docs (developer.intuit.com › Authorization › OAuth 2.0) | documented; rotation handled with compare-and-set + advisory lock |
| 12 | Error envelope `{"Fault":{"Error":[{"Message","Detail","code"}],"type"}}`; 401 for expired token; 429 `ThrottleExceeded` | Intuit error-handling docs | documented shape; codes used by the emulator are representative, not exhaustive |
| 13 | TotalAmt is computed by QBO from lines | Bill entity reference | documented |

Third-party note (not Intuit): a consultancy blog (zenofirm.com, "Safe retries on QuickBooks Online") reports that
requestids are not queryable later and the cache window is unpublished. We do not depend on that claim; it is why
query-before-write exists.

## What the emulator implements
OAuth authorize redirect + token endpoint (code exchange, refresh with rotation), Bill create/read, query by DocNumber,
paginated `STARTPOSITION/MAXRESULTS`, `count(*)`, requestid memory (TTL, optional persistence), vendor/currency/line
validation, an append-only creation log, snapshot persistence across restarts, and fault injection: 5xx before/after
commit, connection reset after commit, hang before/after commit, 429 with Retry-After, expired token, latency,
read-after-write lag.

## Known differences from real QBO
- No AP account/expense account validation beyond "AccountRef present"; no tax codes (tax and freight are posted as
  separate expense lines, a simplification real deployments would replace with TxnTaxDetail).
- No multi-currency exchange rates, no VendorCredit entity (credit notes are rejected for manual handling), no CDC.
- Query language: only the four query shapes the service uses.
- Throttling is injected, not modelled on Intuit's per-realm limits.
- Fault codes are representative.

## To run live (needs owner)
`make qbo-auth` then `make qbo-contract` (see `docs/RUNBOOK.md`, "Run against the QuickBooks sandbox"). The contract
script checks rows 1, 6, 8, 9 and 11 directly and records the same-requestid-different-body behavior; rows 5 (retention
window) cannot be measured in a short run. Until `results/qbo_live_contract.json` exists, every row marked unknown or
assumed stays as written here.
