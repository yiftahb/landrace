import { githubHooks, source } from "#landrace/hooks/github.js";
import type { HookContext, RuntimeContext } from "#namespace.js";

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
