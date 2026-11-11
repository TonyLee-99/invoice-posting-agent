# Feedback to product / platform

1. **Intuit: publish requestid retention and concurrency semantics.** The docs say a repeated requestid returns the
   original response but not for how long, nor what happens to two concurrent requests. Integrators must add
   query-before-write because of this gap. (`docs/QBO_SEMANTICS.md` rows 5–6.) Live, 2026-11-11: an in-flight twin
   gets 425 with no body, and a requestid's cached response outlives deletion of the Bill it created — so a reused
   requestid silently "succeeds" without creating anything (INC-16). Both deserve a sentence in the docs.
2. **Intuit: a queryable idempotency/correlation field on Bills.** We put a marker in `PrivateNote`, which is not
   filterable, so reconciliation has to page through all Bills to find orphans. A filterable external-reference field
   would make orphan detection O(changes).
3. **Our product: tolerances are a business decision.** The 2% / 1.00 price tolerance and the auto-approval cap should
   be owned and versioned by the AP manager in the UI, with the policy version stamped on every decision (it already is
   in `match.policyVersion`).
4. **Our product: confidence is per field, review is per invoice.** In the eval, most held-but-clean invoices were held
   for one low-confidence field. A "confirm this field" micro-task would cut review time more than raising accuracy.
5. **Our product: the LLM computes differences when not given them.** A vendor-email draft once stated an amount not in
   the findings (a freight excess it computed). Fix shipped: the matcher now provides `overBy`/`difference` facts and the
   grounding check runs on every draft (`results/drafts.json`).
