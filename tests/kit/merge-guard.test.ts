import { compose, globMatches, isEffectRefused } from "landrace/kit";
import { deriveRun } from "#core/derive.js";
import { MemoryForge, MemoryTracker } from "#testing/index.js";
import type {
  ChangedFile, ChangedFiles, ComposedHooks, Effect, Entry, Graph, HookContext, MergeAnswer, RuntimeContext, Snapshot,
} from "#namespace.js";

/*
 * The protected-path gate on `pull.merge` (security audit C1): a workflow
 * that merges with no person names the paths only a person may merge, and
 * the kit reads the pull request's changed files — old names too — before
 * it asks the forge to merge. A match, or a list it could not read to the
 * end, is a marked refusal: the stage's rejected round, a halt, a person.
 */
const ctx = { config: {}, secrets: new Map(), signal: new AbortController().signal, log: () => {} } as unknown as RuntimeContext;

const PROTECTED = [".landrace/hooks/**", ".landrace/landrace.yaml", ".landrace/workflows/*/workflow.yaml", ".github/**", "package.json", "CLAUDE.md"];
const merge: Effect = { type: "pull.merge", branch: "landrace/7", refuse: PROTECTED };

const file = (path: string, previous?: string): ChangedFile =>
  ({ path, status: previous === undefined ? "modified" : "renamed", additions: 1, deletions: 0, ...(previous === undefined ? {} : { previous }) });

/** The memory forge with the item's pull request open and green, counting what the merge path asks of it. */
function world(files: ChangedFile[] = [], opts: { complete?: false; settling?: true; unreadable?: string } = {}) {
  const asked = { merges: 0, files: 0 };
  class Counting extends MemoryForge {
    override async merge(pull: number, headSha: string): Promise<MergeAnswer> {
      asked.merges++;
      return super.merge(pull, headSha);
    }
    override async changedFiles(pull: number): Promise<ChangedFiles> {
      asked.files++;
      if (opts.unreadable !== undefined) throw new Error(opts.unreadable);
      const read = await super.changedFiles(pull);
      return opts.settling ? { ...read, complete: false, settling: true } : read;
    }
  }
  const forge = new Counting();
  const pr = forge.add("7", { checks: "success", headSha: "abc", files, ...(opts.complete === false ? { filesComplete: false as const } : {}) });
  const hooks: ComposedHooks = compose({ tracker: new MemoryTracker({ items: [{ id: "7" }] }), forge });
  return { forge, pr, hooks, asked };
}

const read = async (hooks: ComposedHooks): Promise<Snapshot> => {
  const graph: Graph = await hooks.source.read("7", ctx);
  return { graph, node: graph.nodes.find((n) => n.id === "7") };
};

const attempt = async (hooks: ComposedHooks, effect: Effect = merge): Promise<{ message: string; refused: boolean } | "merged"> =>
  hooks.post.apply(effect, { ...ctx, item: "7", snapshot: await read(hooks) } as HookContext)
    .then(() => "merged" as const, (e: unknown) => ({ message: (e as Error).message, refused: isEffectRefused(e) }));

describe("globMatches", () => {
  it.each([
    [".landrace/hooks/**", ".landrace/hooks/github.ts", true],
    [".landrace/hooks/**", ".landrace/hooks/deep/er/x.ts", true],
    // The directory itself: replaced by a link, it is every file under it.
    [".landrace/hooks/**", ".landrace/hooks", true],
    [".landrace/hooks/**", ".landrace/hooksy/x.ts", false],
    [".landrace/hooks/**", "src/.landrace/hooks/x.ts", false],
    [".landrace/workflows/*/workflow.yaml", ".landrace/workflows/fastlane/workflow.yaml", true],
    [".landrace/workflows/*/workflow.yaml", ".landrace/workflows/fastlane/steps/build.md", false],
    [".landrace/workflows/*/workflow.yaml", ".landrace/workflows/a/b/workflow.yaml", false],
    [".github/**", ".github/workflows/ci.yml", true],
    ["package.json", "package.json", true],
    ["package.json", "packages/x/package.json", false],
    ["**/package.json", "packages/x/package.json", true],
    ["**/package.json", "package.json", true],
    ["src/*.ts", "src/a.ts", true],
    ["src/*.ts", "src/a.tsx", false],
    // A case-insensitive checkout — macOS, Windows — writes `.Landrace/hooks/x.ts`
    // where `.landrace/hooks/x.ts` is, and reads `claude.md` as CLAUDE.md.
    [".landrace/hooks/**", ".Landrace/HOOKS/x.ts", true],
    ["CLAUDE.md", "claude.md", true],
    // A dot is a dot, not any character.
    ["CLAUDE.md", "CLAUDEXmd", false],
    // A leading `**/` is none too: the file at the root, and the same name anywhere below it.
    ["**/CLAUDE.md", "CLAUDE.md", true],
    ["**/CLAUDE.md", "docs/deep/CLAUDE.md", true],
    ["**/AGENTS.md", "packages/x/agents.md", true],
    ["**/CLAUDE.md", "docs/CLAUDE.md.bak", false],
    // What a case-insensitive file system folds into the same name (re-review
    // N4): APFS resolves `hooKs` with the Kelvin sign (U+212A) and `hookſ` with
    // the long s (U+017F) to `hooks/`, and a checkout writes the file there.
    [".landrace/hooks/**", ".landrace/hooKs/github.ts", true],
    [".landrace/hooks/**", ".landrace/hookſ/github.ts", true],
    ["CLAUDE.md", "ＣLAUDE.md", true],
    // The glob is normalised the same way as the path.
    ["ＣLAUDE.md", "claude.md", true],
  ] as const)("%s against %s: %s", (glob, path, expected) => {
    expect(globMatches(glob, path)).toBe(expected);
  });

  it("answers a long path against several ** quickly", () => {
    const path = `${"a/".repeat(2_000)}b`;
    const started = Date.now();
    expect(globMatches("**/a/**/a/**/a/**/c", path)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  // Re-review N6: several `*` in one segment, against a long segment that
  // almost matches, took a backtracking regex about 20 s.
  it("answers a long segment against several * in one segment quickly", () => {
    const segment = "a".repeat(240);
    const started = Date.now();
    expect(globMatches("*a*a*a*a*b", segment)).toBe(false);
    expect(globMatches("x/*a*a*a*a*b/**", `x/${segment}/y`)).toBe(false);
    expect(Date.now() - started).toBeLessThan(250);
  });

  it.each([
    ["*a*a*a*a*b", `${"a".repeat(240)}b`, true],
    ["*a*b*", "xxaxxbxx", true],
    ["*a*b*", "xxbxxaxx", false],
    ["a*", "a", true],
    ["*a", "ba", true],
    ["*a", "ab", false],
    ["*", "", true],
    ["a**b", "axxb", true],
    ["a*c", "abcbc", true],
    ["a*c", "abcb", false],
    ["src/*.*", "src/a.ts", true],
    ["src/*.*", "src/ats", false],
  ] as const)("within a segment, %s against %s: %s", (glob, path, expected) => {
    expect(globMatches(glob, path)).toBe(expected);
  });
});

describe("pull.merge's protected paths", () => {
  it("refuses a pull request that changes a protected path, naming it, the item and a person, and asks the forge for no merge", async () => {
    const { hooks, forge, pr, asked } = world([file("src/a.ts"), file(".landrace/hooks/github.ts")]);
    const said = await attempt(hooks);
    expect(said).toEqual({ refused: true, message: expect.stringContaining("pr-1 for #7") });
    if (said === "merged") throw new Error("merged");
    expect(said.message).toContain(".landrace/hooks/github.ts");
    expect(said.message).not.toContain("src/a.ts");
    expect(said.message).toMatch(/a person must merge it/);
    expect(asked.merges).toBe(0);
    expect(forge.pull(pr).merged).toBe(false);
  });

  it("refuses a rename away from a protected path, naming both names", async () => {
    const { hooks, asked } = world([file("docs/notes.md", "CLAUDE.md")]);
    const said = await attempt(hooks);
    expect(said).toMatchObject({ refused: true, message: expect.stringMatching(/docs\/notes\.md \(renamed from CLAUDE\.md\)/) });
    expect(asked.merges).toBe(0);
  });

  it("names five paths and counts the rest", async () => {
    const { hooks } = world(Array.from({ length: 8 }, (_, i) => file(`.github/workflows/w${i}.yml`)));
    const said = await attempt(hooks);
    if (said === "merged") throw new Error("merged");
    expect(said.message).toContain(".github/workflows/w4.yml");
    expect(said.message).not.toContain(".github/workflows/w5.yml");
    expect(said.message).toContain("and 3 more");
  });

  it("merges a pull request that changes no protected path", async () => {
    const { hooks, forge, pr, asked } = world([file("src/a.ts"), file(".landrace/workflows/fastlane/steps/build.md"), file("README.md")]);
    expect(await attempt(hooks)).toBe("merged");
    expect(asked).toEqual({ merges: 1, files: 1 });
    expect(forge.pull(pr).merged).toBe(true);
  });

  /* Nothing compared is not a pass: a list the forge stopped short of is not one with nothing protected in it. */
  it("refuses when the forge could not list every changed file, though none it listed is protected", async () => {
    const { hooks, asked } = world([file("src/a.ts")], { complete: false });
    const said = await attempt(hooks);
    expect(said).toMatchObject({ refused: true, message: expect.stringMatching(/pr-1 for #7[\s\S]*listed 1[\s\S]*a person must merge it/) });
    expect(asked.merges).toBe(0);
  });

  /*
   * A list the forge is still working out — GitLab's count not computed yet
   * on a merge request just opened — is not one cut short: it settles by
   * itself, so the merge is left to the next tick, unmarked, as checks still
   * running are.
   */
  it("leaves a merge whose changed files the forge is still working out to the next tick, unmarked", async () => {
    const { hooks, asked } = world([file("src/a.ts")], { settling: true });
    const said = await attempt(hooks);
    expect(said).toMatchObject({ refused: false, message: expect.stringMatching(/will not merge pr-1 for #7 yet[\s\S]*still working out/) });
    expect(asked.merges).toBe(0);
  });

  it("refuses when the changed files could not be read at all, saying why", async () => {
    const { hooks, asked } = world([], { unreadable: "502 Bad Gateway" });
    const said = await attempt(hooks);
    expect(said).toMatchObject({ refused: true, message: expect.stringMatching(/pr-1 for #7[\s\S]*502 Bad Gateway[\s\S]*a person must merge it/) });
    expect(asked.merges).toBe(0);
  });

  /*
   * Re-review N4, probe: the attacker's commit names `.landrace/hooKs/github.ts`
   * with the Kelvin sign, as plumbing on a Linux checkout makes it. `git reset
   * --hard` or a fresh clone on macOS writes it over `.landrace/hooks/github.ts`,
   * which the engine imports at start.
   */
  it("refuses a protected path spelled with characters a checkout folds into it", async () => {
    const kelvin = ".landrace/hooKs/github.ts";
    const { hooks, forge, pr, asked } = world([file("src/a.ts"), file(kelvin)]);
    const said = await attempt(hooks);
    expect(said).toEqual({ refused: true, message: expect.stringContaining(`it changes ${kelvin}, which this workflow protects`) });
    expect(asked.merges).toBe(0);
    expect(forge.pull(pr).merged).toBe(false);
  });

  /*
   * And a name Unicode normalisation changes is not merged with no person,
   * protected or not: what a checkout makes of it is the checkout's to say,
   * and a gate matching one reading of it has checked one reading.
   */
  it.each([
    ["a ligature", "src/ﬁle.ts", undefined],
    ["decomposed letters", "src/café.ts", undefined],
    ["a rename's old name", "src/file.ts", "src/ﬁle.ts"],
  ])("refuses a changed file whose name normalisation changes: %s", async (_what, path, previous) => {
    const { hooks, asked } = world([file("src/a.ts"), file(path, previous)]);
    const said = await attempt(hooks);
    if (said === "merged") throw new Error("merged");
    expect(said.refused).toBe(true);
    expect(said.message).toMatch(/pr-1 for #7[\s\S]*Unicode normalisation[\s\S]*a person must merge it/);
    expect(said.message).toContain(path);
    expect(said.message).not.toContain("src/a.ts");
    expect(asked.merges).toBe(0);
  });

  it("merges a name already in normal form, accented or not", async () => {
    const { hooks, asked } = world([file("src/café.ts"), file("docs/日本.md")]);
    expect(await attempt(hooks)).toBe("merged");
    expect(asked.merges).toBe(1);
  });

  it("reads no changed file for a merge that names no protected path", async () => {
    const { hooks, asked } = world([file(".landrace/hooks/github.ts")]);
    expect(await attempt(hooks, { type: "pull.merge", branch: "landrace/7" })).toBe("merged");
    expect(asked).toEqual({ merges: 1, files: 0 });
  });

  it.each([
    ["not a list", "package.json"],
    ["an empty list", []],
    ["an empty glob", ["package.json", ""]],
    ["a glob that is no string", [7]],
  ])("halts on a `refuse` that is %s, merging nothing, before it asks the forge anything", async (_what, refuse) => {
    const { hooks, asked } = world([file("src/a.ts")]);
    const said = await attempt(hooks, { type: "pull.merge", branch: "landrace/7", refuse });
    expect(said).toMatchObject({ refused: false, message: expect.stringMatching(/refuse/) });
    expect(asked).toEqual({ merges: 0, files: 0 });
  });
});

/*
 * `reviewedBy` (security audit H1): the merge is held to the head the named
 * stage's latest valid output started at, as the runner recorded it. A
 * head that review never saw — pushed after it, or recorded by nobody — is
 * answered as a moved head is: nothing merges, nothing throws, and the
 * workflow's own route sends the item back to that review.
 */
describe("pull.merge held to the head a review saw", () => {
  const held: Effect = { type: "pull.merge", branch: "landrace/7", reviewedBy: "code-review" };
  const logged: Array<{ name: string; data: Record<string, unknown> }> = [];
  const attemptAt = async (hooks: ComposedHooks, heads: Record<string, string>, effect: Effect = held) => {
    logged.length = 0;
    const snapshot = { ...(await read(hooks)), run: { heads } } as unknown as Snapshot;
    const log = (name: string, data: Record<string, unknown> = {}): void => { logged.push({ name, data }); };
    return hooks.post.apply(effect, { ...ctx, item: "7", snapshot, log } as HookContext)
      .then(() => "resolved" as const, (e: unknown) => ({ message: (e as Error).message, refused: isEffectRefused(e) }));
  };

  it("merges the head the review's latest round started at", async () => {
    const { hooks, forge, pr, asked } = world();
    expect(await attemptAt(hooks, { "code-review": "abc" })).toBe("resolved");
    expect(asked.merges).toBe(1);
    expect(forge.pull(pr).merged).toBe(true);
  });

  it.each([
    ["another head", { "code-review": "older" }],
    ["no head at all", {}],
    ["only another stage's head", { build: "abc" }],
  ])("answers a head the review did not see — %s — as moved, asking the forge for no merge", async (_what, heads) => {
    const { hooks, forge, pr, asked } = world();
    expect(await attemptAt(hooks, heads)).toBe("resolved");
    expect(asked.merges).toBe(0);
    expect(forge.pull(pr).merged).toBe(false);
    expect(logged).toEqual([expect.objectContaining({ name: "forge.merge.unreviewed", data: expect.objectContaining({ pull: "pr-1", headSha: "abc" }) })]);
  });

  /*
   * The heads as the engine derives them, off the review's records: a round
   * whose answer was rejected judged nothing, so the head it started at —
   * the one on the forge now — is not reviewed, though an earlier round's
   * valid answer reviewed another.
   */
  it.each(["malformed", "refused"])("answers the head a %s review round started at as moved", async (kind) => {
    const { hooks, forge, pr, asked } = world();
    const record = (k: string, round: number, head: string): Entry =>
      ({ stage: "code-review", kind: k, round, head, at: `2026-10-02T00:00:0${round}.000Z`, byAgent: true });
    const { heads } = deriveRun([record("output", 1, "older"), record(kind, 2, "abc")], "ci");
    expect(await attemptAt(hooks, heads)).toBe("resolved");
    expect(asked.merges).toBe(0);
    expect(forge.pull(pr).merged).toBe(false);
  });

  it("judges the head the forge has now, read again just before the merge", async () => {
    const { hooks, forge, pr, asked } = world();
    const snapshot = { ...(await read(hooks)), run: { heads: { "code-review": "abc" } } } as unknown as Snapshot;
    forge.pull(pr).headSha = "pushed";
    await hooks.post.apply(held, { ...ctx, item: "7", snapshot } as HookContext);
    expect(asked.merges).toBe(0);
    expect(forge.pull(pr).merged).toBe(false);
  });

  it.each([["an empty name", ""], ["a number", 7]])("halts on a reviewedBy that is %s, before it asks the forge anything", async (_what, by) => {
    const { hooks, asked } = world();
    const said = await attemptAt(hooks, { "code-review": "abc" }, { ...held, reviewedBy: by });
    expect(said).toMatchObject({ refused: false, message: expect.stringMatching(/reviewedBy/) });
    expect(asked).toEqual({ merges: 0, files: 0 });
  });
});
