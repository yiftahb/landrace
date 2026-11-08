import {
  allClosed, CAPABILITIES, mayCreateItems, parseOrigin, renderOrigin, unknownCapabilities,
} from "#conventions.js";
import type { Graph, Node } from "#namespace.js";

const origin = { parent: "12", stage: "breakdown", round: 2 };

describe("the items:create capability", () => {
  it("is known, so an executor that enforces it is not refused", () => {
    expect(CAPABILITIES).toContain("items:create");
    expect(unknownCapabilities(["items:create", "repo:read"])).toEqual([]);
  });

  it("is granted only by declaring it", () => {
    expect(mayCreateItems(["items:create"])).toBe(true);
    expect(mayCreateItems(["repo:write"])).toBe(false);
    expect(mayCreateItems(undefined)).toBe(false);
  });
});

describe("the origin marker", () => {
  it("round-trips when we wrote it", () => {
    const body = `Implement the API.${renderOrigin(origin)}`;
    expect(parseOrigin(body, "landrace-bot", undefined, { current: "landrace-bot", former: [] })).toEqual(origin);
  });

  it("compares the author case-insensitively, the way trackers do", () => {
    expect(parseOrigin(`x${renderOrigin(origin)}`, "Landrace-Bot", undefined, { current: "landrace-bot", former: [] })).toEqual(origin);
  });

  it("reads a GitHub App's login the same with or without its [bot] suffix, either way round", () => {
    // GraphQL reports an App author as "name", REST and tracker.bot as "name[bot]".
    expect(parseOrigin(`x${renderOrigin(origin)}`, "landrace", undefined, { current: "landrace[bot]", former: [] })).toEqual(origin);
    expect(parseOrigin(`x${renderOrigin(origin)}`, "Landrace[bot]", undefined, { current: "landrace", former: [] })).toEqual(origin);
    expect(parseOrigin(`x${renderOrigin(origin)}`, "landrace-other", undefined, { current: "landrace[bot]", former: [] })).toBeNull();
  });

  it("is nobody's when a person wrote it — authorship, not syntax, is the check", () => {
    expect(parseOrigin(`x${renderOrigin(origin)}`, "a-person", undefined, { current: "landrace-bot", former: [] })).toBeNull();
    expect(parseOrigin(`x${renderOrigin(origin)}`, undefined, undefined, { current: "landrace-bot", former: [] })).toBeNull();
  });

  it("counts only a marker with nothing after it", () => {
    expect(parseOrigin(`${renderOrigin(origin)}\n\ntrailing prose`, "landrace-bot", undefined, { current: "landrace-bot", former: [] })).toBeNull();
  });

  it("ignores a trailing marker of any other kind", () => {
    const body = 'x\n\n<!-- landrace {"stage":"spec","kind":"enter","round":1} -->';
    expect(parseOrigin(body, "landrace-bot", undefined, { current: "landrace-bot", former: [] })).toBeNull();
  });

  it("refuses a parent that is not an item id, or a round that is not a positive integer", () => {
    const bad = (o: object) => `x\n\n<!-- landrace ${JSON.stringify({ kind: "child", stage: "b", round: 1, parent: "1", ...o })} -->`;
    expect(parseOrigin(bad({ parent: "../1" }), "bot", undefined, { current: "bot", former: [] })).toBeNull();
    expect(parseOrigin(bad({ round: 0 }), "bot", undefined, { current: "bot", former: [] })).toBeNull();
    expect(parseOrigin(bad({ round: 1.5 }), "bot", undefined, { current: "bot", former: [] })).toBeNull();
  });

  it("fails closed without a bot login rather than trusting every marker", () => {
    expect(() => parseOrigin(`x${renderOrigin(origin)}`, "anyone", undefined, { current: "  ", former: [] })).toThrow(/login/);
  });
});

describe("allClosed", () => {
  const node = (id: string, closed: Node["closed"]): Node => ({
    id, kind: "item", title: id, link: "", closed, priority: null, origin: null, state: {},
  });
  const graph: Graph = { nodes: [node("a", "done"), node("b", "dropped"), node("c", null)], relationships: [] };

  it("is true when every id reads back closed, either way", () => {
    expect(allClosed(graph, ["a", "b"])).toBe(true);
    expect(allClosed(graph, [])).toBe(true);
  });

  it("is false when any id is still open, or missing from the graph", () => {
    expect(allClosed(graph, ["a", "c"])).toBe(false);
    expect(allClosed(graph, ["a", "gone"])).toBe(false);
  });

  it("refuses to answer without a graph", () => {
    expect(() => allClosed(undefined, ["a"])).toThrow(/graph/);
  });
});
