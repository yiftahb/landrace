import { entriesFromComments, neutraliseMarkers, parseMarker, renderMarker, stripMarker } from "../../src/github/markers.js";

const doc = { stage: "spec", kind: "output", round: 2 };

describe("markers", () => {
  it("round-trips what it writes", () => {
    expect(parseMarker(`hello${renderMarker(doc)}`)).toMatchObject(doc);
  });

  // The first real run of an earlier version wrote a document *about* this
  // system, quoting the marker format. Reading the first match found that
  // example, so the document was never counted and the step re-ran forever.
  it("ignores a marker-shaped example earlier in the body", () => {
    const body = `We append <!-- landrace {"stage":"x","kind":"security","round":9} --> to comments.${renderMarker(doc)}`;
    expect(parseMarker(body)).toMatchObject(doc);
  });

  it("treats a body with only a look-alike as unmarked", () => {
    expect(parseMarker('should we use <!-- landrace {"stage":"a","kind":"doc","round":1} --> here?')).toBeNull();
  });

  it("rejects a trailing marker missing required fields", () => {
    expect(parseMarker('x\n\n<!-- landrace {"kind":"doc"} -->')).toBeNull();
    expect(parseMarker("x\n\n<!-- landrace not-json -->")).toBeNull();
  });

  it("strips only the trailing marker", () => {
    const body = `keep <!-- landrace {"stage":"a","kind":"b","round":1} --> this${renderMarker(doc)}`;
    expect(stripMarker(body)).toContain("keep <!-- landrace");
    expect(stripMarker(body)).not.toContain('"round":2');
  });

  it("neutralises look-alikes so agent output cannot forge state", () => {
    const out = neutraliseMarkers('append <!-- landrace {"stage":"a","kind":"doc","round":1} --> here');
    expect(out).not.toMatch(/<!--\s*landrace/);
    expect(out).toMatch(/&lt;!-- landrace/);
    expect(parseMarker(out + renderMarker(doc))).toMatchObject(doc);
  });
});

describe("entriesFromComments", () => {
  const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

  it("reads a marked comment as ours and an unmarked one as a person's", () => {
    const entries = entriesFromComments([
      { id: 1, body: `draft${renderMarker(doc)}`, created_at: at(1), user: { login: "bot" } },
      { id: 2, body: "looks good", created_at: at(2), user: { login: "yiftahb" } },
    ]);
    expect(entries[0]).toMatchObject({ stage: "spec", kind: "output", round: 2, byAgent: true });
    expect(entries[1]).toMatchObject({ kind: "human", byAgent: false });
  });

  it("decides authorship by the marker, not the login", () => {
    // We post with a human's token, so the login tells us nothing.
    const [entry] = entriesFromComments([
      { id: 1, body: `x${renderMarker(doc)}`, created_at: at(1), user: { login: "yiftahb" } },
    ]);
    expect(entry?.byAgent).toBe(true);
  });

  it("keeps a human comment's text where a step can read it", () => {
    const [entry] = entriesFromComments([{ id: 7, body: "B2B only", created_at: at(1), user: { login: "y" } }]);
    expect(entry?.data).toMatchObject({ body: "B2B only", author: "y", id: 7 });
  });
});
