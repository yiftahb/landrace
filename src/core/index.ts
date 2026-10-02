/* Values only: core's types are declared in `src/namespace.ts`, like every
 * other type in the system, and callers take them from there. */
export { compile, assertAllowedOperators, pathsIn, missingPaths, ALLOWED_OPERATORS } from "#core/predicate.js";
export { deriveRun, locatedRun } from "#core/derive.js";
export { canonicalize, hashSnapshot } from "#core/normalize.js";
export { checkEligible, eligibilityOfNode, pathsNoNodeCarries } from "#core/eligible.js";
export { cannotPlace, locate, locateNode, placedByState, UNPLACED, writesNothing } from "#core/locate.js";
export { assess } from "#core/assess.js";
export { decide } from "#core/decide.js";
export { expandEffectFields, fillTemplate, planEffects, stageBranch } from "#core/plan.js";
export { planNodesClose, staleClosure } from "#core/children.js";
export { reconcile } from "#core/reconcile.js";
export { deriveRel } from "#core/rel.js";
export { gotoDeclined, gotoNotListed, gotoTargetsOf } from "#core/goto.js";
export { claimItems } from "#core/claims.js";
