import {
  entriesFromComments,
  neutraliseMarkers,
  parseMarker,
  renderMarker,
  stripMarker,
} from "#conventions.js";
import type { Marker } from "#namespace.js";

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

  // For the item panel's conversation: what a person reads on the item,
  // never the control state riding at the end of ours.
  it("carries each comment's text — ours with the marker taken off, a person's whole", () => {
    const entries = entriesFromComments([
      { id: 1, body: `draft\n\nsecond paragraph${renderMarker(doc)}`, created_at: at(1), user: { login: "bot" } },
      { id: 2, body: "looks good", created_at: at(2), user: { login: "yiftahb" } },
      { id: 3, body: undefined as unknown as string, created_at: at(3), user: { login: "yiftahb" } },
    ], "bot");
    expect(entries.map((e) => e.text)).toEqual(["draft\n\nsecond paragraph", "looks good", ""]);
  });

  // The test that used to stand here asserted the opposite — "authorship is
  // decided by the marker, not the login" — and that assumption was the
  // vulnerability: any commenter could complete a stage, block an item or run
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
  // again for exactly the items already in flight.
  it("gives an output record with no value no payload at all", () => {
    const [entry] = entriesFromComments(
      [{ id: 1, body: `old${renderMarker(doc)}`, created_at: at(1), user: { login: "bot" } }],
      "bot",
    );
    expect(entry).toMatchObject({ stage: "spec", kind: "output", round: 2 });
    expect(entry?.data).toBeUndefined();
  });

  /*
   * The session is engine bookkeeping about how a record was produced, so it
   * rides beside the payload rather than in it — one field, read the same way
   * whatever kind of record carries it, which is what lets a conversation
   * turn resume a step's session and the turn after that resume the turn's.
   */
  it("reads the session beside a marker's output, whatever kind the record is", () => {
    const entries = entriesFromComments([
      {
        id: 1,
        body: `asking${renderMarker({ ...doc, session: "sid-step", output: { kind: "questions" } })}`,
        created_at: at(1),
        user: { login: "bot" },
      },
      {
        id: 2,
        body: `answering${renderMarker({ stage: "spec", kind: "conversation", round: 2, session: "sid-turn" })}`,
        created_at: at(2),
        user: { login: "bot" },
      },
    ], "bot");

    expect(entries[0]?.session).toBe("sid-step");
    expect(entries[1]?.session).toBe("sid-turn");
    // And it stays out of the payload, which is the step's own value and the
    // state predicates route on.
    expect(entries[0]?.data).toEqual({ kind: "questions" });
  });

  /*
   * The attack the `reserved-field` validate rule used to forbid instead of
   * withstand: a step whose output shape declares a field called `session`
   * puts an agent-chosen string in the payload. It is an ordinary output
   * field there — it is not where the engine records a session, so it cannot
   * become the id a paid turn resumes.
   */
  it("does not read a session out of an output value that happens to declare one", () => {
    const body = `draft${renderMarker({ ...doc, output: { kind: "spec", session: "sid-agent" } })}`;
    const [entry] = entriesFromComments([{ id: 1, body, created_at: at(1), user: { login: "bot" } }], "bot");

    expect(entry?.session).toBeUndefined();
    expect(entry?.data).toEqual({ kind: "spec", session: "sid-agent" });
  });

  // Fail closed on a marker whose session is not one: an empty string is an
  // id to resume that resumes nothing, and a number is a `--resume` argument
  // built out of "7".
  it("ignores a session that is not a non-empty string", () => {
    const entries = entriesFromComments([
      { id: 1, body: `a${renderMarker({ ...doc, session: "" })}`, created_at: at(1), user: { login: "bot" } },
      // Cast, because the field is declared a string: a marker is JSON parsed
      // back out of a comment, so its type is a claim about what we wrote, and
      // this is the body that claims something else.
      {
        id: 2,
        body: `b${renderMarker({ ...doc, session: 7 } as unknown as Marker)}`,
        created_at: at(2),
        user: { login: "bot" },
      },
    ], "bot");

    expect(entries[0]?.session).toBeUndefined();
    expect(entries[1]?.session).toBeUndefined();
  });

  it("keeps a human comment's text where a step can read it", () => {
    const [entry] = entriesFromComments([{ id: 7, body: "B2B only", created_at: at(1), user: { login: "y" } }], "bot");
    expect(entry?.data).toMatchObject({ body: "B2B only", author: "y", id: 7 });
  });
});

describe("our own records under an app's two spellings of its login", () => {
  const marked = (login: string) => ({
    id: 1, created_at: "2026-01-01T00:00:01Z", user: { login },
    body: `x\n\n${renderMarker({ stage: "spec", kind: "enter", round: 1, marker: "enter:spec:1" })}`,
  });

  // GitHub reports an app as `myapp[bot]` on a comment and as `myapp` in
  // other places — and in `tracker.bot` — so either side may carry it.
  it.each([["myapp[bot]", "myapp"], ["myapp", "myapp[bot]"], ["MyApp[bot]", "myapp"]])(
    "reads a record by %s as ours when we post as %s", (author, bot) => {
      expect(entriesFromComments([marked(author)], bot)[0]).toMatchObject({ kind: "enter", byAgent: true });
    });

  it("still reads a different account's record as a person's", () => {
    expect(entriesFromComments([marked("myapp2[bot]")], "myapp")[0]).toMatchObject({ kind: "human", byAgent: false });
  });
});
