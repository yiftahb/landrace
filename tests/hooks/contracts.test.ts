import { defineArtifactHook, defineExecutor, defineOperator, definePostHook, definePreHook, defineSource, hookKindOf } from "../../src/hooks/contracts.js";

/**
 * The loader classifies an exported value by the brand its define* helper
 * stamped. Structural sniffing — "it has `handles`, so it is a post hook" — is
 * a guess, and this codebase halts rather than guesses: a guess that goes
 * wrong registers an integration half-way and leaves the other half silently
 * unreachable.
 */
describe("a define* helper brands what it returns", () => {
  const cases = {
    pre: definePreHook({ id: "a", run: () => ({}) }),
    post: definePostHook({ id: "b", handles: ["x"], satisfied: () => false, apply: async () => {} }),
    artifact: defineArtifactHook({
      id: "c", handles: ["y"], satisfied: () => false, apply: async () => {}, read: async () => ({}),
    }),
    source: defineSource({ id: "d", list: async () => [] }),
    operator: defineOperator({
      id: "e",
      createTicket: async ({ title }) => ({ ticket: 1, title, url: "u", labels: [] }),
      updateTicket: async (ticket) => ({ ticket, title: "t", url: "u", labels: [] }),
    }),
    executor: defineExecutor({ id: "f", run: async () => ({ text: "", sessionId: null }) }),
  };

  for (const [kind, hook] of Object.entries(cases)) {
    it(`reads back a ${kind} hook as a ${kind} hook`, () => {
      expect(hookKindOf(hook)).toBe(kind);
    });
  }

  // An artifact hook is one object in two phases, not two hooks: the brand
  // says "artifact" and the loader is what puts it in both lists.
  it("brands an artifact hook as its own kind, not as a post hook", () => {
    expect(hookKindOf(cases.artifact)).not.toBe("post");
  });

  /*
   * A hook is still a plain data object. The brand is a non-enumerable symbol
   * so it stays out of Object.keys, out of JSON, and out of any equality check
   * a test or a log line makes over a hook's own fields.
   */
  it("keeps the brand out of the hook's own visible shape", () => {
    expect(Object.keys(cases.pre)).toEqual(["id", "run"]);
    expect(JSON.parse(JSON.stringify(cases.source))).toEqual({ id: "d" });
  });

  it("reads anything nobody branded as no kind at all", () => {
    // A hook module is free to export helpers, constants and types; the loader
    // ignores them rather than failing on them.
    expect(hookKindOf({ id: "x", handles: ["y"], satisfied: () => true, apply: async () => {} })).toBeNull();
    expect(hookKindOf(null)).toBeNull();
    expect(hookKindOf("pre")).toBeNull();
    expect(hookKindOf(() => {})).toBeNull();
  });
});
