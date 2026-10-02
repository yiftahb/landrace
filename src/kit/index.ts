/*
 * `landrace/kit`: what an integration builds on, whichever role it plays.
 *
 * `BaseExecutor` for a coding agent; `BaseTracker`, `BaseForge` and
 * `BaseDocs` for a tracker, a forge or a docs integration, which write their
 * vendor's calls and nothing else, and `compose`, which makes a project's
 * three into the hooks its hook file exports. Beside them, the code every
 * integration shares — its own comments told from a stranger's, each
 * effect's `satisfied()`, items and pull requests as nodes, review threads
 * and briefings, the spec page, and git in the operator's checkout — for an
 * integration that is not built on a base.
 */
export * from "#kit/executor.js";
export * from "#kit/compose.js";
export * from "#kit/docs.js";
export * from "#kit/forge.js";
export * from "#kit/git.js";
export * from "#kit/tracker.js";

export type {
  BranchHeads, BriefTable, ChangedFile, CheckCounts, CheckState, ComposedHooks, EffectHandler, EffectTable, FailedCheck, Finding,
  Git, HistoryItem, MergeAnswer, PullRecord, Reply, ReviewThread, Roles, SnapshotComment, ThreadComment, ThreadCounts, ItemRecord,
  TrackerComment,
} from "#namespace.js";
