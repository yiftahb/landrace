/*
 * Jira Cloud, as landrace ships it (`landrace/integrations/jira`): one
 * project's issues as a tracker, and one of their fields as its docs, on the
 * kit's bases. A project's hook file composes them beside whatever forge it
 * has:
 *
 *   const tracker = new Jira({ project: "KEY" });
 *   export const { preflight, source, operator, pre, post, spec } = compose({
 *     tracker,
 *     docs: new JiraField({ tracker, field: "customfield_10050" }),
 *   });
 *
 * Configured by the `jiraBaseUrl`, `jiraEmail` and `jiraToken` secrets, and
 * scoped to one developer's issues by the optional `jiraAssignee`.
 *
 * `jiraConnection` is who a person is on Jira — their account id, looked up
 * by their email with those same secrets — for a hook file to export.
 */
import { defineConnection } from "landrace/hooks";
import { clientFor } from "./client.js";
import { accountFor, NoUser } from "./tracker.js";

export { createClient } from "./client.js";
export { JiraField, type JiraFieldOptions } from "./field.js";
export { Jira, type JiraOptions } from "./tracker.js";

/**
 * A person's Jira account, looked up by their email as `jiraAssignee` is:
 * nobody with it is null, and every other refusal — several accounts, the
 * missing "Browse users and groups" permission, Jira refusing the
 * credentials — is Jira's own reason.
 */
export const jiraConnection = defineConnection({
  id: "jira",
  label: "Jira",
  kind: "identity",
  fields: ["accountId"],
  async resolve(email, ctx) {
    try {
      return { accountId: await accountFor(clientFor(ctx), email, "your email") };
    } catch (e) {
      if (e instanceof NoUser) return null;
      throw e;
    }
  },
});

