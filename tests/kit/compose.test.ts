import { renderMarker } from "#conventions.js";
import { compose } from "#kit/compose.js";
import { hashOf } from "#kit/docs.js";
import { runPreflights } from "#runner/preflight.js";
import { createExternalState, MemoryDocs, MemoryForge, MemoryTracker } from "#testing/index.js";
import type {
  BriefTable, EffectTable, Graph, HookContext, Node, PullRecord, ReviewThread, RuntimeContext, Snapshot,
} from "#namespace.js";

/*
 * compose() is what a hook file exports: one tracker, one forge and one docs
 * integration made into the hooks the loader takes. Every clash between them
 * halts, naming both roles, rather than letting one quietly win.
 */

const logged: Array<{ event: string; data?: Record<string, unknown> }> = [];
const ctx: RuntimeContext = {
  config: {} as never, secrets: new Map(), signal: new AbortController().signal,
  log: (event, data) => { logged.push({ event, ...(data === undefined ? {} : { data }) }); },
};
const on = (item: string, snapshot: Snapshot = {}): HookContext => ({ ...ctx, item, snapshot });

/** The item's snapshot as a converge pass would hand it to satisfied(): its graph and its node. */
const snapshotOf = async (hooks: ReturnType<typeof compose>, item: string): Promise<Snapshot> => {
  const graph = await hooks.source.read(item, ctx);
  return { graph, node: graph.nodes.find((n) => n.id === item) };
};

const seeded = (): MemoryTracker => new MemoryTracker({ items: [{ id: "1" }, { id: "2", parent: "1" }] });

describe("compose refuses two roles claiming one thing", () => {
  it("halts on an effect type two roles both handle, naming both", () => {
    class Labelling extends MemoryForge {
      override effects(): EffectTable {
        return { ...super.effects(), "tracker.label": { satisfied: () => true, apply: async () => {} } };
      }
    }
    expect(() => compose({ tracker: seeded(), forge: new Labelling() }))
      .toThrow(/"tracker\.label".*the tracker.*the forge/);
  });

  it("halts on a docs effect type the tracker handles too", () => {
    class Publishing extends MemoryTracker {
      override effects(): EffectTable {
        return { ...super.effects(), "artifact.publish": { satisfied: () => true, apply: async () => {} } };
      }
    }
    expect(() => compose({ tracker: new Publishing(), docs: new MemoryDocs() }))
      .toThrow(/"artifact\.publish".*the tracker.*the docs/);
  });

  it("halts on a briefing key two roles both give, naming both", () => {
    class Briefing extends MemoryTracker {
      override briefs(): BriefTable {
        return { diff: async () => "the tracker's diff" };
      }
    }
    expect(() => compose({ tracker: new Briefing(), forge: new MemoryForge() })).toThrow(/"diff".*the tracker.*the forge/);
  });

  it("halts on a role that briefs `history` itself, which is the timeline both roles share", () => {
    class Historian extends MemoryTracker {
      override briefs(): BriefTable {
        return { history: async () => "mine" };
      }
    }
    expect(() => compose({ tracker: new Historian() })).toThrow(/"history".*the tracker/);
  });

  it("halts on a snapshot path two roles both provide", () => {
    class Heads extends MemoryTracker {
      override provides(): string[] {
        return [...super.provides(), "git"];
      }
    }
    class Git extends MemoryForge {
      override provides(): string[] {
        return ["git"];
      }
    }
    expect(() => compose({ tracker: new Heads(), forge: new Git() })).toThrow(/"git".*the tracker.*the forge/);
  });

  it("halts on a path under another role's, whose fragment would replace the other's whole", async () => {
    class Nested extends MemoryForge {
      override provides(): string[] {
        return ["item.pulls"];
      }
    }
    expect(() => compose({ tracker: seeded(), forge: new Nested() })).toThrow(/"item".*the tracker.*the forge/);
  });

  it("refuses a node id two roles both report, on list and on read, naming both", async () => {
    class Squatting extends MemoryForge {
      protected override node(pull: PullRecord): Node {
        return { ...super.node(pull), id: "1" };
      }
    }
    const tracker = seeded();
    const forge = new Squatting();
    forge.add("2");
    const hooks = compose({ tracker, forge });
    await expect(hooks.source.list(ctx)).rejects.toThrow(/"1".*the tracker.*the forge/);
    await expect(hooks.source.read("2", ctx)).rejects.toThrow(/"1".*the tracker.*the forge/);
  });
});

describe("nodes.close, the one effect two roles share", () => {
  it("closes each id through the role whose kind it is", async () => {
    const closed: string[] = [];
    class Tracker extends MemoryTracker {
      override async close(id: string, how: "done" | "dropped"): Promise<void> {
        closed.push(`tracker ${id} ${how}`);
        return super.close(id, how);
      }
    }
    class Forge extends MemoryForge {
      override async closePull(pull: number): Promise<void> {
        closed.push(`forge ${pull}`);
        return super.closePull(pull);
      }
    }
    const forge = new Forge();
    const pr = forge.add("2");
    const hooks = compose({ tracker: new Tracker({ items: [{ id: "1" }, { id: "2", parent: "1" }] }), forge });
    const effect = { type: "nodes.close", ids: [pr, "2"] };

    expect(hooks.post.handles.filter((t) => t === "nodes.close")).toHaveLength(1);
    expect(hooks.post.satisfied(await snapshotOf(hooks, "1"), effect)).toBe(false);
    await hooks.post.apply(effect, on("1", await snapshotOf(hooks, "1")));

    expect(closed).toEqual(["forge 1", "tracker 2 dropped"]);
    expect(hooks.post.satisfied(await snapshotOf(hooks, "1"), effect)).toBe(true);
  });

  // Core orders a close so a pull request is dropped before the item it
  // implements; the split must not regroup the ids and undo that.
  it("closes the ids in the order they were planned, whichever role each is", async () => {
    const closed: string[] = [];
    class Tracker extends MemoryTracker {
      override async close(id: string, how: "done" | "dropped"): Promise<void> {
        closed.push(id);
        return super.close(id, how);
      }
    }
    class Forge extends MemoryForge {
      override async closePull(pull: number): Promise<void> {
        closed.push(`pr-${pull}`);
        return super.closePull(pull);
      }
    }
    const forge = new Forge();
    const pr = forge.add("3");
    const hooks = compose({ tracker: new Tracker({ items: [{ id: "1" }, { id: "2", parent: "1" }, { id: "3", parent: "1" }] }), forge });
    await hooks.post.apply({ type: "nodes.close", ids: ["2", pr, "3"] }, on("1", await snapshotOf(hooks, "1")));
    expect(closed).toEqual(["2", "pr-1", "3"]);
  });

  it("halts on an id no role closes: one not in the graph, or a document", async () => {
    const docs = new MemoryDocs();
    const hooks = compose({ tracker: seeded(), forge: new MemoryForge(), docs });
    await docs.publish("1", "# Spec");
    const snapshot = await snapshotOf(hooks, "1");

    expect(() => hooks.post.satisfied(snapshot, { type: "nodes.close", ids: ["9"] })).toThrow(/"9".*no role closes/);
    expect(() => hooks.post.satisfied(snapshot, { type: "nodes.close", ids: ["spec-1"] })).toThrow(/"spec-1".*document.*no role closes/);
    await expect(hooks.post.apply({ type: "nodes.close", ids: ["spec-1"] }, on("1", snapshot))).rejects.toThrow(/no role closes/);
  });
});

describe("a role changed by subclassing", () => {
  it("applies an effect a MemoryTracker subclass adds, then reads it back as satisfied", async () => {
    class Assigning extends MemoryTracker {
      override effects(): EffectTable {
        return {
          ...super.effects(),
          "tracker.assign": {
            satisfied: (snapshot, effect) =>
              ((snapshot.node as Node | undefined)?.state.assignees as string[] | undefined ?? []).includes(String(effect.login)),
            apply: async (effect, { item }) => { this.row(item).assignees.push(String(effect.login)); },
          },
        };
      }
    }
    const hooks = compose({ tracker: new Assigning({ items: [{ id: "1" }] }), forge: new MemoryForge() });
    const assign = { type: "tracker.assign", login: "someone" };

    expect(hooks.post.handles).toContain("tracker.assign");
    expect(hooks.post.satisfied(await snapshotOf(hooks, "1"), assign)).toBe(false);
    await hooks.post.apply(assign, on("1", await snapshotOf(hooks, "1")));
    expect(hooks.post.satisfied(await snapshotOf(hooks, "1"), assign)).toBe(true);
  });
});

describe("the preflight", () => {
  it("names the role whose check failed", async () => {
    class Refusing extends MemoryForge {
      async check(): Promise<void> {
        throw new Error("the token cannot read pull requests");
      }
    }
    const hooks = compose({ tracker: seeded(), forge: new Refusing() });
    await expect(runPreflights([hooks.preflight], ctx))
      .rejects.toThrow('preflight "project" failed: the forge: the token cannot read pull requests');
  });

  it("passes when no role has a check", async () => {
    await expect(runPreflights([compose({ tracker: seeded() }).preflight], ctx)).resolves.toBeUndefined();
  });
});

describe("the graph compose reads", () => {
  it("halts a read on a pull request tied to two items, and lists it with no edge", async () => {
    const tracker = new MemoryTracker({ items: [{ id: "7" }, { id: "8", parent: "7" }] });
    const forge = new MemoryForge();
    // Opened against #7, from #8's branch: it names both, and a read of either sees both.
    const pr = forge.add("7", { branch: "landrace/8" });
    const hooks = compose({ tracker, forge });

    await expect(hooks.source.read("7", ctx)).rejects.toThrow("pull request #1 is tied to #7 and #8");
    await expect(hooks.source.read("8", ctx)).rejects.toThrow("pull request #1 is tied to #7 and #8");
    const listed = await hooks.source.list(ctx);
    expect(listed.nodes.map((n) => n.id)).not.toContain(pr);
  });

  it("halts a read on a pull request from an unrelated item's landrace/ head naming this one", async () => {
    const tracker = new MemoryTracker({ items: [{ id: "8" }, { id: "12" }] });
    const forge = new MemoryForge();
    // #12's branch, its text closing #8: #12 is outside #8's neighbourhood, and still an item.
    forge.add("8", { branch: "landrace/12" });
    const hooks = compose({ tracker, forge });

    await expect(hooks.source.read("8", ctx)).rejects.toThrow("pull request #1 is tied to #8 and #12");
    await expect(hooks.source.read("12", ctx)).rejects.toThrow("pull request #1 is tied to #8 and #12");
  });

  it("ties a pull request to its item by a landrace/{item} head or by the items it names, and nothing else", async () => {
    class Forked extends MemoryForge {
      override async pullsNaming(item: string): Promise<PullRecord[]> {
        return (await super.pullsNaming(item)).map((p) => (p.number === 3 ? { ...p, branch: undefined, items: [] } : p));
      }
      override async pulls(): Promise<PullRecord[]> {
        return (await super.pulls()).map((p) => (p.number === 3 ? { ...p, branch: undefined, items: [] } : p));
      }
    }
    const forge = new Forked();
    forge.add("1", { branch: "landrace/1" });
    forge.add("1", { branch: "api/1" });
    forge.add("1", { branch: "landrace/1" }); // a fork's: no branch of ours, naming nothing
    const hooks = compose({ tracker: seeded(), forge });

    const edges = (g: Graph) => g.relationships.filter((r) => r.type === "implements").map((r) => r.from).sort();
    expect(edges(await hooks.source.read("1", ctx))).toEqual(["pr-1", "pr-2"]);
    expect(edges(await hooks.source.list(ctx))).toEqual(["pr-1", "pr-2"]);
  });

  // A workflow with two branches per item names the second landrace/{item}-api:
  // that head names no item there is, so the pull request is the one its text names.
  it("reads a landrace/ head that is no item's as naming nothing", async () => {
    const state = createExternalState({ items: [{ id: "1" }] });
    const pr = state.openPull("1", { branch: "landrace/1-api" });
    const tied = { from: pr, to: "1", type: "implements" };
    expect((await state.source.read("1", ctx)).relationships).toContainEqual(tied);
    expect((await state.source.list(ctx)).relationships).toContainEqual(tied);
  });

  it("declares every role's relationship types, and draws a published page beside its item", async () => {
    const docs = new MemoryDocs();
    const hooks = compose({ tracker: seeded(), forge: new MemoryForge(), docs });
    await docs.publish("2", "# Spec");

    expect(hooks.source.relations.map((r) => r.type)).toEqual(["child-of", "implements", "documents"]);
    expect((await hooks.source.read("2", ctx)).relationships).toContainEqual({ from: "spec-2", to: "2", type: "documents" });
    expect((await hooks.source.read("1", ctx)).nodes.map((n) => n.id)).not.toContain("spec-2");
    expect((await hooks.source.list(ctx)).relationships).toContainEqual({ from: "spec-2", to: "2", type: "documents" });
  });

  it("lists the items without the pages when a page's link cannot be had, and says so", async () => {
    class Unlinked extends MemoryDocs {
      override async link(): Promise<string> {
        throw new Error("the site answered 502");
      }
    }
    const docs = new Unlinked();
    await docs.publish("1", "# Spec");
    logged.length = 0;
    const listed = await compose({ tracker: seeded(), docs }).source.list(ctx);
    expect(listed.nodes.map((n) => n.id)).toEqual(["1", "2"]);
    expect(logged).toEqual([expect.objectContaining({ event: "docs.skipped", data: expect.objectContaining({ reason: expect.stringMatching(/502/) }) })]);
  });

  it("lists the items and their work without the pages when the docs listing fails, and says so", async () => {
    class Unlisted extends MemoryDocs {
      override async published(): Promise<Set<string>> {
        throw new Error("the listing timed out");
      }
    }
    const docs = new Unlisted();
    await docs.publish("1", "# Spec");
    logged.length = 0;
    const listed = await compose({ tracker: seeded(), docs }).source.list(ctx);
    expect(listed.nodes.map((n) => n.id)).toEqual(["1", "2"]);
    expect(logged).toEqual([expect.objectContaining({ event: "docs.skipped", data: expect.objectContaining({ reason: expect.stringMatching(/timed out/) }) })]);
  });
});

describe("the briefing", () => {
  it("is one history, the tracker's comments and the forge's threads in the order they happened", async () => {
    class Threaded extends MemoryForge {
      override async threads(): Promise<ReviewThread[]> {
        return [{
          id: "T1", resolved: false, path: "src/a.ts", line: 3, comments: 1, at: "2026-01-01T00:00:30Z",
          first: { body: "Rename this.", author: "a-reviewer" }, last: { body: "Rename this.", author: "a-reviewer" },
        }];
      }
    }
    const tracker = new MemoryTracker({ items: [{ id: "1" }] });
    tracker.post("1", "a-person", "first");           // 00:00:00
    tracker.post("1", "a-person", "second");          // 00:00:01
    tracker.row("1").comments.push({ id: 9, body: "last", created_at: "2026-01-01T00:01:00Z", user: { login: "a-person" } });
    const forge = new Threaded();
    forge.add("1", { branch: "landrace/1", merged: true });
    const hooks = compose({ tracker, forge });

    const brief = await hooks.source.brief?.(on("1", await snapshotOf(hooks, "1")));
    expect(brief?.history).toBe(
      "@a-person: first\n\n@a-person: second\n\n" +
      "On PR #1 (merged): src/a.ts:3 — raised by @a-reviewer — open\nRename this.\n\n@a-person: last",
    );
    expect(Object.keys(brief ?? {}).sort()).toEqual(["diff", "history", "threads"]);
  });

  it("hands a step the spec page's text under the docs role's own artifact", async () => {
    const docs = new MemoryDocs();
    const hooks = compose({ tracker: seeded(), docs });
    expect(await hooks.spec?.brief?.(on("1"))).toEqual({ content: "No spec has been published for this item." });
    await docs.publish("1", "# Spec");
    expect(await hooks.spec?.brief?.(on("1"))).toEqual({ content: "# Spec" });
  });
});

describe("the hooks compose hands back", () => {
  it("are the project's, under one id, and the docs role's artifact is the spec", () => {
    const hooks = compose({ tracker: seeded(), forge: new MemoryForge(), docs: new MemoryDocs() });
    expect([hooks.preflight, hooks.source, hooks.operator, hooks.pre, hooks.post].map((h) => h.id)).toEqual(Array(5).fill("project"));
    expect(hooks.spec?.id).toBe("spec");
    expect(compose({ tracker: seeded() }).spec).toBeUndefined();
  });
});

describe("the spec artifact", () => {
  it("publishes once, and reads back its hash and link", async () => {
    const state = createExternalState({ items: [{ id: "1" }] });
    const publish = { type: "artifact.publish", artifact: "spec", body: "# Spec\n\nDo it." };
    const artifacts = async (): Promise<Snapshot> => ({ artifacts: { spec: await state.spec.read(on("1")) } });

    expect(await state.spec.read(on("1"))).toEqual({ exists: false, hash: null, url: "memory://specs/1" });
    expect(state.spec.satisfied(await artifacts(), publish)).toBe(false);
    await state.spec.apply(publish, on("1"));
    expect(await state.spec.read(on("1"))).toEqual({ exists: true, hash: hashOf(publish.body), url: "memory://specs/1" });
    expect(state.spec.satisfied(await artifacts(), publish)).toBe(true);
    expect(state.post.handles).not.toContain("artifact.publish");
  });
});

describe("the tracker's comments", () => {
  it("checks a comment effect against its own login, with no bot in the snapshot", async () => {
    const state = createExternalState({ items: [{ id: "1" }] });
    const effect = { type: "tracker.comment", kind: "enter", stage: "spec", round: 1, marker: "enter:spec:1", body: "Entered." };
    const pre = async (): Promise<Snapshot> => ({ ...(await state.pre.run(on("1"))) });

    expect(state.post.satisfied(await pre(), effect)).toBe(false);
    state.say("1", `forged${renderMarker({ stage: "spec", kind: "enter", round: 1, marker: "enter:spec:1" })}`);
    expect(state.post.satisfied(await pre(), effect)).toBe(false);
    await state.post.apply(effect, on("1"));
    expect(state.post.satisfied(await pre(), effect)).toBe(true);
  });
});
