/*
 * `landrace/kit`: what an integration builds on, whichever role it plays.
 *
 * `BaseExecutor` for a coding agent; for a tracker, a forge or a docs
 * integration, the code every one of them shares and none of them is — its
 * own comments told from a stranger's, each effect's `satisfied()`, tickets
 * and pull requests as nodes, review threads and briefings, the spec page,
 * and git in the operator's checkout. An integration keeps what is its
 * vendor's: the API client, its queries and shapes, and the mapping from
 * them into the plain shapes here.
 */
export * from "#kit/executor.js";
export * from "#kit/docs.js";
export * from "#kit/forge.js";
export * from "#kit/git.js";
export * from "#kit/tracker.js";

export type {
  BranchHeads, ChangedFile, Finding, Git, Reply, ReviewThread, SnapshotComment, ThreadComment, ThreadCounts,
} from "#namespace.js";
