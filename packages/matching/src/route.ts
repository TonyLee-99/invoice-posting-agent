import type { ScalarField } from "@ipa/domain";
import { CRITICAL_FIELDS } from "@ipa/domain";
import type { Discrepancy, MatchResult } from "./match.ts";

export type Decision = "AUTO_APPROVE" | "NEEDS_REVIEW" | "REJECT";

export interface RoutingPolicy {
  version: string;
  /** Calibrated per-field confidence every critical field must reach for auto-approval. */
  minFieldConfidence: number;
  /** Auto-approval cap in minor units of the invoice currency (larger invoices always get a human). */
  autoApproveCapMinor: number;
  /** Kill switch / shadow mode: when false nothing is auto-approved (ROLLOUT phase 0). */
  autoApproveEnabled: boolean;
}

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  version: "route-2026-11-11",
  minFieldConfidence: 0.9,
  autoApproveCapMinor: 1_000_000,
  autoApproveEnabled: true,
};

export interface RouteInput {
  match: MatchResult;
  totalMinor: number | null;
  /** Calibrated confidence per field; null when extraction failed or the invoice was keyed by a person. */
  confidence: Partial<Record<ScalarField, number>> | null;
  /** Human-edited invoices were checked by a person; confidence gating does not apply to them. */
  humanVerified?: boolean;
}

export interface RouteResult {
  decision: Decision;
  reasons: Discrepancy[];
  policyVersion: string;
}

/**
 * Policy lives in code, not in the model. Safe default: anything not explicitly clean goes to a person.
 * REJECT is reserved for cases where posting would be wrong regardless of review (duplicates, non-invoices).
 */
export function route(input: RouteInput, policy: RoutingPolicy = DEFAULT_ROUTING_POLICY): RouteResult {
  const reasons = [...input.match.discrepancies];
  if (reasons.some((r) => r.severity === "block")) return { decision: "REJECT", reasons, policyVersion: policy.version };
  if (!input.humanVerified) {
    if (!input.confidence) {
      reasons.push({ code: "low_confidence", severity: "review", message: "No field confidence available (extraction failed or incomplete).", facts: {} });
    } else {
      for (const f of CRITICAL_FIELDS) {
        const c = input.confidence[f];
        if (c === undefined || c < policy.minFieldConfidence) {
          reasons.push({ code: "low_confidence", severity: "review", message: `Low confidence in ${f} (${c === undefined ? "n/a" : c.toFixed(2)} < ${policy.minFieldConfidence}).`, facts: { field: f, confidence: c ?? null, threshold: policy.minFieldConfidence } });
        }
      }
    }
  }
  if (input.totalMinor !== null && Math.abs(input.totalMinor) > policy.autoApproveCapMinor) {
    reasons.push({ code: "amount_over_cap", severity: "review", message: `Total ${input.totalMinor / 100} is above the auto-approval cap ${policy.autoApproveCapMinor / 100}.`, facts: { total: input.totalMinor / 100, cap: policy.autoApproveCapMinor / 100 } });
  }
  const needsReview = reasons.some((r) => r.severity === "review") || !policy.autoApproveEnabled;
  return { decision: needsReview ? "NEEDS_REVIEW" : "AUTO_APPROVE", reasons, policyVersion: policy.version };
}
