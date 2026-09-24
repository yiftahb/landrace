/**
 * `landrace/testing`: what a workflow author needs to drive their own workflow
 * without a tracker, a network or a model.
 *
 * The engine ships no integrations, and this is not one. `createExternalState`
 * speaks the conventions — the labels, the marker format, the three writes a
 * tracker owns — and knows no vendor; a real integration is tested over its
 * own HTTP boundary, with the real hooks, because a second hand-written copy
 * of a hook is free to disagree with it. What ships here is the part that is
 * the same whatever the tracker: a scripted agent, and a harness that drives
 * converge and writes down where the ticket went and what it was paid for.
 */
export { createHarness } from "#testing/harness.js";
export { createExternalState, staticSource } from "#testing/external-state.js";
export { scriptedExecutor } from "#testing/scripted.js";
