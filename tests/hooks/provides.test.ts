import { createExternalState } from "#testing/index.js";
import { createFakeTracker } from "#tests/support/fake-tracker.js";
import type { HookContext, PreHook } from "#namespace.js";

/**
 * A tracker declares exactly what it puts in the snapshot.
 *
 * Both directions are load-bearing, because `landrace validate`'s
 * path-coverage rule is answered from `provides` and from nothing else: a
 * path declared and not provided passes a workflow whose predicate reads
 * nothing (`outputs.spec.kind` and `lastEvent.actor` both looked right,
 * matched nothing, and left half the shipped workflow unreachable), and a
 * path provided and not declared flags a workflow that is fine — and a
 * validator that flags healthy workflows gets switched off.
 *
 * Asked of both trackers, because the two had drifted: the fake declared
 * `ticket.stage` and no `tracker.bot`, the shipped integration declared
 * `tracker.bot` and provided `ticket.state`, `ticket.url` and an undeclared
 * `ticket.stage` that nothing read. `landrace validate` answered differently
 * depending on which one was loaded, which is exactly the drift
 * `conventions.ts` warns about.
 */
const pathsIn = (fragment: Record<string, unknown>): string[] => {
  const out: string[] = [];
  for (const [key, value] of Object.entries(fragment)) {
    out.push(key);
    // One level deep, which is the depth `provides` is written at. An array
    // is a leaf: `entries[0].stage` is not a path a predicate names.
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const child of Object.keys(value as Record<string, unknown>)) out.push(`${key}.${child}`);
    }
  }
  return [...new Set(out)].sort();
};

const declaredBy = (hook: PreHook): string[] => [...(hook.provides ?? [])].sort();

describe("a tracker declares exactly what it puts in the snapshot", () => {
  it("the shipped GitHub integration", async () => {
    const gh = createFakeTracker([{ number: 1, labels: ["lr:auto", "lr:stage:spec"] }]);
    const hook = gh.registry.pre[0];
    if (!hook) throw new Error("the fake tracker registered no pre hook");
    expect(hook.id).toBe("github");

    const fragment = await hook.run({ ...gh.ctx, ticket: "1", snapshot: {} } as HookContext);
    expect(pathsIn(fragment)).toEqual(declaredBy(hook));
  });

  it("the in-memory tracker", async () => {
    const state = createExternalState({ tickets: [{ id: "1", labels: ["lr:auto", "lr:stage:spec"] }] });
    const fragment = await state.pre.run({ ticket: "1", snapshot: {} } as HookContext);
    expect(pathsIn(fragment)).toEqual(declaredBy(state.pre));
    expect(declaredBy(state.pre)).toEqual(["entries", "ticket", "ticket.body", "ticket.comments"]);
  });

  /*
   * And neither says again what the ticket's node already says. The title,
   * the labels and the assignees are the source's reading of the ticket; a
   * copy of them in a pre hook's fragment is a second reading, free to
   * disagree with the one the engine placed the ticket from.
   */
  it("and neither of them copies what the ticket's node carries", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    const github = gh.registry.pre[0];
    if (!github) throw new Error("the fake tracker registered no pre hook");
    const state = createExternalState({ tickets: [{ id: "1" }] });
    for (const hook of [github, state.pre]) {
      for (const path of ["ticket.number", "ticket.title", "ticket.url", "ticket.state", "ticket.labels", "ticket.assignees"]) {
        expect({ hook: hook.id, path, declared: declaredBy(hook).includes(path) }).toEqual({ hook: hook.id, path, declared: false });
      }
    }
  });

  /*
   * And neither spells the position a second time. Position is derived once,
   * in buildSnapshot, out of the node's labels; a `ticket.stage` beside it is a
   * second answer to one question, free to disagree with the first.
   */
  it("and neither of them spells the position a second time", async () => {
    const gh = createFakeTracker([{ number: 1, labels: ["lr:stage:spec"] }]);
    const github = gh.registry.pre[0];
    if (!github) throw new Error("the fake tracker registered no pre hook");
    const state = createExternalState({ tickets: [{ id: "1", labels: ["lr:stage:spec"] }] });

    for (const hook of [github, state.pre]) {
      const fragment = await hook.run({ ...gh.ctx, ticket: "1", snapshot: {} } as HookContext);
      expect(pathsIn(fragment)).not.toContain("ticket.stage");
      expect(declaredBy(hook)).not.toContain("ticket.stage");
    }
  });

  /*
   * What both are expected to answer, so a workflow written against one runs
   * on the other. Where they genuinely differ — a bot login the fake knows
   * without asking — they differ honestly, in what they declare as well as in
   * what they provide.
   */
  it("and both answer the vocabulary every workflow reads", () => {
    const gh = createFakeTracker([{ number: 1 }]);
    const github = gh.registry.pre[0];
    if (!github) throw new Error("the fake tracker registered no pre hook");
    const state = createExternalState({ tickets: [{ id: "1" }] });

    // Who a ticket belongs to, its labels and its title are the node's now
    // (`node.state.assignees`, `node.state.labels`, `node.title`), read by the
    // engine from either source the same way.
    const shared = ["ticket.body", "ticket.comments", "entries"];
    expect(declaredBy(github)).toEqual(expect.arrayContaining(shared));
    expect(declaredBy(state.pre)).toEqual(expect.arrayContaining(shared));
  });
});
