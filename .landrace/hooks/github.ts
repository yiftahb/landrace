/*
 * This project's tracker, forge and docs: GitHub's issues, pull requests and
 * Pages, as landrace ships them (`integrations/github/`), made into this
 * project's hooks by the kit's `compose` — one source, operator, pre and post
 * hook under the id `project`, and the spec artifact. Configured by
 * `tracker.repo`, the `githubToken` secret and `tracker.bot` in
 * landrace.yaml; git runs in the repository this file is in.
 *
 * `landrace/kit` and `landrace/integrations/github` resolve here by Node's
 * package self-reference: run `pnpm build` before the CLI runs out of this
 * repository.
 */
import { compose } from "landrace/kit";
import { GitHubForge, GitHubIssues, GitHubPages } from "landrace/integrations/github";

export const { preflight, source, operator, pre, post, spec } = compose({
  tracker: new GitHubIssues(),
  forge: new GitHubForge({ closingRefs: true }),
  docs: new GitHubPages(),
});
