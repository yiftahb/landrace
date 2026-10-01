import { assigneesOf, compareWork, labelsOf } from "#conventions.js";
import type { Node } from "#namespace.js";

const node = (id: string, priority: number | null, state: Node["state"] = {}): Node => ({
  id, kind: "item", title: id, link: "", closed: null, priority, origin: null, state,
});

describe("graph vocabulary", () => {
  it("orders work by priority, unprioritised last, then by id", () => {
    const sorted = [node("10", null), node("3", 2), node("9", 0), node("2", 2), node("1", null)].sort(compareWork);
    expect(sorted.map((n) => n.id)).toEqual(["9", "2", "3", "1", "10"]);
  });

  it("reads labels and assignees off an item node, empty when absent", () => {
    expect(labelsOf(node("1", null, { labels: ["a", "b"] }))).toEqual(["a", "b"]);
    expect(assigneesOf(node("1", null, { assignees: ["me"] }))).toEqual(["me"]);
    expect(labelsOf(undefined)).toEqual([]);
    expect(labelsOf(node("1", null, { labels: "not-a-list" }))).toEqual([]);
    expect(labelsOf(node("1", null, { labels: ["ok", 3] }))).toEqual(["ok"]);
  });
});
