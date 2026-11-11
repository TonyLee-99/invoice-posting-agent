# Discovery notes (**Simulated**)

These interviews did not happen. They are a written model of the stakeholders this design assumes, used to make the
scope decisions explicit. Treat every quote as a hypothesis to validate with a real AP team.

## Personas (Simulated)
- **Dana, AP manager, 40-person distributor, QBO Plus.** 600 invoices/month, 2 clerks. "The scary part isn't typing,
  it's the Monday after a sync hiccup when I find the same bill twice and one is already scheduled for payment."
- **Raj, controller (fractional, three clients).** "I need to know at month-end that what's in QuickBooks is what you
  think is in QuickBooks. If they disagree, QuickBooks is right and I want a list."

## Current process (Simulated)
Email inbox → clerk downloads PDF → looks up PO in a spreadsheet, checks the warehouse's receiving log → manager
approves by email reply → clerk keys the Bill → weekly spot check. Duplicates are caught by QBO's duplicate-number
warning only when the vendor reuses the same number format.

## Pains → requirements
| pain (Simulated) | requirement |
|---|---|
| double entry after retries / two people keying | no duplicate Bills under crash/retry/timeout; duplicate-number guard per vendor |
| "approved" invoice changed afterwards | approval bound to content hash; any edit voids it |
| partial deliveries billed in full | quantities checked against receipts net of other approved invoices |
| no idea what the bot did | append-only audit log; every recovery item needs evidence to close |
| ledger edited by hand | nightly reconciliation; ledger wins; differences queued |

## How scope changed after "discovery"
- Dropped: payment scheduling, fraud ML, email ingestion (not where the losses are for this persona).
- Added: recovery queue as a first-class screen; kill switch and shadow mode before any auto-approval.
- Credit notes: post manually (VendorCredit) rather than guess.
