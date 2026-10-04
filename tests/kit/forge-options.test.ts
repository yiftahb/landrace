import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isEffectRefused } from "#conventions.js";
import { deriveRel } from "#core/rel.js";
import { compose } from "#kit/compose.js";
import { fillPlaceholders, unknownPlaceholders } from "#kit/forge.js";
import { MemoryForge, MemoryTracker } from "#testing/index.js";
import type { ComposedHooks, ForgeOptions, Graph, HookContext, Node, RuntimeContext, Snapshot } from "#namespace.js";

/**
 * The options every forge on the kit's base takes: `reviewers`, the external
 * reviewers a workflow waits on, and `pull`, the text a pull request opens
 * with. Driven through `compose` over the in-memory forge, so what runs is
 * the kit's own `read()`, `pull.open` and preflight.
 */
const ctx = { config: {}, secrets: new Map(), signal: new AbortController().signal, log: () => {} } as unknown as RuntimeContext;

const world = (options: ForgeOptions & { root?: string } = {}): { hooks: ComposedHooks; forge: MemoryForge } => {
  const forge = new MemoryForge(options);
  return { hooks: compose({ tracker: new MemoryTracker({ items: [{ id: "7" }] }), forge }), forge };
};

const stateOf = async (hooks: ComposedHooks, id: string): Promise<Record<string, unknown> | undefined> =>
  (await hooks.source.read("7", ctx)).nodes.find((n) => n.id === id)?.state;

describe("reviewers and reviewPending", () => {
  const coderabbit = { reviewers: [{ status: "CodeRabbit" }] };

  it("is 0 on every open pull request when no reviewer is named", async () => {
    const { hooks, forge } = world();
    const pr = forge.add("7");
    expect(await stateOf(hooks, pr)).toMatchObject({ reviewPending: 0 });
  });

  it.each([
    ["missing", 1, {}],
    ["still running", 1, { CodeRabbit: "running" as const }],
    ["finished", 0, { CodeRabbit: "finished" as const }],
  ])("reads a reviewer's status %s as reviewPending %s", async (_said, pending, reviewerStatuses) => {
    const { hooks, forge } = world(coderabbit);
    const pr = forge.add("7", { reviewerStatuses });
    expect(await stateOf(hooks, pr)).toMatchObject({ reviewPending: pending });
  });

  it("waits for every named reviewer, not the first", async () => {
    const { hooks, forge } = world({ reviewers: [{ status: "CodeRabbit" }, { status: "ai-review" }] });
    const pr = forge.add("7", { reviewerStatuses: { CodeRabbit: "finished" } });
    expect(await stateOf(hooks, pr)).toMatchObject({ reviewPending: 1 });
    forge.pull(pr).reviewerStatuses = { CodeRabbit: "finished", "ai-review": "finished" };
    expect(await stateOf(hooks, pr)).toMatchObject({ reviewPending: 0 });
  });

  it("reads a closed pull request as 0 without asking, and sums across an item's pull requests", async () => {
    const { hooks, forge } = world(coderabbit);
    let asked = 0;
    const finished = forge.finishedReviewers.bind(forge);
    forge.finishedReviewers = async (pull) => {
      asked++;
      return finished(pull);
    };
    const merged = forge.add("7", { merged: true });
    forge.add("7", {});
    forge.add("7", { reviewerStatuses: { CodeRabbit: "finished" } });
    const graph = await hooks.source.read("7", ctx);
    expect(graph.nodes.find((n) => n.id === merged)?.state).toMatchObject({ reviewPending: 0 });
    expect(asked).toBe(2);
    const rel = deriveRel(graph, "7", ["implements"]);
    if (!rel.ok) throw new Error(rel.why);
    expect(rel.rel.implements?.in.sum).toMatchObject({ reviewPending: 1 });
  });

  it.each([[{}], [{ status: "" }], [{ status: "  " }], ["CodeRabbit"]])("refuses a reviewer that names no status: %j", (reviewer) => {
    expect(() => new MemoryForge({ reviewers: [reviewer as { status: string }] })).toThrow(/names the status it posts/);
  });

  it("refuses reviewers at start on a forge that cannot read a reviewer's status", async () => {
    const { hooks, forge } = world(coderabbit);
    Object.defineProperty(forge, "finishedReviewers", { value: undefined });
    await expect(hooks.preflight.check(ctx)).rejects.toThrow("forge: reviewers is set, but this forge cannot read a reviewer's status");
    await expect(world().hooks.preflight.check(ctx)).resolves.toBeUndefined();
  });
});

describe("the pull request's title and description", () => {
  const open = { type: "pull.open", branch: "landrace/7" };

  const snapshotOf = (node: Partial<Node>, graph: Graph = { nodes: [], relationships: [] }): Snapshot => ({
    node: { id: "7", kind: "item", title: "Add a cache", link: "https://tracker/7", closed: null, priority: null, origin: null, state: {}, ...node },
    graph,
  });

  const opened = async (hooks: ComposedHooks, forge: MemoryForge, snapshot: Snapshot) => {
    await hooks.post.apply(open, { ...ctx, item: "7", snapshot } as HookContext);
    return [...forge.rows.values()].at(-1)?.opened;
  };

  /** A project root with `.landrace/templates/pull.md` reading `template`. */
  const project = async (template: string): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "landrace-pull-"));
    await mkdir(join(root, ".landrace", "templates"), { recursive: true });
    await writeFile(join(root, ".landrace", "templates", "pull.md"), template);
    return root;
  };

  it("opens with the item's title and no description when nothing is set", async () => {
    const { hooks, forge } = world();
    expect(await opened(hooks, forge, snapshotOf({}))).toEqual({ title: "Add a cache", description: undefined });
  });

  it("formats the title from the item's id and title", async () => {
    const { hooks, forge } = world({ pull: { title: "{item}: {title}" } });
    expect((await opened(hooks, forge, snapshotOf({})))?.title).toBe("7: Add a cache");
  });

  it("fills the title in one pass, and escapes the item's text", async () => {
    const { hooks, forge } = world({ pull: { title: "[{item}] {title}" } });
    const title = (await opened(hooks, forge, snapshotOf({ title: "{item} <!-- landrace:x -->" })))?.title;
    expect(title).toBe("[7] {item} &lt;!-- landrace:x --&gt;");
  });

  it.each(["{key}: {title}", "{item} {Title}"])("refuses a title naming another placeholder at load: %s", (title) => {
    expect(() => new MemoryForge({ pull: { title } })).toThrow(/pull\.title .* may name only \{item\}, \{title\}/);
  });

  it.each(["templates/pull.md", "/etc/passwd", ".landrace/../secrets.md", "../.landrace/pull.md"])(
    "refuses a description that is not a path under .landrace/ at load: %s",
    (description) => {
      expect(() => new MemoryForge({ pull: { description } })).toThrow(/is not a template file under \.landrace\//);
    },
  );

  it("fills the description with the item, its link and its spec's link", async () => {
    const root = await project("Item {item} — {link}\n\nSpec: {spec}\n");
    const { hooks, forge } = world({ root, pull: { description: ".landrace/templates/pull.md" } });
    const graph: Graph = {
      nodes: [{ id: "spec-7", kind: "document", title: "spec", link: "https://docs/7", closed: null, priority: null, origin: null, state: {} }],
      relationships: [{ from: "spec-7", to: "7", type: "documents" }],
    };
    expect((await opened(hooks, forge, snapshotOf({}, graph)))?.description).toBe("Item 7 — https://tracker/7\n\nSpec: https://docs/7\n");
  });

  it("leaves {spec} empty when no page documents the item", async () => {
    const root = await project("Spec: {spec}.");
    const { hooks, forge } = world({ root, pull: { description: ".landrace/templates/pull.md" } });
    expect((await opened(hooks, forge, snapshotOf({})))?.description).toBe("Spec: .");
  });

  it("refuses at start a template naming another placeholder, and passes one that names only its own", async () => {
    const bad = await project("Closes {title} and {key}");
    await expect(world({ root: bad, pull: { description: ".landrace/templates/pull.md" } }).hooks.preflight.check(ctx))
      .rejects.toThrow("forge: pull.description .landrace/templates/pull.md names {title}, {key}; it may name only {item}, {link}, {spec}");
    const good = await project("{item} {link} {spec}");
    await expect(world({ root: good, pull: { description: ".landrace/templates/pull.md" } }).hooks.preflight.check(ctx)).resolves.toBeUndefined();
  });

  it("refuses at start a template that is missing, and one a link takes outside .landrace/", async () => {
    const root = await project("x");
    await expect(world({ root, pull: { description: ".landrace/templates/none.md" } }).hooks.preflight.check(ctx))
      .rejects.toThrow(/pull\.description \.landrace\/templates\/none\.md cannot be read/);
    await writeFile(join(root, "outside.md"), "{item}");
    await symlink(join(root, "outside.md"), join(root, ".landrace", "templates", "linked.md"));
    await expect(world({ root, pull: { description: ".landrace/templates/linked.md" } }).hooks.preflight.check(ctx))
      .rejects.toThrow(/outside \.landrace\//);
  });

  it("refuses to open, marked a refusal, when the template went missing after start", async () => {
    const { hooks, forge } = world({ root: await project("x"), pull: { description: ".landrace/templates/gone.md" } });
    const failed = await opened(hooks, forge, snapshotOf({})).then(() => null, (e: unknown) => e);
    expect(String(failed)).toMatch(/cannot open a pull request for #7: pull\.description .* cannot be read/);
    expect(isEffectRefused(failed)).toBe(true);
    expect(forge.rows.size).toBe(0);
  });

  it("refuses a description on a forge that cannot say where the project is", async () => {
    await expect(world({ pull: { description: ".landrace/templates/pull.md" } }).hooks.preflight.check(ctx))
      .rejects.toThrow(/forge: .*no project root/);
  });
});

describe("placeholders", () => {
  it("names each unknown one once", () => {
    expect(unknownPlaceholders("{a} {item} {a} {b}", ["item"])).toEqual(["a", "b"]);
  });

  it("leaves an unknown one as written", () => {
    expect(fillPlaceholders("{item} {other}", { item: "{other}" })).toBe("{other} {other}");
  });
});
