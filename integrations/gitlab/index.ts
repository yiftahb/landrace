/*
 * GitLab, as landrace ships it (`landrace/integrations/gitlab`): merge
 * requests as a forge, on the kit's base. A project's hook file composes it
 * beside its tracker:
 *
 *   export const { preflight, source, operator, pre, post } = compose({
 *     tracker: new MyTracker(),
 *     forge: new GitLab({ project: "group/app" }),
 *   });
 *
 * Configured by the `gitlabToken` secret and, off gitlab.com, `gitlabBaseUrl`.
 */
import { defineConnection } from "landrace/hooks";
import { createClient, statusOf, tokenRejected } from "./client.js";

export { createClient } from "./client.js";
export { GitLab, type GitLabOptions } from "./forge.js";

/**
 * A person's own GitLab token, pasted into the Integrations tab, for a
 * per-person secret to name as `gitlab.token`. Its check asks `GET /user`
 * on `gitlabBaseUrl`, or gitlab.com, with it: a refusal is why it does not work.
 */
export const gitlabConnection = defineConnection({
  id: "gitlab",
  label: "GitLab",
  kind: "credential",
  fields: ["token"],
  paste: { hint: "A personal access token with the api scope (GitLab → Preferences → Access tokens)" },
  async check(value, ctx) {
    // Any project path will do: `/user` is not under one.
    const client = createClient({ project: "landrace/check", token: value.fields["token"] ?? "", baseUrl: ctx.secrets.get("gitlabBaseUrl") || undefined });
    try {
      await client.user();
      return null;
    } catch (e) {
      const rejected = tokenRejected(e);
      if (rejected !== null) return rejected.message;
      if (statusOf(e) !== undefined) return e instanceof Error ? e.message : String(e);
      throw e;
    }
  },
});

