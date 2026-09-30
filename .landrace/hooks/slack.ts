/*
 * This project's notifier: Slack, as landrace ships it (`integrations/slack/`),
 * told when a ticket needs you. Its two secrets, `slackWebhookUrl` and
 * `slackNotifyUser`, are declared in landrace.yaml; `notify.via` names it.
 *
 * `landrace/integrations/slack` resolves here by Node's package
 * self-reference, as claude.ts's import does: run `pnpm build` before the CLI
 * runs out of this repository.
 */
export { slack } from "landrace/integrations/slack";
