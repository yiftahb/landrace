import { loadConfig } from "#config/load.js";
import { slack } from "#landrace/hooks/slack.js";
import { slack as shipped } from "landrace/integrations/slack";
import type { NotifyEvent, RuntimeConfig, RuntimeContext } from "#namespace.js";

const WEBHOOK = "https://hooks.slack.com/services/T000/B000/secretpart";

const event = (over: Partial<NotifyEvent> = {}): NotifyEvent => ({
  event: "needs-you", ticket: "29", title: "Add export", link: "https://github.com/acme/widgets/issues/29",
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
  it("posts one line to the webhook, mentioning you, with the ticket linked", async () => {
    const { sent, texts } = webhook();

    await slack.send(event(), ctx());

    expect(sent.map((s) => [s.url, s.init.method])).toEqual([[WEBHOOK, "POST"]]);
    expect(texts()).toEqual([
      "<@U123> <https://github.com/acme/widgets/issues/29|#29> needs you — Add export · blocked by a security check",
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
   * A title is whoever opened the ticket, and `why` can carry the board's
   * words for it. Unescaped, `<@U999>` pings someone else and `<url|x>` is a
   * link dressed as anything.
   */
  it("escapes what it did not write, so a title cannot mention or link", async () => {
    const { texts } = webhook();
    await slack.send(event({ title: "<@U999> <https://evil|x>", why: "a & b" }), ctx());
    expect(texts()[0]).toBe(
      "<@U123> <https://github.com/acme/widgets/issues/29|#29> needs you — &lt;@U999&gt; &lt;https://evil|x&gt; · a &amp; b",
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
