import { LABELS, renderMarker, renderOrigin } from "#conventions.js";
import { compose } from "#kit/compose.js";
import {
  BRIEF_ITEM_CHARS, botLoginOf, closeSatisfied, commentSatisfied, commentsOf, createdAtOf, labelSatisfied,
  nodesCloseSatisfied, priorityFromLabels, statusSatisfied, itemNode, updatedAtOf, wroteIt,
} from "#kit/tracker.js";
import { MemoryDocs, MemoryForge, MemoryTracker } from "#testing/index.js";
import type { Effect, HookContext, Node, RuntimeContext, Snapshot } from "#namespace.js";

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

  it("keeps a body at its bound whole, and cuts one past it, saying so", async () => {
    const whole = "x".repeat(BRIEF_ITEM_CHARS);
    expect(await bodyOf(whole)).toBe(whole);
    expect(await bodyOf(`${whole}y`)).toBe(`${whole}…`);
  });

  it("is a key of the project's own, beside the forge's and the shared history, claimed by no other role", async () => {
    const hooks = compose({ tracker: new MemoryTracker({ items: [{ id: "7" }] }), forge: new MemoryForge(), docs: new MemoryDocs() });
    expect(Object.keys((await hooks.source.brief?.(on("7"))) ?? {}).sort()).toEqual(["body", "ci", "diff", "history", "threads"]);
  });
});
