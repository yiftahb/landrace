import { compose, globMatches, isEffectRefused } from "landrace/kit";
import { MemoryForge, MemoryTracker } from "#testing/index.js";
import type { ChangedFile, ChangedFiles, ComposedHooks, Effect, Graph, HookContext, MergeAnswer, RuntimeContext, Snapshot } from "#namespace.js";

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
function world(files: ChangedFile[] = [], opts: { complete?: false; unreadable?: string } = {}) {
  const asked = { merges: 0, files: 0 };
  class Counting extends MemoryForge {
    override async merge(pull: number, headSha: string): Promise<MergeAnswer> {
      asked.merges++;
      return super.merge(pull, headSha);
    }
    override async changedFiles(pull: number): Promise<ChangedFiles> {
      asked.files++;
      if (opts.unreadable !== undefined) throw new Error(opts.unreadable);
      return super.changedFiles(pull);
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
  ] as const)("%s against %s: %s", (glob, path, expected) => {
    expect(globMatches(glob, path)).toBe(expected);
  });

  it("answers a long path against several ** quickly", () => {
    const path = `${"a/".repeat(2_000)}b`;
    const started = Date.now();
    expect(globMatches("**/a/**/a/**/a/**/c", path)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
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

  it("refuses when the changed files could not be read at all, saying why", async () => {
    const { hooks, asked } = world([], { unreadable: "502 Bad Gateway" });
    const said = await attempt(hooks);
    expect(said).toMatchObject({ refused: true, message: expect.stringMatching(/pr-1 for #7[\s\S]*502 Bad Gateway[\s\S]*a person must merge it/) });
    expect(asked.merges).toBe(0);
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
