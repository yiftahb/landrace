import { buildRegistry } from "#hooks/load.js";
import type { HookModule } from "#namespace.js";
import { defineArtifactHook, defineExecutor, defineOperator, definePostHook, definePreHook, definePreflight, defineSource } from "#hooks/contracts.js";
import type { HookContext, Node } from "#namespace.js";

const preflight = (id: string, check: () => Promise<void> = async () => {}) => definePreflight({ id, check });

const pre = (id: string, fragment: Record<string, unknown> = {}) =>
  definePreHook({ id, run: () => fragment });

const post = (id: string, handles: string[]) =>
  definePostHook({ id, handles, satisfied: () => false, apply: async () => {} });

const empty = async () => ({ nodes: [], relationships: [] });
const source = (id: string) => defineSource({ id, relations: [], list: empty, read: empty });

const candidate: Node = { id: "1", kind: "ticket", title: "t", link: "u", closed: null, priority: null, origin: null, state: {} };
const operator = (id: string) =>
  defineOperator({
    id,
    createTicket: async () => candidate,
    updateTicket: async () => candidate,
  });

const executor = (id: string) => defineExecutor({ id, run: async () => ({ text: "", sessionId: null }) });

const module_ = (specifier: string, exports: Record<string, unknown>): HookModule => ({ specifier, exports });

describe("a registry is assembled from what the modules exported", () => {
  it("files each branded export under its own kind", () => {
    const r = buildRegistry([
      module_("hooks/tracker.ts", {
        pre: pre("tracker"), post: post("tracker", ["tracker.label"]),
        source: source("tracker"), operator: operator("tracker"),
      }),
      module_("hooks/agent.ts", { claude: executor("claude") }),
    ]);

    expect(r.pre.map((h) => h.id)).toEqual(["tracker"]);
    expect(r.post.map((h) => h.id)).toEqual(["tracker"]);
    expect(r.source?.id).toBe("tracker");
    expect(r.operator?.id).toBe("tracker");
    expect([...r.executors.keys()]).toEqual(["claude"]);
  });

  /** Plural: several modules may each ship one, and the loader keeps load order. */
  it("files preflights in load order, plural", () => {
    const r = buildRegistry([
      module_("hooks/a.ts", { p: preflight("alpha") }),
      module_("hooks/b.ts", { p: preflight("beta") }),
    ]);
    expect(r.preflights.map((p) => p.id)).toEqual(["alpha", "beta"]);
  });

  it("reports no preflights as an empty list, not as absent", () => {
    const r = buildRegistry([module_("hooks/tracker.ts", { pre: pre("tracker") })]);
    expect(r.preflights).toEqual([]);
  });

  it("ignores what nobody branded, because a module may export helpers", () => {
    const r = buildRegistry([
      module_("hooks/tracker.ts", {
        helper: () => 1,
        VERSION: "2",
        // The shape of a post hook without the brand. Sniffing the shape is
        // exactly what the brand exists to replace.
        lookalike: { id: "x", handles: ["tracker.label"], satisfied: () => true, apply: async () => {} },
      }),
    ]);

    expect(r).toMatchObject({ pre: [], post: [], source: null, operator: null });
    expect(r.executors.size).toBe(0);
  });

  it("reports no source and no operator as absent rather than as an empty one", () => {
    const r = buildRegistry([module_("hooks/tracker.ts", { pre: pre("tracker") })]);
    expect(r.source).toBeNull();
    expect(r.operator).toBeNull();
  });
});

/**
 * §5: there are two phases, and an artifact is not a third. One hook object
 * answers both — `read` in the observe phase, `apply` in the act phase — so
 * the loader is what files it twice, not the author.
 */
describe("an artifact hook is one object in both phases", () => {
  const artifact = defineArtifactHook({
    id: "pr",
    handles: ["pr.comment"],
    satisfied: () => false,
    apply: async () => {},
    // Its own state, not a snapshot fragment: where it lands is the loader's
    // business, and tests/runner/artifacts.test.ts is where that bargain lives.
    read: async () => ({ number: 7 }),
  });

  it("registers its read as a pre hook and itself as the post hook", async () => {
    const r = buildRegistry([module_("hooks/pr.ts", { artifact })]);

    expect(r.pre.map((h) => h.id)).toEqual(["pr"]);
    expect(r.post[0]).toBe(artifact);
    await expect(r.pre[0]?.run({ snapshot: {} } as HookContext)).resolves.toEqual({ artifacts: { pr: { number: 7 } } });
  });
});

/**
 * Pre hooks run in order, each seeing what the previous ones produced, so the
 * order has to come from something a person wrote rather than from whatever
 * order an import happened to resolve in.
 */
describe("pre hooks keep a declared order", () => {
  it("follows the order the modules are listed in", () => {
    const r = buildRegistry([
      module_("hooks/b.ts", { h: pre("b") }),
      module_("hooks/a.ts", { h: pre("a") }),
    ]);
    expect(r.pre.map((h) => h.id)).toEqual(["b", "a"]);
  });

  /*
   * Within one module there is no declaration order to have: an ES module
   * namespace object sorts its keys, so the loader sorts too — the same
   * answer whatever produced the object, rather than one order under Node and
   * another under a transform.
   */
  it("orders several hooks from one module by export name", () => {
    const r = buildRegistry([module_("hooks/both.ts", { second: pre("2"), first: pre("1") })]);
    expect(r.pre.map((h) => h.id)).toEqual(["1", "2"]);
  });
});

describe("ambiguity halts, naming both sides", () => {
  it("refuses two sources", () => {
    expect(() =>
      buildRegistry([module_("hooks/a.ts", { s: source("alpha") }), module_("hooks/b.ts", { s: source("beta") })]),
    ).toThrow(/two sources[\s\S]*"alpha"[\s\S]*hooks\/a\.ts[\s\S]*"beta"[\s\S]*hooks\/b\.ts/);
  });

  it("refuses two operators", () => {
    expect(() =>
      buildRegistry([module_("hooks/a.ts", { o: operator("alpha") }), module_("hooks/b.ts", { o: operator("beta") })]),
    ).toThrow(/two operators[\s\S]*"alpha"[\s\S]*"beta"/);
  });

  // Delegated to createDispatcher rather than checked a second time here: one
  // rule, one implementation, and the collision is found at load rather than
  // on the first effect that happens to hit it.
  it("refuses two post hooks claiming one effect type", () => {
    expect(() =>
      buildRegistry([
        module_("hooks/a.ts", { p: post("alpha", ["tracker.label"]) }),
        module_("hooks/b.ts", { p: post("beta", ["tracker.label"]) }),
      ]),
    ).toThrow(/two post hooks handle "tracker\.label"[\s\S]*"alpha"[\s\S]*"beta"/);
  });

  it("refuses two pre hooks under one id", () => {
    expect(() =>
      buildRegistry([module_("hooks/a.ts", { h: pre("same") }), module_("hooks/b.ts", { h: pre("same") })]),
    ).toThrow(/two pre hooks[\s\S]*"same"[\s\S]*hooks\/a\.ts[\s\S]*hooks\/b\.ts/);
  });

  it("refuses two post hooks under one id", () => {
    expect(() =>
      buildRegistry([
        module_("hooks/a.ts", { h: post("same", ["a"]) }),
        module_("hooks/b.ts", { h: post("same", ["b"]) }),
      ]),
    ).toThrow(/two post hooks[\s\S]*"same"/);
  });

  it("refuses two executors under one id", () => {
    expect(() =>
      buildRegistry([module_("hooks/a.ts", { e: executor("claude") }), module_("hooks/b.ts", { e: executor("claude") })]),
    ).toThrow(/two executors[\s\S]*"claude"/);
  });

  it("refuses two preflights under one id", () => {
    expect(() =>
      buildRegistry([module_("hooks/a.ts", { p: preflight("same") }), module_("hooks/b.ts", { p: preflight("same") })]),
    ).toThrow(/two preflights[\s\S]*"same"[\s\S]*hooks\/a\.ts[\s\S]*hooks\/b\.ts/);
  });

  /*
   * An id names a hook within its own phase, not across the whole registry.
   * One integration writes both halves and calls them both by its own name —
   * the reference implementation in .landrace/hooks does exactly that — so an
   * id unique across phases would have made the obvious spelling illegal.
   */
  it("lets one integration use its own name in both phases", () => {
    const r = buildRegistry([module_("hooks/tracker.ts", { pre: pre("tracker"), post: post("tracker", ["x"]) })]);
    expect([r.pre[0]?.id, r.post[0]?.id]).toEqual(["tracker", "tracker"]);
  });
});
