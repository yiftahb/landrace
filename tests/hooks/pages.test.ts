import { createHash } from "node:crypto";
import { createFakeTracker, type FakeTracker } from "#tests/support/fake-tracker.js";
import type { ArtifactHook, Effect, HookContext, Snapshot } from "#namespace.js";

/**
 * The spec artifact, over the in-memory GitHub. The fake is the HTTP
 * boundary — real blobs, trees, commits and refs — so what is exercised here
 * is the hook a ticket actually runs through, and nothing leaves the machine.
 */
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

const world = (): {
  gh: FakeTracker;
  spec: ArtifactHook;
  ctx: (ticket: number, snapshot?: Snapshot) => HookContext;
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

describe("the spec artifact's reference is derived, never stored", () => {
  it("names a url computed from the repository and the ticket, with nothing published yet", async () => {
    const { spec, ctx } = world();
    expect(await spec.read(ctx(12))).toEqual({
      exists: false, hash: null, url: "https://acme.github.io/widgets/specs/12/",
    });
  });

  it("reads back exactly what it published, hashed", async () => {
    const { gh, spec, ctx } = world();
    await spec.apply(publish("# Spec\n\nthe plan"), ctx(12));

    expect(await spec.read(ctx(12))).toEqual({
      exists: true, hash: sha256("# Spec\n\nthe plan"), url: "https://acme.github.io/widgets/specs/12/",
    });
    expect(gh.published().get("specs/12/index.md")).toBe("# Spec\n\nthe plan");
  });

  it("puts each ticket's spec at its own path, keeping the ones already there", async () => {
    const { gh, spec, ctx } = world();
    await spec.apply(publish("twelve"), ctx(12));
    await spec.apply(publish("thirteen"), ctx(13));

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
    await spec.apply(publish("twelve"), ctx(12));
    const first = writes(gh).map((r) => `${r.method} ${r.path}`);
    await spec.apply(publish("thirteen"), ctx(13));
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
    await spec.apply(publish("# Spec"), ctx(12));
    const before = gh.requests.length;
    const written = writes(gh).length;

    await spec.apply(publish("# Spec"), ctx(12));

    expect(writes(gh).length - written).toBe(0);
    expect(gh.requests.length - before).toBe(1);
    expect(gh.published().get("specs/12/index.md")).toBe("# Spec");
  });

  it("writes again when the content actually changed", async () => {
    const { gh, spec, ctx } = world();
    await spec.apply(publish("# Spec"), ctx(12));
    const written = writes(gh).length;

    await spec.apply(publish("# Spec, revised"), ctx(12));

    expect(writes(gh).length - written).toBe(4);
    expect(gh.published().get("specs/12/index.md")).toBe("# Spec, revised");
  });

  it("drops the effect before it is applied when the snapshot already shows this content", async () => {
    const { gh, spec, ctx } = world();
    await spec.apply(publish("# Spec"), ctx(12));
    const snapshot = await after(spec, ctx(12));

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
    await spec.apply(publish("# Spec"), ctx(12));
    const before = await spec.read(ctx(12));

    await spec.apply(publish("# Edited by a person"), ctx(12));

    expect((await spec.read(ctx(12))).hash).not.toBe((before as { hash: string }).hash);
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
    await expect(spec.apply(other, ctx(12))).rejects.toThrow(/"pr"/);
  });

  it("refuses a publish carrying no content", async () => {
    const { gh, spec, ctx } = world();
    await expect(spec.apply({ type: "artifact.publish", artifact: "spec" }, ctx(12))).rejects.toThrow(/no content/);
    expect(writes(gh)).toEqual([]);
  });

  it("refuses to answer when the snapshot holds no state for it", () => {
    const { spec } = world();
    expect(() => spec.satisfied({}, publish("# Spec"))).toThrow(/artifacts\.spec/);
  });

  it("reports a failed read rather than calling it 'nothing is published'", async () => {
    const { gh, spec, ctx } = world();
    gh.breakOn((r) => r.path.startsWith("/contents/"), 500);
    await expect(spec.read(ctx(12))).rejects.toThrow(/500/);
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
    await expect(spec.read(ctx(404))).rejects.toThrow(/500/);
  });
});
