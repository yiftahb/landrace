/*
 * Jira Cloud, as landrace ships it (`landrace/integrations/jira`): one
 * project's issues as a tracker, and one of their fields as its docs, on the
 * kit's bases. A project's hook file composes them beside whatever forge it
 * has:
 *
 *   export const { preflight, source, operator, pre, post, spec } = compose({
 *     tracker: new Jira({ project: "KEY" }),
 *     docs: new JiraField({ project: "KEY", field: "customfield_10050" }),
 *   });
 *
 * Configured by the `jiraBaseUrl`, `jiraEmail` and `jiraToken` secrets, and
 * scoped to one developer's issues by the optional `jiraAssignee`.
 */
export { JiraField, type JiraFieldOptions } from "./field.js";
export { Jira, type JiraOptions } from "./tracker.js";
