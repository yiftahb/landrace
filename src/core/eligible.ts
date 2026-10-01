import { compile, missingPaths } from "#core/predicate.js";
import type { Eligibility, Node, Snapshot, Workflow } from "#namespace.js";

/**
 * Eligibility is a decision with a reason, not a query filter. An ineligible
 * item must appear in status as skipped, not vanish.
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

/**
 * What a listed node can answer about itself, without a network round trip.
 *
 * Position, eligibility and whose turn it is are all labels, and an item node
 * carries its labels in `state` precisely so this question costs nothing:
 * building a snapshot to find out an item is not ours would mean reading
 * every issue in the repository on every tick.
 *
 * Whose item it is rides along for the same reason and under the same name
 * the snapshot gives it. It is not a label, but it is asked at the same
 * moment, and a rule the node cannot answer abstains — which is what made
 * an instance filtered to one developer read the whole repository anyway.
 */
const nodeSnapshot = (node: Node): Snapshot => ({ node });

/**
 * Whether the tick should work an item, decided from the workflow's own
 * eligibility rule rather than from a label name hard-coded here — the
 * workflow owns what "eligible" means, and `landrace status` prints its `else`
 * verbatim as the reason an item was skipped.
 *
 * Abstains rather than guesses. A rule reading anything a listed node cannot
 * carry — a derived counter, a step's output — is unanswerable from labels
 * alone, and the two ways of guessing are both bad: "ineligible" silently
 * parks every item in the repository, and a wrong "eligible" is only a
 * wasted snapshot, which converge then decides on properly. So an
 * unanswerable rule set means work it and let `decide` say.
 *
 * `checkEligible` does the actual evaluating, rather than a second copy of it
 * here: two implementations of one rule is how a validator and an engine come
 * to disagree about where an item is.
 */
export function eligibilityOfNode(workflow: Workflow, node: Node): Eligibility {
  const snapshot = nodeSnapshot(node);
  const unanswerable = (workflow.eligible ?? []).some((rule) => missingPaths(rule.when, snapshot).length > 0);
  return unanswerable ? { eligible: true } : checkEligible(workflow, snapshot);
}
