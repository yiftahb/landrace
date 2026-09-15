import { createGitHubTracker } from "../../src/adapters/github/client.js";

/**
 * Which account we post as is the only thing that separates our control
 * markers from a stranger's, so resolving it is a startup concern and a
 * failure to resolve it is fatal — never a fallback.
 */
const okUser = (login: string) =>
  new Response(JSON.stringify({ login }), { status: 200, headers: { "Content-Type": "application/json" } });

describe("the tracker resolves the login it posts as", () => {
  it("asks GET /user once and caches the answer", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      calls.push(String(url));
      return okUser("landrace-bot");
    }) as unknown as typeof fetch;

    const tracker = createGitHubTracker({ repo: "acme/widgets", token: "t", fetchImpl });
    expect(await tracker.botLogin()).toBe("landrace-bot");
    expect(await tracker.botLogin()).toBe("landrace-bot");
    expect(calls).toEqual(["https://api.github.com/user"]);
  });

  it("verifies a configured bot name against the token rather than trusting it", async () => {
    const fetchImpl = (async () => okUser("Landrace[bot]")) as unknown as typeof fetch;
    const tracker = createGitHubTracker({ repo: "acme/widgets", token: "t", bot: "landrace[bot]", fetchImpl });
    expect(await tracker.botLogin()).toBe("landrace[bot]");
  });

  it("halts naming both logins when the configured name is a typo", async () => {
    // One character wrong in YAML used to switch the whole authorship guard
    // off: our own output stopped counting as ours and every step was
    // re-invoked, forever.
    const fetchImpl = (async () => okUser("landrace-bot")) as unknown as typeof fetch;
    const tracker = createGitHubTracker({ repo: "acme/widgets", token: "t", bot: "landrace-bo", fetchImpl });
    await expect(tracker.botLogin()).rejects.toThrow(/"landrace-bo"[\s\S]*"landrace-bot"/);
  });

  it("falls back to the configured name only when the API cannot answer", async () => {
    // The case the override exists for: a token whose /user is not reachable.
    const fetchImpl = (async () => {
      throw new Error("getaddrinfo ENOTFOUND api.github.com");
    }) as unknown as typeof fetch;
    const tracker = createGitHubTracker({ repo: "acme/widgets", token: "t", bot: "landrace[bot]", fetchImpl });
    expect(await tracker.botLogin()).toBe("landrace[bot]");
  });

  it("refuses to run rather than guess when the login cannot be resolved", async () => {
    const fetchImpl = (async () => new Response("bad credentials", { status: 401 })) as unknown as typeof fetch;
    const tracker = createGitHubTracker({ repo: "acme/widgets", token: "t", fetchImpl });
    await expect(tracker.botLogin()).rejects.toThrow(/cannot resolve the account landrace posts as[\s\S]*tracker\.bot/);
  });

  it("reports the remedy when /user returns a login of the wrong type", async () => {
    // Used to throw "user?.login?.trim is not a function" from outside the
    // guarded path, so the CLI printed a TypeError instead of what to do.
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ login: 42 }), { status: 200, headers: { "Content-Type": "application/json" } })
    ) as unknown as typeof fetch;
    const tracker = createGitHubTracker({ repo: "acme/widgets", token: "t", fetchImpl });
    await expect(tracker.botLogin()).rejects.toThrow(/cannot resolve the account landrace posts as[\s\S]*tracker\.bot/);
  });

  it("refuses a /user response with no login rather than treating it as empty", async () => {
    const fetchImpl = (async () =>
      new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
    const tracker = createGitHubTracker({ repo: "acme/widgets", token: "t", fetchImpl });
    await expect(tracker.botLogin()).rejects.toThrow(/no login/);
  });
});

describe("the repo is an owner/name pair and nothing else", () => {
  const build = (repo: string) => () => createGitHubTracker({ repo, token: "t", bot: "b" });

  it("accepts an ordinary repository", () => {
    expect(build("acme/widgets.js")).not.toThrow();
    expect(build("Acme-Corp/my_repo-2")).not.toThrow();
  });

  for (const repo of ["o/n#x", "o/n?x", "o/n%2Fp", "o@h/n", "o/n/p", "o/", "/n", "o n/x"]) {
    it(`rejects "${repo}", which would silently retarget the requests`, () => {
      expect(build(repo)).toThrow(/owner\/name/);
    });
  }
});
