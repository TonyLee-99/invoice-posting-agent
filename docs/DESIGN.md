# Design: recoverable invoice posting

Status: draft for review (written before code). Owner: Zhengtao Li.

## 1. Problem and the one hard problem

An accounts-payable (AP) clerk receives vendor invoices, checks them against the purchase order (PO) and the goods
receipt (GR), gets approval, and enters a Bill in the ledger (QuickBooks Online, "QBO"). Automating the reading part is
easy to demo. The part that loses money is the **write path**: a Bill entered twice gets paid twice; an invoice that
silently never reaches the ledger is a late-payment penalty and a vendor escalation.

The hard problem this project isolates: **post every approved invoice to an external ledger without creating duplicate Bills or losing invoices,
under crashes, retries, duplicate deliveries, timeouts with unknown outcome, concurrent workers and post-approval
edits** — and prove it with fault injection, not prose. Claims are always scoped to "under the N injected fault
scenarios we ran"; there is no system-wide guarantee.

The LLM does what it is good at and nothing on the write path:
- field extraction from parsed invoice text into a zod-validated schema with per-field confidence;
- plain-English explanation of deterministic exceptions;
- a draft email to the vendor for a human to send.

Matching, routing, approval and posting are deterministic code.

## 2. Components

```
apps/review          Next.js review UI (queue, invoice detail, edit -> re-approve, recovery queue, audit log)
services/posting     HTTP API + outbox worker + reconciler + Postgres migrations (the state machine lives here)
packages/domain      zod schemas (Invoice, PO, GoodsReceipt, Bill), money (integer minor units), content hashing
packages/llm         LLMClient interface; backends: claude-cli, anthropic (only if ANTHROPIC_API_KEY), replay; cache
packages/extract     parse (PDF text layer via pdfjs; OCR fallback via tesseract.js), LLM extraction, regex baseline,
                     field confidence
packages/matching    deterministic 2-/3-way match + routing policy
packages/qbo         QBO client (OAuth 2.0, token refresh, Bill create/query, minorversion, requestid) + HTTP emulator
                     with fault injection
eval/                dataset preparation, extraction/matching/routing evals, chaos runner, cost accounting
```

One Node process can run API + N workers; workers can also run as separate processes. Postgres is the only
coordination point (no queue broker, no Temporal; see ADR-0003).

## 3. Data model (Postgres)

- `invoices`: id, source document (sha256, path, mime), parsed text, `extracted` jsonb (as produced by the LLM),
  `fields` jsonb (current values, possibly human-edited), `content_hash` (sha256 of canonical JSON of the posting-relevant
  fields), `status`, `version` (int, bumped on every edit), vendor_id, po_number, timestamps.
- `match_results`: invoice_id, invoice_version, decision, discrepancies jsonb, policy_version.
- `approvals`: invoice_id, approved_content_hash, approved_version, approver (`auto` or user), created_at, voided_at,
  void_reason. **An approval is valid only while `approved_content_hash = invoices.content_hash` and not voided.**
- `outbox`: id, invoice_id, kind (`post_bill`), idempotency_key (unique), payload jsonb, payload_hash, status
  (`pending|in_flight|done|cancelled|dead`), attempts, available_at, lease_owner, lease_until, last_error.
- `post_attempts`: id, outbox_id, attempt_no, request_id, started_at, finished_at, outcome
  (`created|adopted|unknown|rejected|throttled|server_error`), remote_bill_id, http_status, error.
- `postings`: invoice_id (unique), bill_id, realm_id, doc_number, amount_minor, currency, payload_hash, posted_at.
- `recovery_queue`: id, invoice_id, kind (`unknown_outcome|ambiguous_remote|remote_rejected|reconcile_mismatch|
  orphan_remote_bill`), detail jsonb, opened_at, resolved_at, resolution, resolved_by.
- `audit_log`: append-only; every state transition and human action with actor, before/after hash, reason.
- `reconciliation_runs`: id, started_at, finished_at, counts jsonb.

Invariants enforced by the schema (not only by code): unique `postings.invoice_id`; unique `outbox.idempotency_key`;
unique (`vendor_id`, normalized invoice number) on non-rejected invoices (duplicate-invoice guard); status transitions
validated by a `CHECK`-backed transition table and a trigger that rejects illegal transitions.

## 4. State machine

```
RECEIVED -> PARSED -> EXTRACTED -> MATCHED -> AUTO_APPROVED --------\
                                          -> NEEDS_REVIEW -> APPROVED -> POSTING -> POSTED -> RECONCILED
                                          -> REJECTED      -> REJECTED            \-> RECOVERY (human)
any pre-POSTING state --edit--> MATCHED (re-match, re-route; prior approval voided)
POSTING/POSTED/RECONCILED --edit--> refused (409); corrections after posting are a ledger action, not an edit
RECOVERY --resolve(adopt bill | confirm absent + retry | close)--> POSTED / APPROVED / REJECTED
```

Every transition is one SQL transaction that also writes `audit_log`. Edit, approval and posting intent all take the
same `SELECT … FOR UPDATE` lock on the invoice row, so they serialize. Approval (auto or human) inserts the approval
row, the PO-quantity reservation **and** the outbox row in the same transaction (transactional outbox; ADR-0001).
Recovery resolutions require evidence: `adopt` needs a verified remote Bill; `retry` needs a fresh absent-query and no
attempt younger than the max request time; `close_not_posted` needs a fresh absent-query. A recovery item keeps the
invoice's duplicate-number reservation until resolved.

## 5. Posting protocol (the centerpiece)

Identity:
- `idempotency_key = approval_id` (a new approval row per approval decision; an edit-back to old content gets a new
  approval and therefore a new key, so a cancelled never-sent job can never collide with a re-approval).
- The outbox row stores the **exact serialized Bill payload**, realm and requestid at approval time; the worker sends
  the stored bytes and never recomputes the payload (code changes between retries cannot change what is retried).
- `DocNumber` = vendor invoice number (QBO Bill "Ref no."; max 21 chars — longer numbers are mapped to a stable 21-char
  form and the original goes to `PrivateNote`). Remote identity of a Bill = (VendorRef, DocNumber).
- `requestid` = UUIDv5(idempotency_key). The **same** requestid is reused for every retry of the same job, so QBO's
  server-side dedup applies to retries; a new approval gets a new requestid.
- Correlation marker: every Bill we create carries `PrivateNote = "ipa-ref:<requestid>"`. Adoption requires the marker
  plus equal vendor, DocNumber, date, currency, total and line amounts; a same-DocNumber Bill without our marker is a
  possible manual entry and goes to recovery, never adopted.
- Concurrency invariant: at most one live (pending/in_flight) outbox job per invoice (partial unique index); one
  posting per invoice and one invoice per remote Bill (unique `(realm_id, bill_id)`).

Worker loop:
1. **Claim**: `UPDATE outbox SET status='in_flight', lease_owner=$w, lease_until=now()+lease, claim_gen=claim_gen+1, attempts=attempts+1
   WHERE id IN (SELECT id FROM outbox WHERE (status='pending' AND available_at<=now()) OR (status='in_flight' AND
   lease_until<now()) ORDER BY id LIMIT $n FOR UPDATE SKIP LOCKED) RETURNING *`. Expired leases are how a crashed
   worker's job is picked up again (at-least-once delivery to the handler). **Fencing**: every later write by the
   worker is conditional on `claim_gen = <its generation>`; a stale worker that wakes up after takeover changes nothing
   locally. The lease is at least 3x the HTTP timeout, and a worker refuses to send if its remaining lease is shorter
   than timeout + margin, so a request cannot normally still be in flight when its lease expires (a frozen process is
   the residual case, see below).
2. **Guard** (tx, `SELECT … FOR UPDATE` on the invoice): approval still valid for this content hash? If not, cancel the
   job (edit happened). If a `postings` row exists, mark done (duplicate delivery). Insert a `post_attempts` row with
   outcome NULL and set invoice `POSTING`; commit. This "intent" row is written before any remote call so a crash
   leaves evidence.
3. **Query first, always** (also on the first attempt — this doubles as the pre-existing-Bill check). Query QBO
   `select * from Bill where DocNumber = '<doc>'` and filter by VendorRef:
   - exactly one match carrying our marker and equal posting fields -> **adopt** it (record posting, no write);
   - any match without our marker, with different fields, or more than one match -> `ambiguous_remote` -> recovery
     queue, no write;
   - zero matches -> write with the same requestid (requestid covers query read-after-write lag, see §6);
   - query fails/times out -> back off; after `max_unknown_attempts` -> `unknown_outcome` -> recovery queue.
4. **Write**: `POST /v3/company/{realm}/bill?requestid=<id>&minorversion=75`.
   - 200 -> tx: insert `postings`, attempt `created`, invoice POSTED, outbox done.
   - timeout / connection reset / 5xx -> attempt `unknown`, release job with backoff; next claim goes to step 3.
   - 429 -> attempt `throttled`, backoff with jitter (`Retry-After` honoured); still query-first next time (cheap).
   - 401 -> refresh the token (serialized across workers by a Postgres advisory lock + compare-and-swap on the token
     row, because Intuit rotates refresh tokens) and retry the same request; repeated auth failure opens a circuit
     breaker (worker pauses, jobs stay pending, alert) instead of failing invoices.
   - other 4xx (validation) -> attempt `rejected`, outbox dead, `remote_rejected` -> recovery queue.
5. **Crash anywhere** -> the transaction in flight rolls back; the lease expires; another worker reclaims and the
   attempt row with NULL outcome forces step 3.

Two independent remote defenses, because neither is enough alone:
- `requestid` dedup protects retries while QBO still remembers the id. Intuit does not publish how long it remembers.
- Query-before-retry protects when the requestid memory is gone (or a different requestid would be used), as long as
  the query sees the earlier write.
- Residual risk (documented, tested): requestid memory lost **and** query lag hides the first write. The emulator can
  inject exactly this; the expected result is a duplicate the nightly reconciliation detects (`orphan_remote_bill`),
  i.e. detected-and-queued, not prevented. We report this scenario separately rather than hide it.

## 6. QBO semantics we rely on (to be verified against Intuit docs, cited in docs/QBO_SEMANTICS.md)

- `requestid` query parameter, unique per company (realm), <= 50 chars (36 for batch); a repeated requestid returns the
  original response instead of re-executing.
- DocNumber is not an idempotency key; Intuit recommends querying for the transaction before retrying a failed create.
- minorversion: versions below 75 are no longer supported; we pin `minorversion=75`.
- OAuth 2.0 authorization-code flow; access token ~1 h; refresh token rotates (always persist the newest).
The emulator implements these, plus deliberately pessimistic choices where Intuit is silent (e.g. duplicate DocNumber
on Bills is accepted, requestid memory has a configurable TTL and is lost on restart unless persisted).

## 7. Fault model (what the suite injects)

Worker-side crash points: after claim; after intent commit (before remote write); after remote write returns, before
local commit; after local commit. Remote faults (emulator): 5xx before commit; 5xx after commit; timeout after commit
(response never arrives); 429 storms; latency; read-after-write lag on queries; requestid memory loss; emulator
restart (state persisted, requestid cache optionally dropped). Delivery faults: duplicate outbox delivery (lease
expiry while the first worker is slow), duplicate approval events. Concurrency: 2–8 workers on one queue.
Human faults: edit after approval before posting; edit while posting (must be refused).

Scenario tests (deterministic) cover each fault alone. The **chaos runner** draws a random mix per seed (hundreds of
seeds, fixed list so CI is reproducible) and checks invariants after quiescence + reconciliation:
- I1 zero duplicate bills: at most one ledger Bill per (vendor, DocNumber) — except in the declared residual-risk
  scenario, where duplicates must be detected by reconciliation (counted separately).
- I2 zero lost invoices: every invoice whose valid approval exists ends in POSTED/RECONCILED or in the recovery queue
  with a reason; nothing stuck in POSTING with no live lease.
- I3 ledger == local after reconciliation: every local posting maps to exactly one ledger Bill with equal amount,
  currency, vendor and DocNumber; every ledger Bill created by us maps to one local posting; all differences are in the
  recovery queue.
- I4 no stale-content posting: the posted Bill's payload hash equals the approved content hash.
A **negative control** runs the same seeds with defenses switched off (no requestid, no query-first, no lease guard)
to show the invariants actually fail without them.

## 8. Extraction

Parse: PDF text layer (pdfjs-dist, lines rebuilt from glyph positions); if the text layer is empty/short or the file is
an image, OCR with tesseract.js. Parsed text is cached by document sha256.

LLM: one call per invoice, prompt = schema description + parsed text; output JSON with values and a self-reported
confidence per field; zod-validated; one repair retry on invalid JSON; otherwise the invoice goes to human review with
"extraction failed". Field confidence used for routing is not the raw LLM number: it combines LLM confidence,
grounding (value literally present in the source text after normalization) and arithmetic consistency (lines sum to
subtotal, subtotal + tax + freight = total) via a logistic model fit on a dev split and evaluated on the test split.

Baseline: same parsed text, regex/heuristic extractor (labels like "Invoice No", date patterns, largest amount near
"Total", etc.). Baseline and LLM see identical text, so the comparison isolates the extractor.

## 9. Matching and routing (deterministic)

Inputs: normalized invoice, PO (lines: description, qty, unit price, currency, tax rate, freight allowance), goods
receipts (possibly several partial receipts). Goods lines use 3-way match; service-only invoices use 2-way match (no
receipt), as real AP does. Checks: vendor, currency, PO exists/open, line pairing (description similarity + amount),
unit price within tolerance (default 2% or 1.00 absolute), billed qty <= received qty net of previously billed,
tax within tolerance of PO tax rate, freight within allowance, arithmetic consistency, duplicate invoice number per
vendor. Each check emits a typed discrepancy with severity.

Routing policy (versioned, outside the LLM): REJECT on duplicate invoice or PO for a different vendor; AUTO_APPROVE
only if no discrepancies, every critical field's calibrated confidence >= threshold, amount <= auto-approve cap, vendor
known; otherwise NEEDS_REVIEW. Safe default on any missing signal is NEEDS_REVIEW.

## 10. Data and evals

Documents: two public labelled sets — Invoice Extraction Benchmark v1 (drew-ipp, CC BY 4.0, 181 docs: digital PDFs,
scans, phone photos, handwritten) and the Katana ML "Sparrow" invoices (MIT on the card; derived from Kozłowski &
Weichbroth 2021, Mendeley Data) with line items (qty, unit price). Both are generated by their publishers — not real
company invoices; labels are theirs, not mine. POs/receipts are generated from the label ground truth with controlled,
labelled discrepancies (**Simulated**).

Metrics (docs/EVAL.md): field precision/recall/F1 (LLM vs baseline) with bootstrap CIs and a per-field table; matching
accuracy on discrepancy cases, run twice (ground-truth fields: tests the matcher; extracted fields: end-to-end);
auto-approve rate vs review rate across thresholds with auto-approve precision; cost/latency per invoice; chaos
results; ROI as an assumption model with sensitivity analysis (inputs labelled Simulated).

## 11. What is real vs simulated

Real: documents and labels (public), LLM extraction runs (cached), all fault-injection results, the QBO client code.
Simulated: POs, goods receipts, vendor master, business process, personas, ROI inputs. Not run live: QBO itself (no
Intuit developer account yet) — every posting result is against the emulator.

## 12. Changes after the design review (reviews/design_codex.md, 15 findings)

Accepted: claim-generation fencing (1); lease > 3x timeout and refuse-to-send guard, plus an explicit residual test for
an outstanding request after takeover (2); single invoice lock for edit/approve/intent, outbox bound to approval id and
stored payload (3, 4); correlation marker + full-field adoption check, query-first on every attempt (5, 8); evidence-
based recovery resolutions (6); reconciliation by paginated inventory + per-posting read with unique (realm, bill) and
idempotent discrepancy records (7); liveness checks — after faults stop, every obligation must complete within a bound,
and recovery items must be resolved by the runbook procedure, with the harness keeping its own independent list of
obligations (9); emulator append-only creation log checked for duplicate creations at any time, not only final state
(10); per-defense ablations with deterministic schedules and numeric expectations (11); "emulator-verified" wording and
an assumption matrix with sources (12); PO-line quantity reservations taken at approval under a PO row lock (13);
grouped dev/test split by template family, false-approval rates per discrepancy type (14); separate calibration-fit,
threshold-selection (dev) and test data, counts + Wilson CIs on every rate, and no "exactly once" claims (15).

Rejected / limited: (14) "independently authored hard cases" — there is no second author on this project; hand-written
edge cases are mine and are labelled as such. (12) contract tests against a real sandbox are listed under "needs owner".
