/**
 * Slack, told when a ticket needs you — through an incoming webhook, so one
 * line per event and no thread: a webhook cannot reply to its own post.
 *
 * Two secrets: `slackWebhookUrl`, the webhook, which is the credential and is
 * redacted from every log line; and `slackNotifyUser`, the member id
 * (`U…`) mentioned so the post pings you.
 */
import { defineNotifier } from "landrace/hooks";

/** Slack's own three: `<` and `>` make a mention or a link, and `&` starts an entity. */
const escape = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Long enough for a webhook that is merely slow; a send is never awaited by a ticket either way. */
const TIMEOUT_MS = 5_000;

export const slack = defineNotifier({
  id: "slack",
  async send(event, ctx) {
    const url = ctx.secrets.get("slackWebhookUrl");
    if (!url) throw new Error("the slackWebhookUrl secret is not set");
    const user = ctx.secrets.get("slackNotifyUser");

    const ticket = /^https?:\/\//i.test(event.link)
      ? `<${escape(event.link)}|#${escape(event.ticket)}>`
      : `#${escape(event.ticket)}`;
    const board = event.board ? ` · <${escape(event.board)}|board>` : "";
    const text = `${user ? `<@${user}> ` : ""}${ticket} needs you — ${escape(event.title)} · ${escape(event.why)}${board}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // The status and Slack's own reply ("no_service", "invalid_payload") —
    // never the URL, which is the credential.
    if (!res.ok) throw new Error(`Slack answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  },
});
