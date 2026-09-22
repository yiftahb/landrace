import { githubHooks, source } from "#landrace/hooks/github.js";
import type { HookContext, RuntimeContext } from "#namespace.js";
import { createFakeTracker } from "#tests/support/fake-tracker.js";
import type { FakeTracker } from "#tests/support/fake-tracker.js";

/**
 * The shipped integration's own rules, driven through the hooks the loader
 * would pick up rather than through anything private to the file.
 *
 * Which account we post as is the only thing separating our control markers
 * from a stranger's, so resolving it is a precondition of every request and a
 * failure to resolve it is fatal — never a fallback. This used to be a startup
 * check in the engine, which is now the wrong place for it: the engine has no
 * idea what a login is.
 */
const ctx = {} as RuntimeContext;
const ticketCtx = { ticket: 1 } as HookContext;

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

/** A fake GitHub that records the order its endpoints were asked for. */
function fake(user: () => Response | never): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL): Promise<Response> => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.pathname === "/user") return user();
    if (/\/issues\/\d+$/.test(url.pathname)) {
      return json({ number: 1, title: "t", body: "", state: "open", html_url: "u", labels: [] });
    }
    return json([]);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const ok = (login: string) => () => json({ login });

const build = (opts: { bot?: string; user: () => Response | never }) => {
  const { fetchImpl, calls } = fake(opts.user);
  return {
    calls,
    hooks: githubHooks({ repo: "acme/widgets", token: "t", fetchImpl, ...(opts.bot ? { bot: opts.bot } : {}) }),
  };
};

describe("the hook resolves the login it posts as", () => {
  it("asks GET /user once and caches the answer", async () => {
    const { hooks, calls } = build({ user: ok("landrace-bot") });
    await hooks.source.list(ctx);
    await hooks.source.list(ctx);
    expect(calls.filter((p) => p === "/user")).toEqual(["/user"]);
  });

  /*
   * The ordering rule, not decoration: an unresolved login makes our own
   * markers read as a stranger's, so the engine believes no step has ever run
   * and pays for every one of them again on every tick. Nothing may touch the
   * repository before we know who we are.
   */
  it("asks who we are before it touches the repository", async () => {
    const { hooks, calls } = build({ user: ok("landrace-bot") });
    await hooks.source.list(ctx);
    expect(calls[0]).toBe("/user");
  });

  it("records the resolved login in the snapshot, for the post hook to check effects against", async () => {
    const { hooks } = build({ user: ok("landrace-bot") });
    const fragment = await hooks.pre.run(ticketCtx);
    expect(fragment.tracker).toEqual({ bot: "landrace-bot" });
    expect(hooks.pre.provides).toContain("tracker.bot");
  });

  it("verifies a configured bot name against the token rather than trusting it", async () => {
    const { hooks } = build({ bot: "landrace[bot]", user: ok("Landrace[bot]") });
    expect((await hooks.pre.run(ticketCtx)).tracker).toEqual({ bot: "landrace[bot]" });
  });

  it("halts naming both logins when the configured name is a typo", async () => {
    // One character wrong in YAML used to switch the whole authorship guard
    // off: our own output stopped counting as ours and every step was
    // re-invoked, forever.
    const { hooks } = build({ bot: "landrace-bo", user: ok("landrace-bot") });
    await expect(hooks.source.list(ctx)).rejects.toThrow(/"landrace-bo"[\s\S]*"landrace-bot"/);
  });

  it("falls back to the configured name only when the API cannot answer", async () => {
    // The case the override exists for: a token whose /user is not reachable.
    const { hooks } = build({
      bot: "landrace[bot]",
      user: () => { throw new Error("getaddrinfo ENOTFOUND api.github.com"); },
    });
    expect((await hooks.pre.run(ticketCtx)).tracker).toEqual({ bot: "landrace[bot]" });
  });

  it("refuses to run rather than guess when the login cannot be resolved", async () => {
    const { hooks } = build({ user: () => new Response("bad credentials", { status: 401 }) });
    await expect(hooks.source.list(ctx))
      .rejects.toThrow(/cannot resolve the account landrace posts as[\s\S]*tracker\.bot/);
  });

  it("reports the remedy when /user returns a login of the wrong type", async () => {
    // Used to throw "user?.login?.trim is not a function" from outside the
    // guarded path, so the CLI printed a TypeError instead of what to do.
    const { hooks } = build({ user: () => json({ login: 42 }) });
    await expect(hooks.source.list(ctx))
      .rejects.toThrow(/cannot resolve the account landrace posts as[\s\S]*tracker\.bot/);
  });

  it("refuses a /user response with no login rather than treating it as empty", async () => {
    const { hooks } = build({ user: () => json({}) });
    await expect(hooks.source.list(ctx)).rejects.toThrow(/no login/);
  });
});

/**
 * Who a ticket belongs to, which is what lets several instances share one
 * repository: each takes the tickets assigned to it and skips the rest.
 *
 * A list, because GitHub's issue has a list — `assignees[]`. The singular
 * `assignee` it also returns is that list's first element under a second name,
 * and a second spelling of one fact is the mistake `ticket.stage` already was
 * here: the two disagree the moment an issue has two assignees, and nothing
 * says which of them a predicate is reading.
 */
describe("who a ticket is assigned to", () => {
  const fragmentOf = async (assignees: Array<{ login: string }>): Promise<Record<string, unknown>> => {
    const gh = createFakeTracker([{ number: 1, assignees }]);
    const hook = gh.registry.pre[0];
    if (!hook) throw new Error("the fake tracker registered no pre hook");
    return hook.run({ ...gh.ctx, ticket: 1, snapshot: {} } as HookContext);
  };
  const ticketOf = async (assignees: Array<{ login: string }>): Promise<Record<string, unknown>> =>
    (await fragmentOf(assignees)).ticket as Record<string, unknown>;

  it("carries every login of a multi-assignee issue, in a list", async () => {
    expect((await ticketOf([{ login: "ann" }, { login: "bo" }])).assignees).toEqual(["ann", "bo"]);
  });

  /*
   * Empty, never absent. `$in` over a missing path and `$in` over an empty
   * list both fail to match, but only one of them is a path `validate` can
   * cover and `missingPaths` can answer for — and an eligibility rule the
   * tick cannot answer abstains, which would work an unassigned ticket
   * belonging to nobody.
   */
  it("carries an empty list for an unassigned issue rather than nothing at all", async () => {
    expect((await ticketOf([])).assignees).toEqual([]);
  });

  it("spells it once: there is no singular assignee beside the list", async () => {
    const ticket = await ticketOf([{ login: "ann" }]);
    expect(Object.hasOwn(ticket, "assignee")).toBe(false);
  });
});

describe("the repo is an owner/name pair and nothing else", () => {
  const make = (repo: string) => () => githubHooks({ repo, token: "t", bot: "b" });

  it("accepts an ordinary repository", () => {
    expect(make("acme/widgets.js")).not.toThrow();
    expect(make("Acme-Corp/my_repo-2")).not.toThrow();
  });

  // "." is legal inside a name, so the class that allows "my.repo" also
  // allowed a ".." segment, which WHATWG URL normalisation collapses before
  // the request goes out: "../user" reached a real, different endpoint.
  for (const repo of ["o/n#x", "o/n?x", "o/n%2Fp", "o@h/n", "o/n/p", "o/", "/n", "o n/x",
                      "o/..", "../x", "../user", "o/.", ".git/x", "o/.hidden"]) {
    it(`rejects "${repo}", which would silently retarget the requests`, () => {
      expect(make(repo)).toThrow(/owner\/name/);
    });
  }
});

/**
 * What the loader actually picks up: the same hooks, built from the context
 * instead of from explicit options. A hook is handed its configuration and its
 * secrets rather than constructed with them, so a missing one is a runtime
 * failure and has to name what is missing.
 */
describe("the hook reads its configuration out of the context", () => {
  const withConfig = (tracker: unknown, secrets: Array<[string, string]> = []): RuntimeContext =>
    ({
      config: { tracker } as RuntimeContext["config"],
      secrets: new Map(secrets),
      signal: new AbortController().signal,
      log: () => {},
    });

  it("names the config key when the repository is not set", async () => {
    await expect(source.list(withConfig({}, [["githubToken", "t"]]))).rejects.toThrow(/tracker\.repo/);
  });

  it("names the secret when the token is not declared", async () => {
    await expect(source.list(withConfig({ repo: "acme/widgets" }))).rejects.toThrow(/githubToken/);
  });
});

/**
 * GitHub's own comment limit, which is the hook's to know.
 *
 * The engine bounds what a *step* may write before it gets here, and does it
 * tracker-agnostically. This is the backstop under that, for every body the
 * engine did not compose — an operator's `landrace_reply`, a conversation
 * turn — and it exists because the alternative is a 422 at apply time, which
 * throws, writes nothing durable, and leaves the next tick re-deriving the
 * stage as pending and paying for it again.
 */
describe("a comment body larger than GitHub will take", () => {
  const client = () => build({ user: ok("landrace-bot") });

  it("is refused with GitHub's own number, before the request goes out", async () => {
    const { hooks, calls } = client();
    const ctxWithTicket = { ...ticketCtx } as HookContext;
    await expect(
      hooks.post.apply({ type: "tracker.comment", body: "x".repeat(65_537) }, ctxWithTicket),
    ).rejects.toThrow(/65536/);
    expect(calls.filter((p) => p.endsWith("/comments"))).toEqual([]);
  });

  it("posts one that fits", async () => {
    const { hooks, calls } = client();
    await hooks.post.apply({ type: "tracker.comment", body: "x".repeat(60_000) }, { ...ticketCtx } as HookContext);
    expect(calls.filter((p) => p.endsWith("/comments"))).toHaveLength(1);
  });
});

/**
 * A ticket's whole position is one label, and `tracker.status` writes it with
 * more than one request — so there is a window in the middle, and the only
 * question is what the ticket looks like inside it.
 *
 * Removing first left *zero* stage labels there, which the engine read as a
 * new ticket and restarted from the entry stage, discarding a run that was
 * still sitting on the ticket in full. Adding first leaves two, which every
 * surface in the engine already refuses to place — a halt, not a wrong move,
 * and the next status apply cleans the loser up on its own.
 */
describe("moving the position is a swap, and a swap has a window", () => {
  const statusOn = async (gh: FakeTracker, value: string): Promise<void> => {
    const post = gh.registry.post[0];
    if (!post) throw new Error("the fake tracker registered no post hook");
    await post.apply({ type: "tracker.status", value }, { ticket: 1 } as HookContext);
  };

  const labelCalls = (gh: FakeTracker) =>
    gh.requests.filter((r) => r.path.startsWith("/issues/1/labels")).map((r) => r.method);

  it("adds the new stage label before it removes the old one", async () => {
    const gh = createFakeTracker([{ number: 1, labels: ["lr:auto", "lr:stage:spec"] }]);
    await statusOn(gh, "build");

    expect(labelCalls(gh)).toEqual(["POST", "DELETE"]);
    expect(gh.labelsOf(1)).toEqual(["lr:auto", "lr:stage:build"]);
  });

  it("leaves two labels rather than none when the removal never lands", async () => {
    const gh = createFakeTracker([{ number: 1, labels: ["lr:auto", "lr:stage:spec"] }]);
    gh.breakOn((r) => r.method === "DELETE" && r.path.startsWith("/issues/1/labels/"), 500);

    await expect(statusOn(gh, "build")).rejects.toThrow();
    expect(gh.labelsOf(1)).toEqual(expect.arrayContaining(["lr:stage:spec", "lr:stage:build"]));
  });

  it("and the ticket is still placeable when the add is what fails", async () => {
    const gh = createFakeTracker([{ number: 1, labels: ["lr:auto", "lr:stage:spec"] }]);
    gh.breakOn((r) => r.method === "POST" && r.path === "/issues/1/labels", 500);

    await expect(statusOn(gh, "build")).rejects.toThrow();
    expect(gh.labelsOf(1)).toEqual(["lr:auto", "lr:stage:spec"]);
  });
});
