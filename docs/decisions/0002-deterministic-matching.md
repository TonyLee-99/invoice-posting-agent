# ADR-0002: Deterministic 3-way matching; the LLM only reads and explains

Status: accepted (2026-11-11)

## Context
Matching an invoice to a PO and goods receipts decides whether money is committed. Controllers need to know why an
invoice passed, and auditors need the same answer next year.

## Decision
`packages/matching` is plain code: tolerances (2% or 1.00 per line), partial receipts summed, quantities reserved by
other approvals subtracted, tax rate and freight allowance checks, duplicate guard. The routing policy (thresholds, cap,
kill switch) is versioned config. The LLM extracts fields (with confidence) and writes advisory explanations and vendor
email drafts from the deterministic findings; it never sets a decision. A failed extraction routes to a person.

## Rejected alternative
LLM-as-matcher (the reference AWS sample uses a "Match Agent" on Bedrock). Not reproducible, not unit-testable at the
tolerance boundary, and a prompt change could silently change approvals. Our matcher reproduces its expected outcome on
every labelled case when fed label fields (`results/routing.json`, `matcherOnLabels`).

## Consequences
Matching rules are a product surface (who owns tolerances?). Extraction errors still propagate into matching; that is
measured separately (`endToEndOnExtracted`).
