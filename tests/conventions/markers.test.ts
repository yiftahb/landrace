import {
  entriesFromComments,
  neutraliseMarkers,
  parseMarker,
  renderMarker,
  stripMarker,
} from "../../src/conventions.js";

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
    ], "bot");
    expect(entries[0]).toMatchObject({ stage: "spec", kind: "output", round: 2, byAgent: true });
    expect(entries[1]).toMatchObject({ kind: "human", byAgent: false });
  });

  // The test that used to stand here asserted the opposite — "authorship is
  // decided by the marker, not the login" — and that assumption was the
  // vulnerability: any commenter could complete a stage, block a ticket or run
  // a counter up by pasting a marker. Authorship is now the login, and
  // tests/security/marker-forgery.test.ts is where the attacks live.
  it("reads a marker from the account we post as, whoever else is talking", () => {
    const [entry] = entriesFromComments([
      { id: 1, body: `x${renderMarker(doc)}`, created_at: at(1), user: { login: "yiftahb" } },
    ], "yiftahb");
    expect(entry?.byAgent).toBe(true);
  });

  /*
   * `data` is the record's payload, and for an output record the payload is
   * the step's own value. Leaving the envelope there is what made
   * `outputs.spec.kind` read back the literal "output" for every shape a step
   * could produce, killing every trigger in the shipped workflow that routes
   * on an output field. The envelope is on the Entry already.
   */
  it("reads an output record's payload as the step's value, not the marker's envelope", () => {
    const value = { kind: "questions", questions: ["scope?"] };
    const body = `asking${renderMarker({ ...doc, output: value })}`;
    const [entry] = entriesFromComments([{ id: 1, body, created_at: at(1), user: { login: "bot" } }], "bot");
    expect(entry).toMatchObject({ stage: "spec", kind: "output", round: 2, byAgent: true });
    expect(entry?.data).toEqual(value);
  });

  // A record written before markers carried values has no value to read. It
  // still counts as a round — the envelope is what rounds are derived from —
  // but it must not read back as one, or `outputs.spec.kind` answers "output"
  // again for exactly the tickets already in flight.
  it("gives an output record with no value no payload at all", () => {
    const [entry] = entriesFromComments(
      [{ id: 1, body: `old${renderMarker(doc)}`, created_at: at(1), user: { login: "bot" } }],
      "bot",
    );
    expect(entry).toMatchObject({ stage: "spec", kind: "output", round: 2 });
    expect(entry?.data).toBeUndefined();
  });

  it("keeps a human comment's text where a step can read it", () => {
    const [entry] = entriesFromComments([{ id: 7, body: "B2B only", created_at: at(1), user: { login: "y" } }], "bot");
    expect(entry?.data).toMatchObject({ body: "B2B only", author: "y", id: 7 });
  });
});
