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
import { BASE_URL, createClient, DEFAULT_BASE_URL, statusOf, tokenRejected } from "./client.js";

export { createClient } from "./client.js";
export { GitLab, type GitLabOptions } from "./forge.js";

/**
 * A person's own GitLab token, for a per-person secret to name as
 * `gitlab.token`: pasted into the Integrations tab, or — when the instance
 * has a GitLab OAuth application, its id and secret in `gitlabOauthClientId`
 * and `gitlabOauthClientSecret` — connected with GitLab, on `gitlabBaseUrl`
 * or gitlab.com, and renewed before its two hours are up. Its check asks
 * `GET /user` there with it: a refusal is why it does not work.
 */
export const gitlabConnection = defineConnection({
  id: "gitlab",
  label: "GitLab",
  kind: "credential",
  fields: ["token"],
  paste: { hint: "A personal access token with the api scope (GitLab → Preferences → Access tokens)" },
  oauth(ctx) {
    // An empty value is an unset one, as the client reads it.
    const raw = ctx.secrets.get("gitlabBaseUrl") || DEFAULT_BASE_URL;
    const base = raw.replace(/\/$/, "");
    // The exchange and every renewal post the client secret and a code or
    // refresh token to this base, so it is held to the client's own rule. A
    // base the client refuses answers no app — the paste form, never a
    // Connect link that would send them over plain HTTP — and the client's
    // refusal of it at start says why.
    const usable = BASE_URL.test(raw);
    return {
      authorizeUrl: `${base}/oauth/authorize`,
      tokenUrl: `${base}/oauth/token`,
      clientId: usable ? ctx.secrets.get("gitlabOauthClientId") ?? "" : "",
      clientSecret: usable ? ctx.secrets.get("gitlabOauthClientSecret") ?? "" : "",
      scope: "api",
    };
  },
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

