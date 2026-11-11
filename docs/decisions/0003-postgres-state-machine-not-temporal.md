# ADR-0003: Postgres state machine + SKIP LOCKED workers, not Temporal

Status: accepted (2026-11-11)

## Context
The workflow has ~10 states, one external side effect (create Bill) and human waits measured in days.

## Decision
Invoice status lives in Postgres with a trigger-enforced transition table; every transition is audited. Workers claim
outbox rows with `FOR UPDATE SKIP LOCKED` and a lease; a claim generation fences stale workers. Human waits are just
rows in `NEEDS_REVIEW`.

## Rejected alternative
Temporal (durable execution). It would give retries and timers, but not remote idempotency: an activity that times
out after QBO committed is retried exactly like ours, so requestid + query-first would still be needed. It adds a
cluster to operate and a second source of truth next to the database the review UI reads. One database keeps the
state, the audit log and the queue in one transaction.

## Consequences
We own lease/backoff/fencing code (about 300 lines, covered by `services/posting/test/faults.test.ts`, the ablation
tests and the chaos runner). At much higher volume (100x) the outbox table needs partitioning or a broker; see RUNBOOK.
