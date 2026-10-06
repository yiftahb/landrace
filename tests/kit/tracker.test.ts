import { LABELS, MAX_SUBGRAPH_NODES, renderMarker, renderOrigin } from "#conventions.js";
import { deriveRel } from "#core/index.js";
import { compose } from "#kit/compose.js";
import {
  BaseTracker, BRIEF_ITEM_CHARS, BRIEF_RELATED_CHARS, botLoginOf, closeSatisfied, commentSatisfied, commentsOf, createdAtOf, labelSatisfied,
  nodesCloseSatisfied, priorityFromLabels, statusSatisfied, itemNode, updatedAtOf, wroteIt,
} from "#kit/tracker.js";
import { createExternalState, MemoryDocs, MemoryForge, MemoryTracker } from "#testing/index.js";
import type { Effect, ExternalItem, Graph, HookContext, ItemRecord, Node, OpenRelations, RuntimeContext, Snapshot } from "#namespace.js";

const BOT = "landrace-bot";

const item = (fields: Partial<Node> = {}): Node => ({
  id: "7", kind: "item", title: "T", link: "https://tracker.example/7", closed: null, priority: null, origin: null,
  state: { labels: [] }, ...fields,
});

const snapshotWith = (fields: Record<string, unknown>): Snapshot => fields as unknown as Snapshot;

/** A comment carrying the marker `marker`, as the tracker hands it back. */
const marked = (marker: string, login = BOT): { body: string; user: { login: string } } => ({
  body: `said${renderMarker({ stage: "spec", kind: "enter", round: 1, marker })}`,
  user: { login },
});

describe("commentsOf", () => {
  it("is the item's comments, and none when the pre hook put none there", () => {
    const comments = [{ body: "a" }];
    expect(commentsOf(snapshotWith({ item: { comments } }))).toBe(comments);
    expect(commentsOf(snapshotWith({}))).toEqual([]);
  });
});

describe("wroteIt", () => {
  it("is ours by login, either spelling of an app's, and never a stranger's", () => {
    expect(wroteIt({ user: { login: BOT } }, BOT)).toBe(true);
    expect(wroteIt({ user: { login: "someone" } }, BOT)).toBe(false);
    expect(wroteIt({ user: null }, BOT)).toBe(false);
  });
});

describe("botLoginOf", () => {
  it("is the login the pre hook recorded, lower-cased", () => {
    expect(botLoginOf(snapshotWith({ tracker: { bot: " Landrace-Bot " } }))).toBe("landrace-bot");
  });

  it("halts when the snapshot does not say who we post as", () => {
    expect(() => botLoginOf(snapshotWith({}))).toThrow(/does not record the login landrace posts as/);
    expect(() => botLoginOf(snapshotWith({ tracker: { bot: " " } }))).toThrow(/does not record/);
  });
});

describe("labelSatisfied", () => {
  const effect: Effect = { type: "tracker.label", add: ["a"], remove: ["b"] };

  it("is every label added and every one removed", () => {
    expect(labelSatisfied(snapshotWith({ node: item({ state: { labels: ["a"] } }) }), effect)).toBe(true);
    expect(labelSatisfied(snapshotWith({ node: item({ state: { labels: ["a", "b"] } }) }), effect)).toBe(false);
    expect(labelSatisfied(snapshotWith({ node: item() }), effect)).toBe(false);
  });
});

describe("statusSatisfied", () => {
  it("is the item carrying the stage's label", () => {
    const effect: Effect = { type: "tracker.status", value: "build" };
    expect(statusSatisfied(snapshotWith({ node: item({ state: { labels: [LABELS.stage("build")] } }) }), effect)).toBe(true);
    expect(statusSatisfied(snapshotWith({ node: item({ state: { labels: [LABELS.stage("spec")] } }) }), effect)).toBe(false);
  });
});

describe("commentSatisfied", () => {
  const effect: Effect = { type: "tracker.comment", marker: "enter:spec:1" };
  const on = (...comments: unknown[]): Snapshot => snapshotWith({ tracker: { bot: BOT }, item: { comments } });

  it("is a comment we wrote carrying exactly this marker", () => {
    expect(commentSatisfied(on(marked("enter:spec:1")), effect)).toBe(true);
  });

  it("is not a stranger's comment carrying the marker", () => {
    expect(commentSatisfied(on(marked("enter:spec:1", "someone")), effect)).toBe(false);
  });

  it("is not a marker that only starts the same, nor the token in prose", () => {
    expect(commentSatisfied(on(marked("enter:spec:10")), effect)).toBe(false);
    expect(commentSatisfied(on({ body: "enter:spec:1", user: { login: BOT } }), effect)).toBe(false);
  });

  it("halts on a comment with no marker, which nothing could reconcile", () => {
    expect(() => commentSatisfied(on(), { type: "tracker.comment" })).toThrow(/with no marker cannot be reconciled/);
  });
});

describe("closeSatisfied", () => {
  it("is the item closed, either way", () => {
    expect(closeSatisfied(snapshotWith({ node: item({ closed: "dropped" }) }))).toBe(true);
    expect(closeSatisfied(snapshotWith({ node: item() }))).toBe(false);
  });
});

describe("nodesCloseSatisfied", () => {
  it("is every named node closed", () => {
    const graph = { nodes: [item({ id: "8", closed: "done" }), item({ id: "9" })], relationships: [] };
    expect(nodesCloseSatisfied(snapshotWith({ graph }), { type: "nodes.close", ids: ["8"] })).toBe(true);
    expect(nodesCloseSatisfied(snapshotWith({ graph }), { type: "nodes.close", ids: ["8", "9"] })).toBe(false);
  });
});

describe("priorityFromLabels", () => {
  it("is the one P label's number, and none when there are two", () => {
    expect(priorityFromLabels(["bug", "P2"])).toEqual({ priority: 2, found: ["P2"] });
    expect(priorityFromLabels(["P1", "P3"])).toEqual({ priority: null, found: ["P1", "P3"] });
    expect(priorityFromLabels([])).toEqual({ priority: null, found: [] });
  });
});

describe("createdAtOf", () => {
  it("is the time in milliseconds, and absent rather than NaN", () => {
    expect(createdAtOf("2026-09-30T00:00:00Z")).toEqual({ createdAt: Date.parse("2026-09-30T00:00:00Z") });
    expect(createdAtOf("not a time")).toEqual({});
    expect(createdAtOf(undefined)).toEqual({});
  });
});

describe("updatedAtOf", () => {
  it("is the time in milliseconds, and absent rather than NaN", () => {
    expect(updatedAtOf("2026-09-30T12:00:00Z")).toEqual({ updatedAt: Date.parse("2026-09-30T12:00:00Z") });
    expect(updatedAtOf("not a time")).toEqual({});
    expect(updatedAtOf(undefined)).toEqual({});
  });
});

describe("itemNode", () => {
  const origin = { parent: "3", stage: "triage", round: 1 };
  const fields = {
    id: "7", title: "Split", link: "https://tracker.example/7", closed: null, labels: ["P1", "lr:auto"],
    assignees: ["someone"], body: `body${renderOrigin(origin)}`, author: BOT, editor: undefined,
    createdAt: "2026-09-30T00:00:00Z", updatedAt: "2026-09-30T12:00:00Z",
  };

  it("is the item as the engine reads one", () => {
    expect(itemNode(fields, BOT)).toEqual({
      id: "7", kind: "item", title: "Split", link: "https://tracker.example/7", closed: null, priority: 1, origin,
      state: { labels: ["P1", "lr:auto"], assignees: ["someone"] }, createdAt: Date.parse("2026-09-30T00:00:00Z"),
      updatedAt: Date.parse("2026-09-30T12:00:00Z"),
    });
  });

  // What `tracker.field`'s satisfied reads: the fields as read, a null among them, and none at all from a tracker that read none.
  it("carries the fields its tracker read as state.fields, and no fields when it read none", () => {
    const read = { customfield_1: ["R&D"], customfield_2: null, customfield_3: 3 };
    expect(itemNode({ ...fields, fields: read }, BOT).state).toEqual({ labels: ["P1", "lr:auto"], assignees: ["someone"], fields: read });
    expect(itemNode(fields, BOT).state).not.toHaveProperty("fields");
  });

  it("carries no update time for an item whose tracker gave none", () => {
    expect(itemNode({ ...fields, updatedAt: undefined }, BOT)).not.toHaveProperty("updatedAt");
  });

  it("reads no origin from a body a stranger has edited since, nor one a stranger wrote", () => {
    expect(itemNode({ ...fields, editor: "someone" }, BOT).origin).toBeNull();
    expect(itemNode({ ...fields, editor: BOT }, BOT).origin).toEqual(origin);
    expect(itemNode({ ...fields, author: "someone" }, BOT).origin).toBeNull();
  });

  // Jira's priority field, and the in-memory tracker's: a tracker that has
  // one says so, and its P labels are then only labels.
  it("takes a tracker's own priority over the P labels, and its absence of one too", () => {
    expect(itemNode({ ...fields, priority: 3 }, BOT).priority).toBe(3);
    expect(itemNode({ ...fields, priority: null }, BOT).priority).toBeNull();
    expect(itemNode({ ...fields, priority: undefined }, BOT).priority).toBe(1);
  });
});

/*
 * `{brief.project.body}`: the item's own text, which is the whole brief of a
 * workflow with no spec — fastlane's build. Read through `compose`, as a
 * prompt reads it, so what is checked is the base every tracker inherits:
 * the in-memory one here, GitHub's in production.
 */
describe("the body briefing", () => {
  const ctx: RuntimeContext = { config: {} as never, secrets: new Map(), signal: new AbortController().signal, log: () => {} };
  const on = (item: string): HookContext => ({ ...ctx, item, snapshot: {} });
  const bodyOf = async (body: string): Promise<string | undefined> => {
    const hooks = compose({ tracker: new MemoryTracker({ items: [{ id: "7", body }] }), forge: new MemoryForge() });
    return (await hooks.source.brief?.(on("7"), new Set(["body"])))?.body;
  };

  it("is the item's own text", async () => {
    expect(await bodyOf("Make the save button blue.\n\nOnly on the settings page.")).toBe(
      "Make the save button blue.\n\nOnly on the settings page.",
    );
  });

  it("says so when the item has no text beyond its title, rather than leave a hole in the prompt", async () => {
    expect(await bodyOf("  \n")).toBe("This item has no description beyond its title.");
  });

  it("leaves off the marker Landrace stamps on an item it created", async () => {
    expect(await bodyOf(`Split out: the export.${renderOrigin({ parent: "3", stage: "breakdown", round: 1 })}`))
      .toBe("Split out: the export.");
  });

  it("keeps a body at its bound whole, and cuts one past it, saying where and at what", async () => {
    const whole = "x".repeat(BRIEF_ITEM_CHARS);
    expect(BRIEF_ITEM_CHARS).toBe(16_000);
    expect(await bodyOf(whole)).toBe(whole);
    expect(await bodyOf(`${whole}y`)).toBe(`${whole}\n\n[the item's text is cut here at 16,000 characters]`);
  });

  it("is a key of the project's own, beside the forge's and the shared history, claimed by no other role", async () => {
    const hooks = compose({ tracker: new MemoryTracker({ items: [{ id: "7" }] }), forge: new MemoryForge(), docs: new MemoryDocs() });
    expect(Object.keys((await hooks.source.brief?.(on("7"))) ?? {}).sort())
      .toEqual(["body", "ci", "diff", "history", "related", "threads"]);
  });
});

/*
 * `tracker.close`, done by default — a finished item — or dropped, which a
 * workflow says when a person asked for the item to be dropped: a tracker
 * that keeps a reason (GitHub's "not planned") then reports it as such.
 * Satisfied either way, so a person's own close is never overruled.
 */
describe("tracker.close", () => {
  const ctx: RuntimeContext = { config: {} as never, secrets: new Map(), signal: new AbortController().signal, log: () => {} };
  const world = () => {
    const tracker = new MemoryTracker({ items: [{ id: "7" }] });
    const hooks = compose({ tracker });
    const snapshot = async (): Promise<Snapshot> => {
      const graph = await hooks.source.read("7", ctx);
      return { graph, node: graph.nodes.find((n) => n.id === "7") };
    };
    const close = async (effect: Effect): Promise<void> =>
      hooks.post.apply(effect, { ...ctx, item: "7", snapshot: await snapshot() });
    return { tracker, hooks, snapshot, close };
  };

  it("closes the item as done when it says nothing of how", async () => {
    const { tracker, close } = world();
    await close({ type: "tracker.close" });
    expect(tracker.row("7").closed).toBe("done");
  });

  it("closes it as dropped when it says so, and is satisfied after", async () => {
    const { tracker, hooks, snapshot, close } = world();
    const effect = { type: "tracker.close", how: "dropped" };
    expect(hooks.post.satisfied(await snapshot(), effect)).toBe(false);
    await close(effect);
    expect(tracker.row("7").closed).toBe("dropped");
    expect(hooks.post.satisfied(await snapshot(), effect)).toBe(true);
  });

  it("leaves an item already closed as it is, whichever way it is asked to close it", async () => {
    const { tracker, hooks, snapshot, close } = world();
    tracker.row("7").closed = "done";
    expect(hooks.post.satisfied(await snapshot(), { type: "tracker.close", how: "dropped" })).toBe(true);
    await close({ type: "tracker.close", how: "dropped" });
    expect(tracker.row("7").closed).toBe("done");
  });

  it("refuses a way of closing it does not know, rather than closing it as done", async () => {
    const { tracker, close } = world();
    await expect(close({ type: "tracker.close", how: "wontfix" })).rejects.toThrow(/"done" or "dropped", not "wontfix"/);
    expect(tracker.row("7").closed).toBeNull();
  });
});

/*
 * `tracker.comment`'s `visibility`, handed to the integration as it is, for a
 * tracker that tells the team's notes from what the requester reads. Absent
 * stays absent: the integration's default is internal, never a guess here.
 */
describe("tracker.comment's visibility", () => {
  const ctx: RuntimeContext = { config: {} as never, secrets: new Map(), signal: new AbortController().signal, log: () => {} };
  class Seen extends MemoryTracker {
    visibilities: unknown[] = [];
    override async comment(id: string, body: string, _ctx?: RuntimeContext, opts?: { visibility?: unknown }): Promise<void> {
      this.visibilities.push(opts?.visibility);
      await super.comment(id, body);
    }
  }
  const post = async (effect: Effect): Promise<Seen> => {
    const tracker = new Seen({ items: [{ id: "7" }] });
    await compose({ tracker }).post.apply(effect, { ...ctx, item: "7", snapshot: {} });
    return tracker;
  };

  it("passes public and internal through, and none when the effect names none", async () => {
    for (const visibility of ["public", "internal", undefined]) {
      const effect = { type: "tracker.comment", kind: "output", marker: "m", body: "b", ...(visibility ? { visibility } : {}) };
      expect((await post(effect)).visibilities).toEqual([visibility]);
    }
  });

  it("refuses a visibility it does not know, posting nothing", async () => {
    const tracker = new Seen({ items: [{ id: "7" }] });
    const apply = compose({ tracker }).post.apply({ type: "tracker.comment", kind: "output", marker: "m", body: "b", visibility: "loud" }, { ...ctx, item: "7", snapshot: {} });
    await expect(apply).rejects.toThrow(/"internal" or "public", not "loud"/);
    expect(tracker.row("7").comments).toEqual([]);
  });
});

/*
 * Relationships between items, as the base reads them off `ItemRecord.related`
 * and writes them through the two calls an integration supplies. The engine
 * gives no type a meaning; the base inspects `blocked-by` only to report a
 * cycle of it, as a fact on the node for the workflow to route on.
 */
describe("relationships on the tracker base", () => {
  const ctx: RuntimeContext = { config: {} as never, secrets: new Map(), signal: new AbortController().signal, log: () => {} };
  const B = "blocked-by";
  const nodeOf = (g: Graph, id: string): Node | undefined => g.nodes.find((n) => n.id === id);
  /** Each id blocked by the next: `chain("1", "2", "3")` is #1 blocked by #2, blocked by #3. */
  const chain = (...ids: string[]): Array<Partial<ExternalItem>> =>
    ids.map((id, i) => ({ id, related: ids[i + 1] === undefined ? [] : [{ type: B, to: ids[i + 1] as string }] }));

  // A read draws only the item's own relationships, never another item's
  // toward it: `rel.blocked-by.in` would count none in every read.
  it("declares blocked-by, which an item may have many of and a read draws outward only, beside child-of", () => {
    expect(new MemoryTracker().relations()).toEqual([
      { type: "child-of", singular: true }, { type: B, singular: false, outwardOnly: true },
    ]);
  });

  // Not found is not missing, at the kit's default too: a tracker that reads
  // no relationship declares none, so a workflow gated on one fails validate.
  it("declares no relationship but the parent for a tracker that does not say it reads one", () => {
    class Unread extends MemoryTracker {
      protected override readRelations(): string[] {
        return [];
      }
    }
    expect(new Unread().relations()).toEqual([{ type: "child-of", singular: true }]);
  });

  describe("in the listing", () => {
    it("draws an edge per relationship, to the listed item itself when it is listed", async () => {
      const g = await new MemoryTracker({ items: [{ id: "10" }, { id: "12", related: [{ type: B, to: "10" }] }] }).list(ctx);
      expect(g.relationships).toEqual([{ from: "12", to: "10", type: B }]);
      expect(g.nodes.map((n) => n.id)).toEqual(["10", "12"]);
      expect(g.nodes.filter((n) => n.placeholder)).toEqual([]);
    });

    it("stands in for a related item it does not list with a placeholder, built from the relationship alone", async () => {
      const tracker = new MemoryTracker({
        items: [
          { id: "12", related: [{ type: B, to: "3", title: "Long gone", link: "https://elsewhere/3", closed: "done" }] },
          { id: "13", related: [{ type: B, to: "3", title: "Long gone", link: "https://elsewhere/3", closed: "done" }] },
        ],
      });
      const g = await tracker.list(ctx);
      expect(g.nodes.filter((n) => n.id === "3")).toEqual([{
        id: "3", kind: "item", title: "Long gone", link: "https://elsewhere/3", closed: "done", priority: null, origin: null,
        state: { labels: [], assignees: [] }, placeholder: true,
      }]);
      expect(g.relationships).toEqual([{ from: "12", to: "3", type: B }, { from: "13", to: "3", type: B }]);
    });

    // Two answers about one item that disagree are a tracker caught between
    // two reads: the open one is drawn, so nothing reads as done that may not be.
    it("draws a placeholder two items disagree about as open", async () => {
      const g = await new MemoryTracker({
        items: [
          { id: "12", related: [{ type: B, to: "x-far-3", closed: "done" }] },
          { id: "13", related: [{ type: B, to: "x-far-3", closed: null }] },
          { id: "14", related: [{ type: B, to: "x-far-3", closed: "dropped" }] },
        ],
      }).list(ctx);
      expect(g.nodes.filter((n) => n.id === "x-far-3").map((n) => n.closed)).toEqual([null]);
    });

    // Which item, but not what state it is in: drawn open, never guessed
    // done, and said to be unreadable — and the item's relationships are not whole.
    it("draws a related item it knows but could not read as an open placeholder that says so", async () => {
      const tracker = new MemoryTracker({ items: [{ id: "12", related: [{ type: B, to: "x-far-3", title: "Upstream", closed: "done", unreadable: true }] }] });
      for (const g of [await tracker.list(ctx), await tracker.read("12", ctx)]) {
        expect(nodeOf(g, "x-far-3")).toMatchObject({ title: "Upstream", closed: null, placeholder: true, unreadable: true });
        expect(nodeOf(g, "12")?.state).toMatchObject({ relatedUnreadable: true });
        expect(g.relationships).toEqual([{ from: "12", to: "x-far-3", type: B }]);
      }
    });

    it("draws a placeholder one item could read and another could not as read, and one read as closed as unreadable", async () => {
      const read = await new MemoryTracker({
        items: [{ id: "12", related: [{ type: B, to: "x-far-3", unreadable: true }] }, { id: "13", related: [{ type: B, to: "x-far-3" }] }],
      }).list(ctx);
      expect(read.nodes.filter((n) => n.id === "x-far-3").map((n) => [n.closed, n.unreadable])).toEqual([[null, undefined]]);
      const closed = await new MemoryTracker({
        items: [{ id: "12", related: [{ type: B, to: "x-far-3", closed: "done" }] }, { id: "13", related: [{ type: B, to: "x-far-3", unreadable: true }] }],
      }).list(ctx);
      expect(closed.nodes.filter((n) => n.id === "x-far-3").map((n) => [n.closed, n.unreadable])).toEqual([[null, true]]);
    });

    it("draws an edge reported twice once", async () => {
      const g = await new MemoryTracker({ items: [{ id: "10" }, { id: "12", related: [{ type: B, to: "10" }, { type: B, to: "10" }] }] }).list(ctx);
      expect(g.relationships).toEqual([{ from: "12", to: "10", type: B }]);
    });
  });

  describe("in an item's read", () => {
    it("draws the item's own relationships, with a placeholder for each related item outside its neighbourhood", async () => {
      const tracker = new MemoryTracker({
        items: [
          { id: "1" },
          { id: "10", title: "Blocker", labels: ["lr:stage:build", "lr:auto"], assignees: ["someone"] },
          { id: "12", parent: "1", related: [{ type: B, to: "10" }, { type: B, to: "1" }, { type: B, to: "13" }] },
          { id: "13", parent: "12", related: [{ type: B, to: "20" }] },
          { id: "20" },
        ],
      });
      const g = await tracker.read("12", ctx);
      expect(g.nodes.map((n) => n.id).sort()).toEqual(["1", "10", "12", "13"]);
      // #10 is listed, but not in #12's neighbourhood: drawn from the relationship, never read for itself.
      expect(nodeOf(g, "10")).toEqual({
        id: "10", kind: "item", title: "Blocker", link: "memory://items/10", closed: null, priority: null, origin: null,
        state: { labels: [], assignees: [] }, placeholder: true,
      });
      // Its parent and its child are related too: their own nodes, not a second one each.
      expect(nodeOf(g, "1")?.placeholder).toBeUndefined();
      expect(nodeOf(g, "13")?.placeholder).toBeUndefined();
      expect(g.relationships).toEqual(expect.arrayContaining([
        { from: "12", to: "10", type: B }, { from: "12", to: "1", type: B }, { from: "12", to: "13", type: B },
        { from: "12", to: "1", type: "child-of" }, { from: "13", to: "12", type: "child-of" },
      ]));
      // Only the item's own: #13's blocker is #13's business.
      expect(g.relationships).not.toContainEqual({ from: "13", to: "20", type: B });
    });

    it("refuses a read whose placeholders take it past the nodes one read may carry", async () => {
      const many = Array.from({ length: MAX_SUBGRAPH_NODES }, (_, i) => ({ type: B, to: `x-${i}`, closed: "done" as const }));
      await expect(new MemoryTracker({ items: [{ id: "12", related: many }] }).read("12", ctx))
        .rejects.toThrow(`#12 has more than the ${MAX_SUBGRAPH_NODES} nodes one read may carry`);
      await expect(new MemoryTracker({ items: [{ id: "12", related: many.slice(1) }] }).read("12", ctx)).resolves.toBeDefined();
    });
  });

  describe("facts on the node", () => {
    it("says relatedUnreadable of an item whose relationships were cut short, in the listing and in its read", async () => {
      const tracker = new MemoryTracker({ items: [{ id: "10" }, { id: "12", relatedComplete: false, related: [{ type: B, to: "10" }] }] });
      expect(nodeOf(await tracker.list(ctx), "12")?.state).toEqual({ labels: [], assignees: [], relatedUnreadable: true });
      expect(nodeOf(await tracker.read("12", ctx), "12")?.state).toEqual({ labels: [], assignees: [], relatedUnreadable: true });
      // Read whole, it says nothing at all: the fact is there only when it is true.
      expect(nodeOf(await tracker.list(ctx), "10")?.state).toEqual({ labels: [], assignees: [] });
      expect(nodeOf(await tracker.read("10", ctx), "10")?.state).toEqual({ labels: [], assignees: [] });
    });

    it("reads a relationship to an id no item can have as unreadable, and draws nothing to it", async () => {
      const tracker = new MemoryTracker({ items: [{ id: "12", related: [{ type: B, to: "not an id" }] }] });
      for (const g of [await tracker.list(ctx), await tracker.read("12", ctx)]) {
        expect(nodeOf(g, "12")?.state).toMatchObject({ relatedUnreadable: true });
        expect(g.nodes.map((n) => n.id)).toEqual(["12"]);
        expect(g.relationships).toEqual([]);
      }
    });

    it.each([
      ["two", [["1", "2"], ["2", "1"]]],
      ["three", [["1", "2"], ["2", "3"], ["3", "1"]]],
      ["one, blocked by itself", [["1", "1"]]],
    ])("says dependencyCycle of every item on a cycle of %s, in the listing and in each one's read", async (_, pairs) => {
      const tracker = new MemoryTracker({ items: pairs.map(([id, to]) => ({ id: id as string, related: [{ type: B, to: to as string }] })) });
      const listed = await tracker.list(ctx);
      for (const [id] of pairs) {
        expect(nodeOf(listed, id as string)?.state).toMatchObject({ dependencyCycle: true });
        expect(nodeOf(await tracker.read(id as string, ctx), id as string)?.state).toMatchObject({ dependencyCycle: true });
      }
    });

    it("says nothing of a chain, of a cycle broken by a closed item, or of one the item only leads into", async () => {
      const tracker = new MemoryTracker({
        items: [
          ...chain("1", "2", "3"),
          // #5 blocks #4 and #4 blocks #5, but #5 is closed: that is no cycle.
          { id: "4", related: [{ type: B, to: "5" }] }, { id: "5", closed: "done", related: [{ type: B, to: "4" }] },
          // #6 waits on #7, which is on a cycle with #8: #6 is not.
          { id: "6", related: [{ type: B, to: "7" }] }, { id: "7", related: [{ type: B, to: "8" }] }, { id: "8", related: [{ type: B, to: "7" }] },
        ],
      });
      const listed = await tracker.list(ctx);
      for (const id of ["1", "2", "3", "4", "5", "6"]) {
        expect(nodeOf(listed, id)?.state).not.toHaveProperty("dependencyCycle");
        expect(nodeOf(await tracker.read(id, ctx), id)?.state).not.toHaveProperty("dependencyCycle");
      }
      for (const id of ["7", "8"]) {
        expect(nodeOf(listed, id)?.state).toMatchObject({ dependencyCycle: true });
        expect(nodeOf(await tracker.read(id, ctx), id)?.state).toMatchObject({ dependencyCycle: true });
      }
    });

    it("reads a cycle of blocked-by only: a cycle of another type is the workflow's to make anything of", async () => {
      const tracker = new MemoryTracker({ items: [{ id: "1", related: [{ type: "x", to: "2" }] }, { id: "2", related: [{ type: "x", to: "1" }] }] });
      expect(nodeOf(await tracker.read("1", ctx), "1")?.state).not.toHaveProperty("dependencyCycle");
      expect(nodeOf(await tracker.list(ctx), "1")?.state).not.toHaveProperty("dependencyCycle");
    });

    /*
     * Every waiting item is read every tick. A walk paying one read per
     * blocker cost a chain of N items N(N-1)/2 reads a tick — a breakdown of
     * twenty ordered children, 190 — so the walk reads the open items' list
     * once instead, and only for an item with an open blocker of its own.
     */
    it("reads each item of a chain of 20 at the same small cost, wherever it is in the chain", async () => {
      const ids = Array.from({ length: 20 }, (_, i) => String(i + 1));
      const tracker = new MemoryTracker({ items: chain(...ids) });
      const one = jest.spyOn(tracker, "item");
      const all = jest.spyOn(tracker, "items");
      for (const id of ids) {
        one.mockClear();
        all.mockClear();
        await tracker.read(id, ctx);
        expect([one.mock.calls.length, all.mock.calls.length]).toEqual([1, id === "20" ? 0 : 1]);
      }
      one.mockClear();
      all.mockClear();
      await tracker.list(ctx);
      expect([one.mock.calls.length, all.mock.calls.length]).toEqual([0, 1]);
    });

    it("reads no list for an item whose blockers are all closed, or someone else's", async () => {
      const tracker = new MemoryTracker({
        items: [{ id: "1", related: [{ type: B, to: "2" }, { type: B, to: "x-far-3" }] }, { id: "2", closed: "done" }],
      });
      const all = jest.spyOn(tracker, "items");
      await tracker.read("1", ctx);
      expect(all).not.toHaveBeenCalled();
    });

    it("refuses a read whose list of open items cannot be had, rather than read it as no cycle", async () => {
      class Unlistable extends MemoryTracker {
        override async items(): Promise<ItemRecord[]> {
          throw new Error("more than 10 pages of open issues");
        }
      }
      const tracker = new Unlistable({ items: [...chain("1", "2"), { id: "3" }] });
      await expect(tracker.read("1", ctx)).rejects.toThrow("more than 10 pages of open issues");
      // An item with no open blocker of its own pays nothing, and fails on nothing.
      await expect(tracker.read("3", ctx)).resolves.toBeDefined();
    });

    it("says relatedUnreadable of an item whose walk meets a blocker whose own relationships were cut short", async () => {
      const tracker = new MemoryTracker({ items: chain("1", "2", "3") });
      tracker.row("3").relatedComplete = false;
      for (const id of ["1", "2"]) {
        expect(nodeOf(await tracker.list(ctx), id)?.state).toMatchObject({ relatedUnreadable: true });
        expect(nodeOf(await tracker.read(id, ctx), id)?.state).toMatchObject({ relatedUnreadable: true });
      }
    });

    it("says relatedUnreadable of an item whose walk meets a blocker blocked by an id no item can have", async () => {
      const tracker = new MemoryTracker({ items: [...chain("1", "2"), { id: "3", closed: "done" }] });
      tracker.row("2").related = [{ type: B, to: "not an id" }];
      expect(nodeOf(await tracker.list(ctx), "1")?.state).toEqual({ labels: [], assignees: [], relatedUnreadable: true });
      expect(nodeOf(await tracker.read("1", ctx), "1")?.state).toEqual({ labels: [], assignees: [], relatedUnreadable: true });
    });

    it("says relatedUnreadable of a closed item whose relationships were cut short, and walks nothing from it", async () => {
      const tracker = new MemoryTracker({ items: [{ id: "1", closed: "done", relatedComplete: false, related: [{ type: B, to: "2" }] }, { id: "2" }] });
      const asked = jest.spyOn(tracker, "item");
      expect(nodeOf(await tracker.read("1", ctx), "1")?.state).toEqual({ labels: [], assignees: [], relatedUnreadable: true });
      expect(asked.mock.calls.map(([id]) => id)).toEqual(["1"]);
    });

    it("refuses a read whose walk goes past the nodes one read may carry, and takes one at the bound", async () => {
      const ids = Array.from({ length: MAX_SUBGRAPH_NODES + 1 }, (_, i) => String(i + 1));
      const tracker = new MemoryTracker({ items: chain(...ids) });
      await expect(tracker.read("1", ctx)).rejects.toThrow(
        `#1 has more than the ${MAX_SUBGRAPH_NODES} nodes one read may carry; a graph known to be short is not one to decide from`,
      );
      // From #2 the walk is exactly MAX_SUBGRAPH_NODES items long, #2 itself among them.
      expect(nodeOf(await tracker.read("2", ctx), "2")?.state).toEqual({ labels: [], assignees: [] });
      // The listing cannot fail every item for one: it says #1's cannot be told.
      const listed = await tracker.list(ctx);
      expect(nodeOf(listed, "1")?.state).toMatchObject({ relatedUnreadable: true });
      expect(nodeOf(listed, "2")?.state).toEqual({ labels: [], assignees: [] });
    });

    /*
     * Another repository's item, which the tracker does not own: the walk
     * never reads it, and it holds the item back by the state its
     * relationship reports. A cycle through it goes unseen.
     */
    it("does not walk to an item it does not own, which gates by its relationship alone", async () => {
      const tracker = new MemoryTracker({ items: [{ id: "12", related: [{ type: B, to: "x-far-5", title: "Far" }] }] });
      const asked = jest.spyOn(tracker, "item");
      const all = jest.spyOn(tracker, "items");
      const read = await tracker.read("12", ctx);
      expect(asked.mock.calls.map(([id]) => id)).toEqual(["12"]);
      expect(all).not.toHaveBeenCalled();
      expect(nodeOf(read, "12")?.state).toEqual({ labels: [], assignees: [] });
      expect(nodeOf(read, "x-far-5")).toMatchObject({ placeholder: true, closed: null, title: "Far" });
      const listed = await tracker.list(ctx);
      expect(asked.mock.calls.map(([id]) => id)).toEqual(["12"]);
      expect(nodeOf(listed, "12")?.state).toEqual({ labels: [], assignees: [] });
    });

    /*
     * Its own item, missing from the open items it lists — closed since, or
     * gone — holds the item back by what the relationship says and no
     * further: it is no cycle, and nothing unreadable. Read and listing agree.
     */
    it("stops at a blocker it owns that its open items do not hold, and reads nothing more of it", async () => {
      class Unlisted extends MemoryTracker {
        override async items(): Promise<ItemRecord[]> {
          return (await super.items()).filter((t) => t.id !== "2");
        }
      }
      const tracker = new Unlisted({ items: [{ id: "1", related: [{ type: B, to: "2" }] }, { id: "2", related: [{ type: B, to: "1" }] }] });
      const asked = jest.spyOn(tracker, "item");
      for (const g of [await tracker.read("1", ctx), await tracker.list(ctx)]) {
        expect(nodeOf(g, "1")?.state).toEqual({ labels: [], assignees: [] });
      }
      expect(asked.mock.calls.map(([id]) => id)).toEqual(["1"]);
    });

    // Even one its list happens to hold: what it does not own it never walks.
    it("does not walk through an item it does not own, in the listing as in a read", async () => {
      class Disowning extends MemoryTracker {
        protected override ownsId(id: string): boolean {
          return id !== "2";
        }
      }
      const tracker = new Disowning({ items: [{ id: "1", related: [{ type: B, to: "2" }] }, { id: "2", related: [{ type: B, to: "1" }] }] });
      expect(nodeOf(await tracker.list(ctx), "1")?.state).toEqual({ labels: [], assignees: [] });
      expect(nodeOf(await tracker.read("1", ctx), "1")?.state).toEqual({ labels: [], assignees: [] });
    });

    /*
     * A read's walk asks `openRelations`, which an integration may answer
     * more cheaply than listing every open item in full; the listing judges
     * from what it already holds. Whichever answers, an open item it could
     * not read all the relationships of is one the walk cannot see past.
     */
    describe("over openRelations, an integration's own answer", () => {
      class Answering extends MemoryTracker {
        answer: OpenRelations = { open: [], edges: [], partial: [] };
        override async items(): Promise<ItemRecord[]> {
          throw new Error("a read's walk asked for every item in full");
        }
        protected override async openRelations(type: string): Promise<OpenRelations> {
          expect(type).toBe(B);
          return this.answer;
        }
      }

      it("judges a read's cycle by what it answers, and lists no item in full", async () => {
        // Its own rows say nothing of #2's or #3's blockers: only the answer does.
        const tracker = new Answering({ items: [...chain("1", "2"), { id: "3" }] });
        tracker.answer = { open: ["1", "2", "3"], edges: [{ from: "2", to: "3" }, { from: "3", to: "1" }], partial: [] };
        expect(nodeOf(await tracker.read("1", ctx), "1")?.state).toMatchObject({ dependencyCycle: true });
      });

      it("stops where it holds a blocker no longer open, and says nothing", async () => {
        const tracker = new Answering({ items: chain("1", "2") });
        tracker.answer = { open: ["1"], edges: [{ from: "2", to: "1" }], partial: [] };
        expect(nodeOf(await tracker.read("1", ctx), "1")?.state).toEqual({ labels: [], assignees: [] });
      });

      it("says relatedUnreadable when the walk passes an item whose relationships it could not read all of, and only then", async () => {
        const tracker = new Answering({ items: chain("1", "2") });
        tracker.answer = { open: ["1", "2", "9"], edges: [], partial: ["2"] };
        expect(nodeOf(await tracker.read("1", ctx), "1")?.state).toEqual({ labels: [], assignees: [], relatedUnreadable: true });
        tracker.answer = { open: ["1", "2", "9"], edges: [], partial: ["9"] };
        expect(nodeOf(await tracker.read("1", ctx), "1")?.state).toEqual({ labels: [], assignees: [] });
      });
    });

    it("stops at a blocker its open items say is closed, whatever the relationship said of it", async () => {
      class Lagging extends MemoryTracker {
        override async items(): Promise<ItemRecord[]> {
          return (await super.items()).map((t) => (t.id === "2" ? { ...t, closed: "done" as const } : t));
        }
      }
      const tracker = new Lagging({ items: [{ id: "1", related: [{ type: B, to: "2" }] }, { id: "2", related: [{ type: B, to: "1" }] }] });
      expect(nodeOf(await tracker.read("1", ctx), "1")?.state).not.toHaveProperty("dependencyCycle");
    });
  });

  describe("writes", () => {
    it("relates and unrelates through the operator, and says which types it writes", async () => {
      const state = createExternalState({ items: [{ id: "10" }, { id: "12" }] });
      expect(state.operator.relates()).toEqual([B]);
      await state.operator.relate("12", B, "10", ctx);
      expect(state.item("12").related).toEqual([{ type: B, to: "10" }]);
      expect((await state.source.read("12", ctx)).relationships).toContainEqual({ from: "12", to: "10", type: B });
      await state.operator.unrelate("12", B, "10", ctx);
      expect(state.item("12").related).toEqual([]);
      expect(state.writes()).toEqual(["relate #12 blocked-by #10", "unrelate #12 blocked-by #10"]);
    });

    it("refuses a type it does not write, naming the ones it does, and writes nothing", async () => {
      const state = createExternalState({ items: [{ id: "10" }, { id: "12" }] });
      await expect(state.operator.relate("12", "duplicates", "10", ctx))
        .rejects.toThrow('cannot relate #12 to #10 as "duplicates": this tracker writes only "blocked-by"');
      await expect(state.operator.unrelate("12", "duplicates", "10", ctx))
        .rejects.toThrow('cannot unrelate #12 from #10 as "duplicates": this tracker writes only "blocked-by"');
      expect(state.writes()).toEqual([]);
    });

    it("refuses every type on a tracker that declares none writable", async () => {
      class Unwritten extends MemoryTracker {
        protected override writableRelations(): string[] {
          return [];
        }
      }
      const hooks = compose({ tracker: new Unwritten({ items: [{ id: "10" }, { id: "12" }] }) });
      expect(hooks.operator.relates()).toEqual([]);
      await expect(hooks.operator.relate("12", B, "10", ctx)).rejects.toThrow('as "blocked-by": this tracker writes no relationship');
    });

    it("creates an item related as asked, before it is labelled, so nothing works it unrelated", async () => {
      const state = createExternalState({ items: [{ id: "10" }] });
      const node = await state.operator.createItem({ title: "after", labels: ["lr:auto"], relate: [{ type: B, item: "10" }] }, ctx);
      expect(node.id).toBe("2");
      expect(state.item("2").related).toEqual([{ type: B, to: "10" }]);
      expect(state.writes()).toEqual(["create a new item", "relate #2 blocked-by #10", "addLabels #2"]);
    });

    it("makes a relationship asked for twice once", async () => {
      const state = createExternalState({ items: [{ id: "10" }] });
      await state.operator.createItem({ title: "after", relate: [{ type: B, item: "10" }, { type: B, item: "10" }] }, ctx);
      expect(state.writes()).toEqual(["create a new item", "relate #2 blocked-by #10"]);
    });

    // A tracker's own UI may allow one, and reading it still flags a cycle;
    // landrace never writes one.
    it("refuses to relate an item to itself, and writes nothing", async () => {
      const state = createExternalState({ items: [{ id: "12" }] });
      await expect(state.operator.relate("12", B, "12", ctx)).rejects.toThrow('cannot relate #12 to itself as "blocked-by"');
      expect(state.writes()).toEqual([]);
    });

    it("refuses a type it does not write before creating anything", async () => {
      const state = createExternalState({ items: [{ id: "10" }] });
      await expect(state.operator.createItem({ title: "after", relate: [{ type: "duplicates", item: "10" }] }, ctx))
        .rejects.toThrow('cannot relate a new item to #10 as "duplicates": this tracker writes only "blocked-by"');
      expect(state.writes()).toEqual([]);
    });

    // An id a tracker owns names an item it can read: one it cannot is
    // refused before anything is created, so nothing is left behind.
    it("refuses a relationship to an item of its own it cannot read before creating anything", async () => {
      class Owning extends MemoryTracker {
        protected override ownsId(): boolean {
          return true;
        }
      }
      const tracker = new Owning({ items: [{ id: "1" }, { id: "10" }] });
      await expect(compose({ tracker }).operator.createItem({ title: "after", parent: "1", relate: [{ type: B, item: "10" }, { type: B, item: "99" }] }, ctx))
        .rejects.toThrow('cannot relate a new item to #99 as "blocked-by": #99 could not be read: no such item #99');
      expect(tracker.writes()).toEqual([]);
    });

    /*
     * A relationship that still cannot be made after the item exists — a
     * permission, an outage — would leave an open child nobody works holding
     * its parent for ever. It is closed as dropped, as a sub-item that cannot
     * be linked is, and the sentence names it.
     */
    class Refusing extends MemoryTracker {
      protected override async addRelation(item: string, type: string, other: string): Promise<void> {
        if (other === "11") throw new Error("the tracker answered 502");
        return super.addRelation(item, type, other);
      }
    }

    it("closes the item it created as dropped when a relationship cannot be made, so it holds nothing up", async () => {
      const tracker = new Refusing({ items: [{ id: "1" }, { id: "10" }, { id: "11" }] });
      const hooks = compose({ tracker });
      await expect(hooks.operator.createItem({ title: "after", parent: "1", labels: ["lr:auto"], relate: [{ type: B, item: "11" }, { type: B, item: "10" }] }, ctx))
        .rejects.toThrow("#4 was created, but relating it failed: blocked-by #11: the tracker answered 502; it was closed as dropped, so it holds nothing up");
      expect(tracker.row("4")).toMatchObject({ title: "after", labels: [], closed: "dropped", parent: "1" });
      expect(tracker.writes()).toEqual(["create a new item under #1", "relate #4 blocked-by #10", "close #4"]);
      const parent = deriveRel(await hooks.source.read("1", ctx), "1", ["child-of"]);
      expect(parent.ok && parent.rel["child-of"]?.in).toMatchObject({ total: 0, dropped: 1, open: [] });
    });

    it("says so when the item it could not relate cannot be closed either, and that it is still open and unlabelled", async () => {
      class Stuck extends Refusing {
        override async close(): Promise<void> {
          throw new Error("the tracker answered 502");
        }
      }
      const tracker = new Stuck({ items: [{ id: "1" }, { id: "11" }] });
      await expect(compose({ tracker }).operator.createItem({ title: "after", labels: ["lr:auto"], relate: [{ type: B, item: "11" }] }, ctx))
        .rejects.toThrow(
          "#3 was created, but relating it failed: blocked-by #11: the tracker answered 502; and closing it as dropped failed too, " +
          "so it is still open, and unlabelled so nothing works it: the tracker answered 502",
        );
      expect(tracker.row("3")).toMatchObject({ labels: [], closed: null });
    });

    it("refuses a relationship to an item that is not its own before creating anything", async () => {
      const state = createExternalState({ items: [{ id: "10" }] });
      await expect(state.operator.createItem({ title: "after", relate: [{ type: B, item: "10" }, { type: B, item: "x-far-9" }] }, ctx))
        .rejects.toThrow('cannot relate a new item to #x-far-9 as "blocked-by": #x-far-9 is not one of this tracker\'s own items, and landrace relates only those');
      expect(state.writes()).toEqual([]);
    });

    /*
     * Everything `relate` and `unrelate` would refuse, asked before anything
     * is written, so a caller with a list of them can refuse the whole list
     * having written none of it. The reason alone: the caller says what it asked.
     */
    it("says, before any write, why an item cannot be related to another, or nothing when it can", async () => {
      const state = createExternalState({ items: [{ id: "10" }, { id: "12" }] });
      expect(await state.operator.checkRelate("12", B, "10", ctx)).toBeNull();
      expect(await state.operator.checkRelate("12", "duplicates", "10", ctx)).toBe('this tracker writes only "blocked-by"');
      expect(await state.operator.checkRelate("12", B, "12", ctx)).toBe("an item is never related to itself");
      expect(await state.operator.checkRelate("12", B, "99", ctx)).toBe("#99 is not one of this tracker's own items, and landrace relates only those");
      expect(state.writes()).toEqual([]);
    });

    it("says an item of its own it cannot read cannot be related", async () => {
      class Owning extends MemoryTracker {
        protected override ownsId(): boolean {
          return true;
        }
      }
      const hooks = compose({ tracker: new Owning({ items: [{ id: "12" }] }) });
      expect(await hooks.operator.checkRelate("12", B, "99", ctx)).toBe("#99 could not be read: no such item #99");
    });
  });
});

/*
 * Relationships a tracker reads both ways — Jira's issue links of a type a
 * project maps, say — and the status a tracker keeps beside the stage label.
 * An inward one is drawn from the other end toward the item, so it counts
 * in `rel.<type>.in`; a status is on the node's state, and on a
 * placeholder's, for a condition to read. `{brief.project.related}` says
 * both to a prompt, from the graph the snapshot holds.
 */
describe("relationships read both ways, and statuses", () => {
  const ctx: RuntimeContext = { config: {} as never, secrets: new Map(), signal: new AbortController().signal, log: () => {} };
  const R = "relates";
  const D = "duplicates";

  /** A memory tracker that reads `relates` and `duplicates` both ways, its records given `extra` on top of its rows. */
  class Linked extends MemoryTracker {
    extra: Record<string, Partial<ItemRecord>> = {};
    protected override readBothWays(): string[] {
      return [R, D];
    }
    override async items(): Promise<ItemRecord[]> {
      return (await super.items()).map((r) => ({ ...r, ...this.extra[r.id] }));
    }
    override async item(id: string): Promise<ItemRecord> {
      return { ...(await super.item(id)), ...this.extra[id] };
    }
  }
  const linked = (items: Array<Partial<ExternalItem>>, extra: Record<string, Partial<ItemRecord>>): Linked => {
    const tracker = new Linked({ items });
    tracker.extra = extra;
    return tracker;
  };

  it("declares a type read both ways with no outward-only mark, so rel.<type>.in is provided too", () => {
    expect(new Linked().relations()).toEqual([
      { type: "child-of", singular: true }, { type: "blocked-by", singular: false, outwardOnly: true },
      { type: R, singular: false }, { type: D, singular: false },
    ]);
  });

  it("carries an item's status and its category on the node's state, and nothing where the tracker said none", () => {
    const record: ItemRecord = {
      id: "7", title: "T", link: "l", closed: null, labels: [], assignees: [], body: "", author: undefined, editor: undefined,
      createdAt: undefined, parent: null,
    };
    expect(itemNode({ ...record, status: "Pending R&D Fix", statusCategory: "indeterminate" }, BOT).state)
      .toEqual({ labels: [], assignees: [], status: "Pending R&D Fix", statusCategory: "indeterminate" });
    expect(itemNode(record, BOT).state).toEqual({ labels: [], assignees: [] });
  });

  it("draws an inward relationship from the other end toward the item, in the listing and the read, with the placeholder's status", async () => {
    const tracker = linked([{ id: "12" }], {
      "12": {
        related: [
          { type: D, to: "x-far-5", title: "The original", link: "https://elsewhere/5", closed: null, direction: "in", status: "In Progress", statusCategory: "indeterminate" },
          { type: R, to: "x-far-6", title: "A fix", link: "https://elsewhere/6", closed: "done", status: "Done", statusCategory: "done" },
        ],
      },
    });
    for (const g of [await tracker.list(ctx), await tracker.read("12", ctx)]) {
      expect(g.relationships).toEqual(expect.arrayContaining([
        { from: "x-far-5", to: "12", type: D }, { from: "12", to: "x-far-6", type: R },
      ]));
      expect(g.nodes.find((n) => n.id === "x-far-5")).toEqual({
        id: "x-far-5", kind: "item", title: "The original", link: "https://elsewhere/5", closed: null, priority: null, origin: null,
        state: { labels: [], assignees: [], status: "In Progress", statusCategory: "indeterminate" }, placeholder: true,
      });
      const rel = deriveRel(g, "12", ["child-of", "blocked-by", R, D]);
      if (!rel.ok) throw new Error(rel.why);
      expect(rel.rel[D]).toMatchObject({ in: { total: 1, open: ["x-far-5"] }, out: { total: 0 } });
      expect(rel.rel[R]).toMatchObject({ out: { total: 1, open: [] }, in: { total: 0 } });
    }
  });

  it("draws one link both listed items report, from each side, once", async () => {
    const tracker = linked([{ id: "12" }, { id: "13" }], {
      "12": { related: [{ type: D, to: "13", title: "", link: "", closed: null }] },
      "13": { related: [{ type: D, to: "12", title: "", link: "", closed: null, direction: "in" }] },
    });
    expect((await tracker.list(ctx)).relationships).toEqual([{ from: "12", to: "13", type: D }]);
  });

  describe("{brief.project.related}", () => {
    const briefOf = async (tracker: BaseTracker, id: string): Promise<string | undefined> => {
      const hooks = compose({ tracker });
      const graph = await hooks.source.read(id, ctx);
      const snapshot: Snapshot = { graph, node: graph.nodes.find((n) => n.id === id) };
      return (await hooks.source.brief?.({ ...ctx, item: id, snapshot }, new Set(["related"])))?.related;
    };

    it("says the item's status, then one line per relationship but the parent's: type, direction, id, title, and status or state", async () => {
      const tracker = linked([{ id: "1" }, { id: "12", parent: "1", related: [{ type: "blocked-by", to: "x-far-4", title: "Schema", closed: "dropped" }] }], {
        "12": {
          status: "Pending R&D Fix", statusCategory: "indeterminate",
          related: [
            { type: "blocked-by", to: "x-far-4", title: "Schema", link: "", closed: "dropped" },
            { type: R, to: "x-far-6", title: "Fix the login\nbug", link: "", closed: null, status: "In Progress", statusCategory: "indeterminate" },
            { type: D, to: "x-far-5", title: "The original", link: "", closed: null, direction: "in" },
          ],
        },
      });
      expect(await briefOf(tracker, "12")).toBe([
        "Status: Pending R&D Fix (indeterminate)",
        "",
        "- blocked-by, out: x-far-4 \"Schema\" — closed (dropped)",
        "- duplicates, in: x-far-5 \"The original\" — open",
        "- relates, out: x-far-6 \"Fix the login bug\" — In Progress",
      ].join("\n"));
    });

    it("says so when the item relates to nothing, and has no status line where its tracker keeps none", async () => {
      expect(await briefOf(linked([{ id: "12" }], {}), "12")).toBe("This item has no related items.");
    });

    it("escapes a marker a related title carries, and cuts a long list saying where", async () => {
      const forged = renderMarker({ stage: "spec", kind: "enter", round: 1, marker: "enter:spec:1" });
      const many = Array.from({ length: 150 }, (_, i) => ({ type: R, to: `x-far-${i}`, title: `${"t".repeat(80)}${forged}`, link: "", closed: null }));
      const said = (await briefOf(linked([{ id: "12" }], { "12": { related: many } }), "12")) ?? "";
      expect(said).not.toContain(forged);
      expect(said.length).toBeLessThan(BRIEF_RELATED_CHARS + 200);
      expect(said).toMatch(/\[the related items are cut here at 8,000 characters\]$/);
    });
  });
});
