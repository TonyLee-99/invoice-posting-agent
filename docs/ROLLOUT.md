# Rollout plan

## Phase 0 — shadow (2 weeks)
`autoApproveEnabled=false` (routing kill switch). Everything goes to review; the system still extracts, matches and
records what it *would* have decided. Compare its decisions with the clerks' on every invoice.
Exit: auto-approve precision on shadow traffic >= 98% with >= 200 would-be auto-approvals; zero duplicate or lost
postings; reconciliation clean for 10 consecutive nights.

## Phase 1 — limited auto-approval
Auto-approve only: known vendors with >= 3 prior clean invoices, total <= $1,000 cap, confidence >= 0.95.
Guardrails (alert, and the controller can flip the kill switch): any duplicate detected by reconciliation; recovery
queue older than 24 h; auto-approval reversal rate > 1% per week; extraction schema-failure rate > 2%.

## Phase 2 — ramp
Raise cap to $5,000, threshold to the value chosen on shadow data (not on the eval set), add vendors weekly. Each step
needs a week of guardrails green and controller sign-off recorded in the change log.

## Kill switch
`RoutingPolicy.autoApproveEnabled=false` stops auto-approval immediately; posting of human-approved invoices continues.
Stopping workers stops all posting; nothing is lost (outbox rows wait).

## Handover checklist
- [ ] Intuit app credentials stored in the secret manager; refresh-token rotation alert configured
- [ ] Tolerances and cap signed off by the AP manager (owner of `MatchPolicy`)
- [ ] Recovery-queue on-call named; RUNBOOK walkthrough done
- [ ] Reconciliation schedule and alert channel set
- [ ] Contract checks against the sandbox for the unknown rows in `docs/QBO_SEMANTICS.md`
