/**
 * Slack, told when an item needs you — one line per event and no thread.
 *
 * Two ways to post. As a bot, with `slackBotToken` (`xoxb-…`): the line goes
 * to `slackNotifyUser`'s own DM through `chat.postMessage`, and the same token
 * looks up who a person is on Slack by their email, as `slackConnection`. By
 * an incoming webhook, with `slackWebhookUrl`: the line goes to the webhook's
 * channel. The bot wins when both are set. Either credential is redacted
 * from every log line by `log.redact`; `slackNotifyUser` is the member id
 * (`U…`) mentioned so the post pings you.
 */
import { defineConnection, defineNotifier } from "landrace/hooks";
import { httpLimit } from "landrace/kit";
import type { RuntimeContext } from "landrace/hooks";

/** Slack's own three: `<` and `>` make a mention or a link, and `&` starts an entity. */
const escape = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Long enough for a webhook that is merely slow; a send is never awaited by an item either way. */
const TIMEOUT_MS = 5_000;

const API = "https://slack.com/api";

/** What Slack's Web API answers every method with: `ok`, and when it is false, why. */
interface SlackAnswer {
  ok?: boolean;
  error?: string;
  needed?: string;
  user?: { id?: string };
}

/**
 * One Web API call with the bot's token. A refusal is `slack: <error>` in
 * Slack's own words, and the scope it needed when it says. The token is a
 * header, which fetch never quotes, so no failure carries it.
 */
async function call(ctx: RuntimeContext, token: string, method: string, init: { query?: string; body?: unknown }): Promise<SlackAnswer> {
  let res: Response;
  try {
    res = await fetch(`${API}/${method}${init.query ?? ""}`, {
      method: init.body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json; charset=utf-8" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`could not reach Slack: ${e instanceof Error ? e.message : String(e)}`);
  }
  const limit = httpLimit(res.status, res.headers);
  if (limit !== null) ctx.log("integration.limited", { integration: "slack", where: method, ...limit });
  let answer: SlackAnswer;
  try {
    answer = (await res.json()) as SlackAnswer;
  } catch {
    throw new Error(`Slack answered ${method} with ${res.status} and no JSON`);
  }
  if (answer.ok !== true) throw new Error(`slack: ${answer.error ?? `${res.status}, no error named`}${answer.needed ? ` (needs ${answer.needed})` : ""}`);
  return answer;
}

export const slack = defineNotifier({
  id: "slack",
  async send(event, ctx) {
    const bot = ctx.secrets.get("slackBotToken");
    const url = ctx.secrets.get("slackWebhookUrl");
    if (!bot && !url) throw new Error("neither the slackBotToken nor the slackWebhookUrl secret is set");
    const user = ctx.secrets.get("slackNotifyUser");

    const item = /^https?:\/\//i.test(event.link)
      ? `<${escape(event.link)}|#${escape(event.item)}>`
      : `#${escape(event.item)}`;
    const board = event.board ? ` · <${escape(event.board)}|board>` : "";
    const text = `${user ? `<@${user}> ` : ""}${item} needs you in ${escape(event.workflowName)} — ${escape(event.title)} · ` +
      `${escape(event.why)}${board}`;

    if (bot) {
      // A bot posts to a conversation, and the person's member id is their DM with it.
      if (!user) throw new Error("the slackNotifyUser secret is not set, and a bot posts to that member's DM");
      await call(ctx, bot, "chat.postMessage", { body: { channel: user, text } });
      return;
    }
    if (!url) return;

    // Never the URL, which is the credential: fetch quotes one it cannot
    // parse, so its own failure is said with the URL taken out.
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new Error(`could not reach Slack: ${(e instanceof Error ? e.message : String(e)).split(url).join("<slackWebhookUrl>")}`);
    }
    // Where is "webhook", never the URL: the URL is the credential.
    const limit = httpLimit(res.status, res.headers);
    if (limit !== null) ctx.log("integration.limited", { integration: "slack", where: "webhook", ...limit });
    // The status and Slack's own reply: "no_service", "invalid_payload".
    if (!res.ok) throw new Error(`Slack answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  },
});

/**
 * Who a person is on Slack, their member id, looked up by their email with
 * the bot's token — `users.lookupByEmail`, which needs the `users:read.email`
 * scope. Nobody with that email is null; any other refusal is Slack's own
 * reason, and no `slackBotToken` says so.
 */
export const slackConnection = defineConnection({
  id: "slack",
  label: "Slack",
  kind: "identity",
  fields: ["userId"],
  async resolve(email, ctx) {
    const bot = ctx.secrets.get("slackBotToken");
    if (!bot) throw new Error("the slackBotToken secret is not set, so Slack cannot look anyone up by email");
    let answer: SlackAnswer;
    try {
      answer = await call(ctx, bot, "users.lookupByEmail", { query: `?email=${encodeURIComponent(email)}` });
    } catch (e) {
      if (e instanceof Error && e.message === "slack: users_not_found") return null;
      throw e;
    }
    const id = answer.user?.id;
    if (typeof id !== "string" || id === "") throw new Error("slack: users.lookupByEmail answered no member id");
    return { userId: id };
  },
});
