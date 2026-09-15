import type { Entry } from "../core/types.js";
import { createGitHubTracker, entriesFromComments, githubPostHook, githubPreHook } from "./github/index.js";
import type { PostHook, PreHook } from "../hooks/types.js";
import type { TrackerPort } from "./types.js";

export type { Comment, Issue, TrackerPort } from "./types.js";
export { labelNames } from "./types.js";

export interface TrackerAdapter {
  id: string;
  tracker: TrackerPort;
  pre: PreHook;
  post: PostHook;
  /** How this tracker's records become engine entries. */
  entriesOf(ticket: number): Promise<Entry[]>;
}

/**
 * Adapters are reached by id, never imported. The engine and the operator tools
 * depend on TrackerPort; only this file knows which implementations exist, so a
 * second tracker is a new entry here and nothing else.
 */
export function createTrackerAdapter(
  id: string,
  opts: { repo: string; token: string },
): TrackerAdapter {
  if (id !== "github") {
    throw new Error(`unknown tracker adapter "${id}" — known adapters: github`);
  }
  const tracker = createGitHubTracker(opts);
  return {
    id,
    tracker,
    pre: githubPreHook(tracker),
    post: githubPostHook(tracker),
    entriesOf: async (n) => entriesFromComments(await tracker.listComments(n)),
  };
}
