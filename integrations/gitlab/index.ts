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
export { createClient } from "./client.js";
export { GitLab, type GitLabOptions } from "./forge.js";
