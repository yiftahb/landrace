import { createHash } from "node:crypto";
import { createFakeTracker, noBranches, type FakePages, type FakeTracker } from "#tests/support/fake-tracker.js";
import { githubHooks } from "#landrace/hooks/github.js";
import type { ArtifactHook, Effect, Graph, HookContext, Snapshot } from "#namespace.js";

/**
 * The spec artifact, over the in-memory GitHub. The fake is the HTTP
 * boundary — real blobs, trees, commits and refs — so what is exercised here
 * is the hook a ticket actually runs through, and nothing leaves the machine.
 */
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

const world = (): {
  gh: FakeTracker;
  spec: ArtifactHook;
  ctx: (ticket: string, snapshot?: Snapshot) => HookContext;
} => {
  const gh = createFakeTracker([{ number: 12 }, { number: 13 }]);
  const spec = gh.registry.post.find((h) => h.handles.includes("artifact.publish")) as ArtifactHook | undefined;
  if (!spec) throw new Error("no hook publishes the spec artifact");
  return { gh, spec, ctx: (ticket, snapshot = {}) => ({ ...gh.ctx, ticket, snapshot }) };
};

const publish = (body: string, artifact = "spec"): Effect => ({ type: "artifact.publish", artifact, body });

/** What a tick would have in the snapshot by the time it reconciles: this artifact's own read. */
const after = async (spec: ArtifactHook, ctx: HookContext): Promise<Snapshot> => ({ artifacts: { spec: await spec.read(ctx) } });

const writes = (gh: FakeTracker) => gh.requests.filter((r) => r.method !== "GET");

/** Ticket #12's page as a file on GitHub: the link for a repository with no Pages site, which the fake's is by default. */
const FILE_12 = "https://github.com/acme/widgets/blob/gh-pages/specs/12/index.md";

describe("the spec artifact's reference is derived, never stored", () => {
  it("names a url computed from the repository and the ticket, with nothing published yet", async () => {
    const { spec, ctx } = world();
    expect(await spec.read(ctx("12"))).toEqual({ exists: false, hash: null, url: FILE_12 });
  });

  it("reads back exactly what it published, hashed", async () => {
    const { gh, spec, ctx } = world();
    await spec.apply(publish("# Spec\n\nthe plan"), ctx("12"));

    expect(await spec.read(ctx("12"))).toEqual({ exists: true, hash: sha256("# Spec\n\nthe plan"), url: FILE_12 });
    expect(gh.published().get("specs/12/index.md")).toBe("# Spec\n\nthe plan");
  });

  it("puts each ticket's spec at its own path, keeping the ones already there", async () => {
    const { gh, spec, ctx } = world();
    await spec.apply(publish("twelve"), ctx("12"));
    await spec.apply(publish("thirteen"), ctx("13"));

    expect([...gh.published()]).toEqual([
      ["specs/12/index.md", "twelve"],
      ["specs/13/index.md", "thirteen"],
    ]);
  });

  /*
   * The orphan branch is created by the publish itself: a first commit with no
   * parent, through the Git Data API. Nothing is checked out and nothing lands
   * in main.
   */
  it("creates the branch on the first publish and moves it on the next, touching no other ref", async () => {
    const { gh, spec, ctx } = world();
    await spec.apply(publish("twelve"), ctx("12"));
    const first = writes(gh).map((r) => `${r.method} ${r.path}`);
    await spec.apply(publish("thirteen"), ctx("13"));
    const second = writes(gh).map((r) => `${r.method} ${r.path}`).slice(first.length);

    expect(first).toEqual(["POST /git/blobs", "POST /git/trees", "POST /git/commits", "POST /git/refs"]);
    expect(second).toEqual(["POST /git/blobs", "POST /git/trees", "POST /git/commits", "PATCH /git/refs/heads/gh-pages"]);
  });
});

/**
 * Idempotence is what makes a publish safe to replan: §6.1's whole recovery
 * story is that re-entering a state replans its effects and the ones already
 * satisfied fall away.
 */
describe("publishing the same content twice costs one write", () => {
  it("performs no write at all the second time, and one read to prove it", async () => {
    const { gh, spec, ctx } = world();
    await spec.apply(publish("# Spec"), ctx("12"));
    const before = gh.requests.length;
    const written = writes(gh).length;

    await spec.apply(publish("# Spec"), ctx("12"));

    expect(writes(gh).length - written).toBe(0);
    expect(gh.requests.length - before).toBe(1);
    expect(gh.published().get("specs/12/index.md")).toBe("# Spec");
  });

  it("writes again when the content actually changed", async () => {
    const { gh, spec, ctx } = world();
    await spec.apply(publish("# Spec"), ctx("12"));
    const written = writes(gh).length;

    await spec.apply(publish("# Spec, revised"), ctx("12"));

    expect(writes(gh).length - written).toBe(4);
    expect(gh.published().get("specs/12/index.md")).toBe("# Spec, revised");
  });

  it("drops the effect before it is applied when the snapshot already shows this content", async () => {
    const { gh, spec, ctx } = world();
    await spec.apply(publish("# Spec"), ctx("12"));
    const snapshot = await after(spec, ctx("12"));

    expect(spec.satisfied(snapshot, publish("# Spec"))).toBe(true);
    expect(spec.satisfied(snapshot, publish("# Spec, revised"))).toBe(false);
    expect(gh.published().get("specs/12/index.md")).toBe("# Spec");
  });

  /*
   * Drift is caught by the next tick's read, not by satisfied(): the snapshot
   * holds the hash as it was at the start of the pass, and re-reading inside a
   * pure, hot satisfied() is not available to it. Pinned here so the split
   * stays deliberate.
   */
  it("notices on the next read that the page changed underneath it", async () => {
    const { spec, ctx } = world();
    await spec.apply(publish("# Spec"), ctx("12"));
    const before = await spec.read(ctx("12"));

    await spec.apply(publish("# Edited by a person"), ctx("12"));

    expect((await spec.read(ctx("12"))).hash).not.toBe((before as { hash: string }).hash);
  });
});

/**
 * Each of these has exactly one honest answer — stop and say so. "Satisfied"
 * silently drops the publish; "not satisfied" republishes on every tick and
 * pays for it.
 */
describe("a publish it cannot account for halts the ticket", () => {
  it("refuses an effect naming an artifact it does not publish", async () => {
    const { spec, ctx } = world();
    const other = publish("# Spec", "pr");
    expect(() => spec.satisfied({ artifacts: { spec: { hash: null } } }, other)).toThrow(/"pr"/);
    await expect(spec.apply(other, ctx("12"))).rejects.toThrow(/"pr"/);
  });

  it("refuses a publish carrying no content", async () => {
    const { gh, spec, ctx } = world();
    await expect(spec.apply({ type: "artifact.publish", artifact: "spec" }, ctx("12"))).rejects.toThrow(/no content/);
    expect(writes(gh)).toEqual([]);
  });

  it("refuses to answer when the snapshot holds no state for it", () => {
    const { spec } = world();
    expect(() => spec.satisfied({}, publish("# Spec"))).toThrow(/artifacts\.spec/);
  });

  it("reports a failed read rather than calling it 'nothing is published'", async () => {
    const { gh, spec, ctx } = world();
    gh.breakOn((r) => r.path.startsWith("/contents/"), 500);
    await expect(spec.read(ctx("12"))).rejects.toThrow(/500/);
  });

  /*
   * The same failure on ticket #404, which is the one that matters: a status
   * matched by searching the error *text* for "404" finds the path instead —
   * `/contents/specs/404/index.md` — and reports a broken repository as an
   * unpublished spec, which then republishes on every tick forever.
   */
  it("does not read the ticket number as the status it is checking for", async () => {
    const { gh, spec, ctx } = world();
    gh.breakOn((r) => r.path.startsWith("/contents/"), 500);
    await expect(spec.read(ctx("404"))).rejects.toThrow(/500/);
  });
});

/**
 * A link to a page nobody can open is worse than none: yiftahb/landrace is
 * private with no Pages site, so every `<owner>.github.io` link it was handed
 * — on the board, and in the build and review prompts — was a 404. The link
 * goes where the page can actually be read, and all three places that carry
 * it agree on it.
 */
describe("the spec link points where the page can actually be read", () => {
  type Logged = { event: string; data: Record<string, unknown> | undefined };

  const published = () => {
    const w = world();
    w.gh.seedFile("specs/12/index.md", "# Spec");
    return w;
  };

  /** Every place a spec link surfaces: the listed node, the read node, and the artifact's own url. */
  const links = async (gh: FakeTracker, spec: ArtifactHook, events: Logged[] = []) => {
    const source = gh.registry.source;
    if (!source) throw new Error("the fake tracker registered no source");
    const ctx = { ...gh.ctx, log: (event: string, data?: Record<string, unknown>) => { events.push({ event, data }); } };
    const linkIn = (g: Graph) => g.nodes.find((n) => n.id === "spec-12")?.link;
    return {
      listed: linkIn(await source.list(ctx)),
      read: linkIn(await source.read("12", ctx)),
      artifact: (await spec.read({ ...ctx, ticket: "12", snapshot: {} })).url,
    };
  };
  const everywhere = (link: string) => ({ listed: link, read: link, artifact: link });
  const probes = (gh: FakeTracker) => gh.requests.filter((r) => r.path === "/pages");
  const unknown = (events: Logged[]) => events.filter((e) => e.event === "github.pages.unknown");

  it("links the file on GitHub when the repository has no Pages site, and says nothing about it", async () => {
    const { gh, spec } = published();
    const events: Logged[] = [];
    expect(await links(gh, spec, events)).toEqual(everywhere(FILE_12));
    // A 404 is an answer, not a failure.
    expect(unknown(events)).toEqual([]);
  });

  it.each([
    ["the default domain", "https://acme.github.io/widgets/", "https://acme.github.io/widgets/specs/12/"],
    ["a custom domain, with no trailing slash", "https://docs.acme.dev", "https://docs.acme.dev/specs/12/"],
    ["a custom domain served over http", "http://docs.acme.dev/", "http://docs.acme.dev/specs/12/"],
  ])("links the site's own page when it publishes gh-pages at %s", async (_, htmlUrl, link) => {
    const { gh, spec } = published();
    gh.pages({ html_url: htmlUrl });
    expect(await links(gh, spec)).toEqual(everywhere(link));
  });

  /*
   * A 200 says a site exists, not that it serves this branch. One built from
   * main's docs folder, or deployed by a workflow, answers every spec path
   * with a 404 — the same dead link, on a different host.
   */
  it.each<[string, Partial<FakePages>]>([
    ["main:/docs", { source: { branch: "main", path: "/docs" } }],
    ["gh-pages:/docs", { source: { branch: "gh-pages", path: "/docs" } }],
    ["an Actions workflow", { build_type: "workflow" }],
  ])("links the file when the site is built from %s, which serves no spec page", async (_, site) => {
    const { gh, spec } = published();
    gh.pages({ html_url: "https://acme.github.io/widgets/", ...site });
    expect(await links(gh, spec)).toEqual(everywhere(FILE_12));
  });

  it("links the file on a 5xx, logs why once, fails nothing, and asks again next time", async () => {
    const { gh, spec, ctx } = published();
    gh.pages(500);
    const events: Logged[] = [];

    expect(await links(gh, spec, events)).toEqual(everywhere(FILE_12));
    // Not an answer, so not kept: each of the three asked again.
    expect(probes(gh)).toHaveLength(3);
    expect(unknown(events)).toEqual([
      { event: "github.pages.unknown", data: { reason: expect.stringContaining("500") } },
    ]);

    gh.pages({ html_url: "https://acme.github.io/widgets/" });
    expect((await spec.read(ctx("12"))).url).toBe("https://acme.github.io/widgets/specs/12/");
  });

  /*
   * A 403 is this token lacking "Pages: Read", and only a new token changes
   * that — asking again on every read would buy one request per call and the
   * same answer. So it is kept like a 404, until a restart.
   */
  it("links the file on a 403, logs why once, fails nothing, and asks once for the life of the client", async () => {
    const { gh, spec, ctx } = published();
    gh.pages(403);
    const events: Logged[] = [];

    await Promise.all([spec.read(ctx("12")), spec.read(ctx("13"))]);
    expect(await links(gh, spec, events)).toEqual(everywhere(FILE_12));
    expect(await links(gh, spec, events)).toEqual(everywhere(FILE_12));
    expect(probes(gh)).toHaveLength(1);

    // Kept even once a site appears: the token that was refused is the one still asking.
    gh.pages({ html_url: "https://acme.github.io/widgets/" });
    expect((await spec.read(ctx("12"))).url).toBe(FILE_12);
    expect(probes(gh)).toHaveLength(1);

    const all: Logged[] = [];
    const fresh = published();
    fresh.gh.pages(403);
    await links(fresh.gh, fresh.spec, all);
    await links(fresh.gh, fresh.spec, all);
    expect(unknown(all)).toEqual([
      { event: "github.pages.unknown", data: { reason: expect.stringMatching(/until a restart[\s\S]*403/) } },
    ]);
  });

  it("links the file, and says why, when GitHub describes the site with no web address", async () => {
    const { gh, spec } = published();
    gh.pages({ html_url: "javascript:alert(1)" });
    const events: Logged[] = [];
    expect(await links(gh, spec, events)).toEqual(everywhere(FILE_12));
    expect(unknown(events)).toEqual([
      { event: "github.pages.unknown", data: { reason: expect.stringContaining("html_url") } },
    ]);
  });

  it("links the file when the connection drops, and fails nothing", async () => {
    const { gh } = published();
    const dropping = (async (input: string | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname.endsWith("/pages")) throw new TypeError("fetch failed");
      return gh.fetchImpl(input, init);
    }) as typeof fetch;
    const hooks = githubHooks({ repo: "acme/widgets", token: "test-token", fetchImpl: dropping, git: noBranches });
    const events: Logged[] = [];
    const log = (event: string, data?: Record<string, unknown>) => { events.push({ event, data }); };

    expect((await hooks.specArtifact.read({ ...gh.ctx, log, ticket: "12", snapshot: {} })).url).toBe(FILE_12);
    expect(unknown(events)).toEqual([
      { event: "github.pages.unknown", data: { reason: expect.stringContaining("fetch failed") } },
    ]);
  });

  it.each<[string, FakePages | null]>([
    ["no site", null],
    ["a site", { html_url: "https://acme.github.io/widgets/" }],
  ])("asks once per client when the answer is definitive (%s), however many reads", async (_, site) => {
    const { gh, spec, ctx } = published();
    gh.pages(site);
    // Side by side first, the way a pass reads several tickets: the question
    // still in flight is the one they share, not one each.
    await Promise.all([spec.read(ctx("12")), spec.read(ctx("13")), links(gh, spec)]);
    await links(gh, spec);
    await links(gh, spec);
    expect(probes(gh)).toHaveLength(1);
  });
});
