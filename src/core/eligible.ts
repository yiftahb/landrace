import { compile } from "./predicate.js";
import type { Snapshot, Workflow } from "../namespace.js";

/**
 * Eligibility is a decision with a reason, not a query filter. An ineligible
 * ticket must appear in status as skipped, not vanish.
 */
export function checkEligible(
  w: Workflow,
  s: Snapshot,
): { eligible: true } | { eligible: false; reason: string } {
  for (const rule of w.eligible ?? []) {
    if (!compile(rule.when)(s)) return { eligible: false, reason: rule.else };
  }
  return { eligible: true };
}
