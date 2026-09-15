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

  it("uses a configured bot name without calling the API", async () => {
    const fetchImpl = (async () => {
      throw new Error("must not be called");
    }) as unknown as typeof fetch;
    const tracker = createGitHubTracker({ repo: "acme/widgets", token: "t", bot: "landrace[bot]", fetchImpl });
    expect(await tracker.botLogin()).toBe("landrace[bot]");
  });

  it("refuses to run rather than guess when the login cannot be resolved", async () => {
    const fetchImpl = (async () => new Response("bad credentials", { status: 401 })) as unknown as typeof fetch;
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
