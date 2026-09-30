import { LABELS, renderMarker, renderOrigin } from "#conventions.js";
import {
  botLoginOf, closeSatisfied, commentSatisfied, commentsOf, createdAtOf, labelSatisfied, nodesCloseSatisfied,
  priorityFromLabels, statusSatisfied, ticketNode, updatedAtOf, wroteIt,
} from "#kit/tracker.js";
import type { Effect, Node, Snapshot } from "#namespace.js";

const BOT = "landrace-bot";

const ticket = (fields: Partial<Node> = {}): Node => ({
  id: "7", kind: "ticket", title: "T", link: "https://tracker.example/7", closed: null, priority: null, origin: null,
  state: { labels: [] }, ...fields,
});

const snapshotWith = (fields: Record<string, unknown>): Snapshot => fields as unknown as Snapshot;

/** A comment carrying the marker `marker`, as the tracker hands it back. */
const marked = (marker: string, login = BOT): { body: string; user: { login: string } } => ({
  body: `said${renderMarker({ stage: "spec", kind: "enter", round: 1, marker })}`,
  user: { login },
});

describe("commentsOf", () => {
  it("is the ticket's comments, and none when the pre hook put none there", () => {
    const comments = [{ body: "a" }];
    expect(commentsOf(snapshotWith({ ticket: { comments } }))).toBe(comments);
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
    expect(labelSatisfied(snapshotWith({ node: ticket({ state: { labels: ["a"] } }) }), effect)).toBe(true);
    expect(labelSatisfied(snapshotWith({ node: ticket({ state: { labels: ["a", "b"] } }) }), effect)).toBe(false);
    expect(labelSatisfied(snapshotWith({ node: ticket() }), effect)).toBe(false);
  });
});

describe("statusSatisfied", () => {
  it("is the ticket carrying the stage's label", () => {
    const effect: Effect = { type: "tracker.status", value: "build" };
    expect(statusSatisfied(snapshotWith({ node: ticket({ state: { labels: [LABELS.stage("build")] } }) }), effect)).toBe(true);
    expect(statusSatisfied(snapshotWith({ node: ticket({ state: { labels: [LABELS.stage("spec")] } }) }), effect)).toBe(false);
  });
});

describe("commentSatisfied", () => {
  const effect: Effect = { type: "tracker.comment", marker: "enter:spec:1" };
  const on = (...comments: unknown[]): Snapshot => snapshotWith({ tracker: { bot: BOT }, ticket: { comments } });

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
  it("is the ticket closed, either way", () => {
    expect(closeSatisfied(snapshotWith({ node: ticket({ closed: "dropped" }) }))).toBe(true);
    expect(closeSatisfied(snapshotWith({ node: ticket() }))).toBe(false);
  });
});

describe("nodesCloseSatisfied", () => {
  it("is every named node closed", () => {
    const graph = { nodes: [ticket({ id: "8", closed: "done" }), ticket({ id: "9" })], relationships: [] };
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

describe("ticketNode", () => {
  const origin = { parent: "3", stage: "triage", round: 1 };
  const fields = {
    id: "7", title: "Split", link: "https://tracker.example/7", closed: null, labels: ["P1", "lr:auto"],
    assignees: ["someone"], body: `body${renderOrigin(origin)}`, author: BOT, editor: undefined,
    createdAt: "2026-09-30T00:00:00Z", updatedAt: "2026-09-30T12:00:00Z",
  };

  it("is the ticket as the engine reads one", () => {
    expect(ticketNode(fields, BOT)).toEqual({
      id: "7", kind: "ticket", title: "Split", link: "https://tracker.example/7", closed: null, priority: 1, origin,
      state: { labels: ["P1", "lr:auto"], assignees: ["someone"] }, createdAt: Date.parse("2026-09-30T00:00:00Z"),
      updatedAt: Date.parse("2026-09-30T12:00:00Z"),
    });
  });

  it("carries no update time for a ticket whose tracker gave none", () => {
    expect(ticketNode({ ...fields, updatedAt: undefined }, BOT)).not.toHaveProperty("updatedAt");
  });

  it("reads no origin from a body a stranger has edited since, nor one a stranger wrote", () => {
    expect(ticketNode({ ...fields, editor: "someone" }, BOT).origin).toBeNull();
    expect(ticketNode({ ...fields, editor: BOT }, BOT).origin).toEqual(origin);
    expect(ticketNode({ ...fields, author: "someone" }, BOT).origin).toBeNull();
  });

  // Jira's priority field, and the in-memory tracker's: a tracker that has
  // one says so, and its P labels are then only labels.
  it("takes a tracker's own priority over the P labels, and its absence of one too", () => {
    expect(ticketNode({ ...fields, priority: 3 }, BOT).priority).toBe(3);
    expect(ticketNode({ ...fields, priority: null }, BOT).priority).toBeNull();
    expect(ticketNode({ ...fields, priority: undefined }, BOT).priority).toBe(1);
  });
});
