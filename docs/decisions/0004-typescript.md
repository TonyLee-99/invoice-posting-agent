# ADR-0004: TypeScript for the service, UI and evals

Status: accepted (2026-11-11)

## Context
One person builds a service, a review UI and an eval harness that share schemas (invoice fields, Bill payload).

## Decision
TypeScript everywhere (Node 24, strict mode, npm workspaces). zod schemas validate LLM output at runtime and give the
types used by matching, the service and the Next.js UI. Packages export `src/index.ts` directly (run with tsx), so there
is no build step to drift.

## Rejected alternative
Python service + TS UI: two schema definitions, two toolchains, and the LLM-output schema would be checked in one
language and consumed in another. Python stays only where it is the external judge: the IPP benchmark's official scorer.

## Consequences
PDF parsing and OCR use pdf.js and tesseract.js instead of the stronger Python stack (docling); OCR on phone photos is
the weakest stage and is reported as such in docs/EVAL.md.
