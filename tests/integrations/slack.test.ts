import { loadConfig } from "#config/load.js";
import { slack } from "#landrace/hooks/slack.js";
import { slack as shipped, slackConnection } from "landrace/integrations/slack";
import type { NotifyEvent, RuntimeConfig, RuntimeContext } from "#namespace.js";

const WEBHOOK = "https://hooks.slack.com/services/T000/B000/secretpart";

const event = (over: Partial<NotifyEvent> = {}): NotifyEvent => ({
  event: "needs-you", item: "29", workflow: "fast", workflowName: "Fastlane", title: "Add export",
  link: "https://github.com/acme/widgets/issues/29",
  stage: "screened", why: "blocked by a security check", board: null, ...over,
});

const ctx = (secrets: Record<string, string> = { slackWebhookUrl: WEBHOOK, slackNotifyUser: "U123" }): RuntimeContext => ({
  config: {} as RuntimeConfig, secrets: new Map(Object.entries(secrets)), signal: new AbortController().signal, log: () => {},
});

/** Slack's webhook, as far as this hook can tell: what it was sent, and what it answers. */
function webhook(answer: () => Response = () => new Response("ok")) {
  const sent: Array<{ url: string; init: RequestInit }> = [];
  jest.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    sent.push({ url: String(url), init: init ?? {} });
    return answer();
  });
  const texts = () => sent.map((s) => (JSON.parse(String(s.init.body)) as { text: string }).text);
  return { sent, texts };
}

afterEach(() => jest.restoreAllMocks());

describe("the slack notifier", () => {
  it("posts one line to the webhook, mentioning you, with the item linked and its workflow named", async () => {
    const { sent, texts } = webhook();

    await slack.send(event(), ctx());

    expect(sent.map((s) => [s.url, s.init.method])).toEqual([[WEBHOOK, "POST"]]);
    expect(texts()).toEqual([
      "<@U123> <https://github.com/acme/widgets/issues/29|#29> needs you in Fastlane — Add export · blocked by a security check",
    ]);
  });

  it("links the board too, when one is running", async () => {
    const { texts } = webhook();
    await slack.send(event({ board: "http://127.0.0.1:4545" }), ctx());
    expect(texts()[0]).toMatch(/ · <http:\/\/127\.0\.0\.1:4545\|board>$/);
  });

  it("mentions nobody when no user is configured", async () => {
    const { texts } = webhook();
    await slack.send(event(), ctx({ slackWebhookUrl: WEBHOOK }));
    expect(texts()[0]).toMatch(/^<https:/);
  });

  /*
   * A title is whoever opened the item, and `why` can carry the board's
   * words for it. Unescaped, `<@U999>` pings someone else and `<url|x>` is a
   * link dressed as anything. A workflow's name is escaped the same way.
   */
  it("escapes what it did not write, so a title cannot mention or link", async () => {
    const { texts } = webhook();
    await slack.send(event({ title: "<@U999> <https://evil|x>", why: "a & b", workflowName: "R&D <fast>" }), ctx());
    expect(texts()[0]).toBe(
      "<@U123> <https://github.com/acme/widgets/issues/29|#29> needs you in R&amp;D &lt;fast&gt; — &lt;@U999&gt; &lt;https://evil|x&gt; · a &amp; b",
    );
  });

  it("gives up on a webhook that does not answer, rather than hanging", async () => {
    const { sent } = webhook();
    await slack.send(event(), ctx());
    expect(sent[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws Slack's status and reply on a refusal, never the webhook's URL", async () => {
    webhook(() => new Response("no_service", { status: 404 }));

    const failed = slack.send(event(), ctx());

    await expect(failed).rejects.toThrow("Slack answered 404: no_service");
    await expect(failed).rejects.not.toThrow(/hooks\.slack\.com|secretpart/);
  });

  // Node's fetch quotes a URL it cannot parse — a webhook pasted with a
  // stray space, say — and the URL is the credential.
  it("keeps the webhook's URL out of a failure fetch itself reports", async () => {
    jest.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError(`Failed to parse URL from ${WEBHOOK}`));

    const failed = slack.send(event(), ctx());

    await expect(failed).rejects.toThrow(/could not reach Slack: Failed to parse URL from/);
    await expect(failed).rejects.not.toThrow(/secretpart/);
  });

  it("says which secret is missing rather than posting nowhere", async () => {
    const { sent } = webhook();
    await expect(slack.send(event(), ctx({}))).rejects.toThrow(/slackWebhookUrl/);
    expect(sent).toEqual([]);
  });
});

describe("this repository's own notify", () => {
  it("notifies through slack, and never logs the webhook", async () => {
    const { config } = await loadConfig(".landrace");
    expect(config.notify).toEqual({ on: ["needs-you"], via: ["slack"] });
    expect(config.log.redact).toContain("slackWebhookUrl");
  });
});

// The notifier ships with landrace, as the coding agents do: a project using
// Slack re-exports it rather than keeping a copy of its own to drift.
it("is the notifier landrace ships, re-exported by this project's hook", () => {
  expect(slack).toBe(shipped);
});

/*
 * #183: Slack as a bot — one app token, `slackBotToken`, which posts to the
 * person's own DM and looks up who they are on Slack by their email.
 */
describe("the slack notifier as a bot", () => {
  const BOT = "xoxb-0000-bot-token-for-test";

  function api(answer: (url: string) => unknown) {
    const sent: Array<{ url: string; init: RequestInit }> = [];
    jest.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      sent.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(answer(String(url))), { headers: { "content-type": "application/json" } });
    });
    return sent;
  }

  it("posts chat.postMessage with the bot's token, to the person's member id, and never the webhook", async () => {
    const sent = api(() => ({ ok: true }));
    await slack.send(event(), ctx({ slackBotToken: BOT, slackNotifyUser: "U0123ABCD", slackWebhookUrl: WEBHOOK }));
    expect(sent.map((s) => [s.url, s.init.method])).toEqual([["https://slack.com/api/chat.postMessage", "POST"]]);
    expect((sent[0]?.init.headers as Record<string, string>)["authorization"]).toBe(`Bearer ${BOT}`);
    const body = JSON.parse(String(sent[0]?.init.body)) as { channel: string; text: string };
    expect(body.channel).toBe("U0123ABCD");
    expect(body.text).toMatch(/^<@U0123ABCD> <https:\/\/github\.com\/acme\/widgets\/issues\/29\|#29> needs you in Fastlane/);
  });

  it("throws Slack's own error when it answers ok: false", async () => {
    api(() => ({ ok: false, error: "channel_not_found" }));
    await expect(slack.send(event(), ctx({ slackBotToken: BOT, slackNotifyUser: "U0123ABCD" }))).rejects.toThrow("slack: channel_not_found");
  });

  it("refuses to post with no member id to post to", async () => {
    api(() => ({ ok: true }));
    await expect(slack.send(event(), ctx({ slackBotToken: BOT }))).rejects.toThrow(/slackNotifyUser/);
  });
});

describe("slackConnection", () => {
  const BOT = "xoxb-0000-bot-token-for-test";
  const lookup = (answer: unknown) => {
    const sent: Array<{ url: string; init: RequestInit }> = [];
    jest.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      sent.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(answer));
    });
    return sent;
  };

  it("is an identity looked up by email: the member id users.lookupByEmail answers", async () => {
    const sent = lookup({ ok: true, user: { id: "U0123ABCD" } });
    expect(slackConnection).toMatchObject({ id: "slack", kind: "identity", fields: ["userId"] });
    await expect(slackConnection.resolve?.("dev1+x@example.invalid", ctx({ slackBotToken: BOT }))).resolves.toEqual({ userId: "U0123ABCD" });
    expect(sent[0]?.url).toBe("https://slack.com/api/users.lookupByEmail?email=dev1%2Bx%40example.invalid");
    expect((sent[0]?.init.headers as Record<string, string>)["authorization"]).toBe(`Bearer ${BOT}`);
  });

  it("finds nobody for users_not_found, and throws any other refusal", async () => {
    lookup({ ok: false, error: "users_not_found" });
    await expect(slackConnection.resolve?.("dev1@example.invalid", ctx({ slackBotToken: BOT }))).resolves.toBeNull();
    jest.restoreAllMocks();
    lookup({ ok: false, error: "missing_scope", needed: "users:read.email" });
    await expect(slackConnection.resolve?.("dev1@example.invalid", ctx({ slackBotToken: BOT }))).rejects.toThrow("slack: missing_scope (needs users:read.email)");
  });

  it("cannot look anyone up without a bot token, and says which secret", async () => {
    const sent = lookup({ ok: true });
    await expect(slackConnection.resolve?.("dev1@example.invalid", ctx({}))).rejects.toThrow(/slackBotToken/);
    expect(sent).toEqual([]);
  });
});
