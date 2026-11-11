# PRD: Recoverable invoice posting

## Problem
AP teams key vendor invoices into QuickBooks Online by hand: read the PDF, check it against the PO and the goods
receipt, get approval, enter a Bill. Automating the reading is easy; what costs money is the write: a Bill entered
twice is paid twice, and an invoice that silently never reaches the ledger becomes a late fee and an angry vendor.

## Users
- **AP clerk** (primary): works the review queue; fixes misread fields; sends vendor queries.
- **AP manager / approver**: approves held invoices; owns tolerances and the auto-approval cap.
- **Controller**: owns month-end; works the recovery queue and reconciliation differences; signs off rollout ramps.

## What it does
Upload PDF/image → parse (text layer, OCR fallback) → LLM field extraction with per-field confidence (zod-validated)
→ deterministic 2-/3-way match against PO + receipts → route (auto-approve / review / reject) → approval bound to a
content hash → transactional outbox → worker posts the Bill to QBO with a stable requestid after querying first →
nightly reconciliation against the ledger → recovery queue for anything uncertain.

## Success metrics (and where they are measured)
| metric | target | measured |
|---|---|---|
| Duplicate Bills under injected faults | 0 | `results/chaos.json` (300 seeds) + fault suite |
| Lost invoices (approved, never posted, not in recovery) | 0 | same |
| Auto-approval precision (critical fields right and match truly clean) | >= 98% | `results/routing.json` |
| Field extraction F1 vs regex baseline | +0.15 | `results/extraction.json` |
| Share of invoices needing a person | reported, ramped per ROLLOUT | `results/routing.json` |
| Cost per invoice (LLM, list-price equivalent) | < $0.01 | `results/cost.json` |

## Non-goals
Payments, vendor onboarding / bank-detail changes, fraud scoring, email ingestion, multi-entity consolidation,
VendorCredit posting (credit notes are rejected to a manual path), Temporal, cloud infrastructure.

## Acceptance
`docs/ACCEPTANCE.md` (fixed before building; PASS/FAIL with evidence at the end).
