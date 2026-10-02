import { isNoteField, noteFields, renderNote } from "#core/index.js";
import type { Node, Rel, RelAgg } from "#namespace.js";

const agg = (over: Partial<RelAgg> = {}): RelAgg => ({ total: 0, dropped: 0, is: {}, not: {}, sum: {}, stage: {}, open: [], ...over });
const rel = (type: string, out: Partial<RelAgg>, inward: Partial<RelAgg> = {}): Rel => ({ [type]: { in: agg(inward), out: agg(out) } });
const node: Node = { id: "12", kind: "item", title: "Ship it", link: "", closed: null, priority: null, origin: null, state: {} };

describe("renderNote", () => {
  it("names the open related items, in id order, whatever order it was handed them in", () => {
    expect(renderNote("waiting on {rel.blocked-by.out.open}", rel("blocked-by", { open: ["11", "10"] }), node))
      .toBe("waiting on #10, #11");
  });

  // Nothing about a type's name means anything here: a made-up one renders the same.
  it("renders a type nobody gave a meaning exactly as it renders any other", () => {
    expect(renderNote("blocked by {rel.x.out.open}", rel("x", { open: ["3"] }), node)).toBe("blocked by #3");
    expect(renderNote("{rel.x.in.open}", rel("x", {}, { open: ["4", "30", "5"] }), node)).toBe("#4, #5, #30");
  });

  it("renders nothing for a list with nothing open in it", () => {
    expect(renderNote("waiting on {rel.x.out.open}", rel("x", { open: [] }), node)).toBe("waiting on ");
  });

  it("renders every count as a number", () => {
    const r = rel("x", { total: 2, dropped: 1, is: { closed: 3 }, not: { closed: 2 }, sum: { n: 7 }, stage: { build: 1 } }, { total: 4 });
    const template = "{rel.x.out.total} {rel.x.out.dropped} {rel.x.out.is.closed} {rel.x.out.not.closed} {rel.x.out.sum.n} {rel.x.out.stage.build} {rel.x.in.total}";
    expect(renderNote(template, r, node)).toBe("2 1 3 2 7 1 4");
  });

  /*
   * A count over nothing related is 0, where a predicate reading the same
   * absent path matches nothing: a predicate must not read "none merged" as
   * "all merged", but a person reading "0 open" is told the truth.
   */
  it("renders a count nothing related answers as 0, never as the field", () => {
    expect(renderNote("{rel.x.out.not.closed} open", rel("x", {}), node)).toBe("0 open");
    // Not a count the prototype answers: `is` is a plain object here.
    expect(renderNote("{rel.x.out.is.toString}", rel("x", {}), node)).toBe("0");
  });

  it("renders the item's own id", () => {
    expect(renderNote("#{node.id} waits", rel("x", {}), node)).toBe("#12 waits");
  });

  it("leaves visible a field it cannot answer, so a typo shows on the board rather than vanishing", () => {
    for (const field of [
      "{rel.y.out.open}", "{rel.x.sideways.open}", "{rel.x.out.bogus}", "{rel.x.out.is}", "{rel.x.out.open.more}",
      "{node.title}", "{item.body}", "{rel.x.out.toString}", "{rel.constructor.out.total}", "{rel.x.hasOwnProperty.total}",
    ]) {
      expect(renderNote(field, rel("x", { open: ["1"] }), node)).toBe(field);
    }
  });
});

describe("noteFields", () => {
  it("lists each field a note reads, once, in the order written", () => {
    expect(noteFields("waiting on {rel.blocked-by.out.open} for {node.id}, {node.id} and {rel.x.in.total}"))
      .toEqual(["rel.blocked-by.out.open", "node.id", "rel.x.in.total"]);
  });

  it("lists none in a note that reads none", () => {
    expect(noteFields("waiting")).toEqual([]);
  });
});

describe("isNoteField", () => {
  it.each([
    "node.id", "rel.x.out.open", "rel.blocked-by.in.open", "rel.x.in.total", "rel.x.out.dropped",
    "rel.x.out.is.merged", "rel.x.out.not.closed", "rel.x.out.sum.openThreads", "rel.x.out.stage.build",
  ])("accepts %s", (field) => {
    expect(isNoteField(field)).toBe(true);
  });

  it.each([
    "node.title", "node", "item.body", "run.stage", "rel.x", "rel.x.out", "rel.x.out.is", "rel.x.sideways.open",
    "rel.x.out.open.more", "rel.x.out.total.more", "rel.x.out.is.a.b", "rel..out.open", "rel.x.out.bogus",
  ])("refuses %s", (field) => {
    expect(isNoteField(field)).toBe(false);
  });
});
