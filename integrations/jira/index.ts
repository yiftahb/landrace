/*
 * Jira Cloud, as landrace ships it (`landrace/integrations/jira`): one
 * project's issues as a tracker, on the kit's base. A project's hook file
 * composes it beside whatever forge and docs it has:
 *
 *   export const { preflight, source, operator, pre, post } = compose({
 *     tracker: new Jira({ project: "KEY" }),
 *   });
 *
 * Configured by the `jiraBaseUrl`, `jiraEmail` and `jiraToken` secrets, and
 * scoped to one developer's issues by the optional `jiraAssignee`.
 */
export { Jira, type JiraOptions } from "./tracker.js";
