/*
 * Notion, as landrace ships it (`landrace/integrations/notion`): a project's
 * docs, each ticket's spec a row of the `Landrace specs` database in a page
 * the operator shares with a Notion integration. Beside any tracker and forge:
 *
 *   export const { preflight, source, operator, pre, post, spec } = compose({
 *     tracker: new GitHubIssues(),
 *     forge: new GitHubForge({ closingRefs: true }),
 *     docs: new Notion({ parent: "<the parent page's 32-hex id>" }),
 *   });
 *
 * Built with no client, it builds one from the `notionToken` secret.
 */
export { createClient } from "./client.js";
export type { NotionOptions } from "./client.js";
export { Notion } from "./pages.js";
