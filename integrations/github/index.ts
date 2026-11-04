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
import { defineConnection } from "landrace/hooks";
import { FORGE_QUERIES } from "./forge.js";
import { ISSUE_QUERIES } from "./issues.js";

export { createClient } from "./client.js";
export { GitHubForge } from "./forge.js";
export { GitHubIssues } from "./issues.js";
export { GitHubPages } from "./pages.js";

/** Every GraphQL document the integration sends, so a test can cost each against GitHub's node limit. */
export const GRAPHQL_QUERIES = { ...ISSUE_QUERIES, ...FORGE_QUERIES };

/**
 * A person's own GitHub token, pasted into the Integrations tab, for a
 * per-person secret to name as `github.token`. Its check asks `GET /user`
 * with it: GitHub's answer to anything but a 2xx is why it does not work.
 */
export const githubConnection = defineConnection({
  id: "github",
  label: "GitHub",
  kind: "credential",
  fields: ["token"],
  paste: { hint: "A personal access token (github.com → Settings → Developer settings → Personal access tokens)" },
  async check(value) {
    const res = await fetch("https://api.github.com/user", {
      headers: { authorization: `Bearer ${value.fields["token"] ?? ""}`, accept: "application/vnd.github+json", "user-agent": "landrace" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return null;
    const why = res.status === 401 ? "GitHub refused the token (401): it is wrong, expired or revoked" : `GitHub answered GET /user with ${res.status}`;
    return `${why}: ${(await res.text()).slice(0, 200)}`;
  },
});

