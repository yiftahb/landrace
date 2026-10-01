/*
 * GitHub, as landrace ships it (`landrace/integrations/github`): Issues as a
 * tracker, pull requests as a forge, and Pages as docs, each on the kit's
 * base for its role and all three over one client. A project's hook file is
 * what `compose` makes of them:
 *
 *   export const { preflight, source, operator, pre, post, spec } = compose({
 *     tracker: new GitHubIssues(),
 *     forge: new GitHubForge({ closingRefs: true }),
 *     docs: new GitHubPages(),
 *   });
 *
 * Built with no client, each role builds one from `ctx.config` — `tracker.repo`,
 * the `githubToken` secret and `tracker.bot` — and the three share it.
 */
import { FORGE_QUERIES } from "./forge.js";
import { ISSUE_QUERIES } from "./issues.js";

export { createClient } from "./client.js";
export { GitHubForge } from "./forge.js";
export { GitHubIssues } from "./issues.js";
export { GitHubPages } from "./pages.js";

/** Every GraphQL document the integration sends, so a test can cost each against GitHub's node limit. */
export const GRAPHQL_QUERIES = { ...ISSUE_QUERIES, ...FORGE_QUERIES };
