# ADR-0001: Transactional outbox, not two-phase commit

Status: accepted (2026-11-11)

## Context
An approval must lead to exactly one Bill in QuickBooks Online (QBO). Postgres and QBO cannot share a transaction:
QBO's REST API has no prepare/commit protocol, so XA/2PC is not available even if we wanted it.

## Decision
The approval transaction writes the approval, the PO-quantity reservation and an `outbox` row holding the exact Bill
payload and a deterministic `requestid`. Workers deliver outbox rows at least once; the remote side is made idempotent
by (1) QBO's `requestid` dedup and (2) query-before-every-write by DocNumber with an integration marker in `PrivateNote`.

## Rejected alternatives
- **2PC / XA**: not offered by QBO.
- **Call QBO inside the approval request**: a crash after QBO commits but before our commit loses the link; a timeout
  leaves the user with an unknown result. This is exactly fault A2/A4 in `docs/ACCEPTANCE.md`.
- **Outbox alone**: prevents local double-enqueue only. With query-first and stable requestid ablated, the 100-seed
  chaos run produced duplicate Bills on 85 of 100 seeds (`results/chaos.json`, variant `all_off`).

## Consequences
At-least-once delivery means every handler step must be idempotent and fenced (claim generation). Uncertain outcomes
that cannot be resolved go to a human recovery queue instead of being retried blind.
