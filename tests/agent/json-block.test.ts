import { extractJsonBlock } from "../../src/agent/json-block.js";

// Every caller supplies its own discriminator key ("verdict" for screening,
// a step's own declared discriminator for output) — the shared module never
// hard-codes either.
const K = "kind";

describe("extractJsonBlock", () => {
  it("finds nothing in plain prose", () => {
    expect(extractJsonBlock("just prose, no json here", K)).toEqual({ kind: "none" });
  });

  it("extracts a single well-formed strict fenced block, with the span covering the whole fence", () => {
    const text = 'before\n```json\n{"kind":"spec"}\n```\nafter';
    const r = extractJsonBlock(text, K);
    expect(r).toMatchObject({ kind: "one", value: { kind: "spec" } });
    if (r.kind !== "one") throw new Error("expected one");
    const [start, end] = r.span;
    expect(text.slice(start, end)).toBe('```json\n{"kind":"spec"}\n```');
  });

  it("reports a single strict fence whose content is not valid json as unparseable, not absent", () => {
    const r = extractJsonBlock('```json\n{not valid\n```', K);
    expect(r).toMatchObject({ kind: "one", value: null });
  });

  it("counts three fenced blocks correctly, not just the first", () => {
    const text = '```json\n{"kind":1}\n```\n```json\n{"kind":2}\n```\n```json\n{"kind":3}\n```';
    expect(extractJsonBlock(text, K)).toMatchObject({ kind: "many", count: 3 });
  });

  // Round-3 Critical. "Recognition only feeds the ambiguity count, it never
  // loosens what gets parsed" is true going 1 -> 2 candidates and false
  // going 0 -> 1: a lone unfenced or wrongly-fenced candidate used to find
  // *nothing* (kind: "none") and fail closed on its own. The permissive
  // recogniser turned that into a real "one" that gets parsed and obeyed —
  // exactly the round-1 planted-verdict bypass, reopened in unfenced form.
  // The fix: recognition stays permissive for *counting*; a sole candidate
  // is only ever parsed when it is a strict ```json fence. Every other sole
  // candidate must resolve as "not-strict-fence" — the same practical
  // outcome as "none" (both callers treat it as unreadable/fail closed) but
  // named distinctly so the reason can say why.
  describe("a sole candidate that is not a strict fence fails closed, not obeyed", () => {
    it("a bare object with no fence at all", () => {
      expect(extractJsonBlock('here you go: {"kind":"spec"}', K)).toMatchObject({ kind: "not-strict-fence" });
    });

    it("a ~~~json fence", () => {
      expect(extractJsonBlock('~~~json\n{"kind":"spec"}\n~~~', K)).toMatchObject({ kind: "not-strict-fence" });
    });

    it("a ```JSON fence (different casing)", () => {
      expect(extractJsonBlock('```JSON\n{"kind":"spec"}\n```', K)).toMatchObject({ kind: "not-strict-fence" });
    });

    it("an unterminated ```json fence with no closing marker", () => {
      expect(extractJsonBlock('```json\n{"kind":"spec"}\n(cut off, no closing fence)', K))
        .toMatchObject({ kind: "not-strict-fence" });
    });

    it("json quoted inside an unrelated ```text fence", () => {
      expect(extractJsonBlock('```text\n{"kind":"spec"}\n```', K)).toMatchObject({ kind: "not-strict-fence" });
    });

    it("does not carry a parsed value for a not-strict-fence result", () => {
      const r = extractJsonBlock('~~~json\n{"kind":"spec"}\n~~~', K);
      expect(r).not.toHaveProperty("value");
    });
  });

  // Recognition (for counting) stays permissive: five shapes a narrow,
  // backtick-only, single-case regex could not see at all, so a restated
  // example plus one of these looked like exactly one candidate instead of
  // two. Every one of these must still raise the count to (at least) 2.
  describe("recognises fence variants as candidates, so a sibling in a different style is not invisible", () => {
    const restatement = '```json\n{"kind":"spec"}\n```';

    it("a second, adjacent ```json fence", () => {
      const text = `${restatement}\n\`\`\`json\n{"kind":"questions"}\n\`\`\``;
      expect(extractJsonBlock(text, K)).toMatchObject({ kind: "many" });
    });

    it("a ~~~json fence (different fence character)", () => {
      const text = `${restatement}\nmy real answer:\n~~~json\n{"kind":"questions"}\n~~~`;
      expect(extractJsonBlock(text, K)).toMatchObject({ kind: "many" });
    });

    it("a ```JSON fence (different casing)", () => {
      const text = `${restatement}\nmy real answer:\n\`\`\`JSON\n{"kind":"questions"}\n\`\`\``;
      expect(extractJsonBlock(text, K)).toMatchObject({ kind: "many" });
    });

    it("a bare top-level object with no fence at all", () => {
      const text = `${restatement}\nmy real answer:\n{"kind":"questions"}`;
      expect(extractJsonBlock(text, K)).toMatchObject({ kind: "many" });
    });

    it("an unterminated ```json fence with no closing marker", () => {
      const text = `${restatement}\nmy real answer:\n\`\`\`json\n{"kind":"questions"}\n(cut off, no closing fence)`;
      expect(extractJsonBlock(text, K)).toMatchObject({ kind: "many" });
    });
  });

  // Isolates fence-variant recognition from the bare-object fallback: two
  // fenced candidates side by side, neither a strict fence, still count as
  // two — proving recognition sees both fence *shapes*, not just braces.
  it("counts two non-strict fence variants side by side as many, not one", () => {
    const text = '~~~json\n{"kind":"a"}\n~~~\n```JSON\n{"kind":"b"}\n```';
    expect(extractJsonBlock(text, K)).toMatchObject({ kind: "many", count: 2 });
  });

  // Important (false "many"): a bare object counts as a candidate only when
  // it carries the discriminator key — without a fence marking intent,
  // syntactic validity alone is too weak a signal (prose is full of
  // incidental brace pairs); the discriminator key is what makes a bare
  // object actually *claim* to be the answer.
  describe("a bare object without the discriminator key is not a candidate at all", () => {
    it("an error-shaped object with no discriminator key does not create ambiguity", () => {
      const text = 'Ran the command: ```json\n{"kind":"spec"}\n```\nIt failed with {"code":"ENOENT"}.';
      expect(extractJsonBlock(text, K)).toMatchObject({ kind: "one", value: { kind: "spec" } });
    });

    it("an unrelated brace pair in prose (a code snippet) is not a candidate", () => {
      const text = 'Summary.\n```json\n{"kind":"spec"}\n```\nSee also foo() { return 1; } for context.';
      expect(extractJsonBlock(text, K)).toMatchObject({ kind: "one", value: { kind: "spec" } });
    });

    it("a bare object that does carry the discriminator key still counts, and still halts", () => {
      // It genuinely is a second thing claiming to be the answer.
      const text = '```json\n{"kind":"spec"}\n```\nmy real answer: {"kind":"questions"}';
      expect(extractJsonBlock(text, K)).toMatchObject({ kind: "many", count: 2 });
    });

    it("does not hard-code a key: a different discriminator name is honoured", () => {
      const text = 'Ran the command: ```json\n{"intent":"approve"}\n```\nIt failed with {"code":"ENOENT"}.';
      expect(extractJsonBlock(text, "intent")).toMatchObject({ kind: "one", value: { intent: "approve" } });
    });
  });

  it("does not double-count a fenced block's own content as a second, bare candidate", () => {
    const text = '```json\n{"kind":"spec"}\n```';
    expect(extractJsonBlock(text, K)).toMatchObject({ kind: "one" });
  });

  it("handles a nested object inside a bare candidate correctly (still just one candidate)", () => {
    const text = 'answer: {"kind":"spec","meta":{"a":1}}';
    // Bare, so not-strict-fence — but must still be recognised as exactly
    // one candidate, not accidentally split by the nested braces.
    expect(extractJsonBlock(text, K)).toMatchObject({ kind: "not-strict-fence" });
  });

  it("does not get confused by a brace inside a string value", () => {
    const text = 'answer: {"kind":"spec","note":"looks like a { brace"}';
    expect(extractJsonBlock(text, K)).toMatchObject({ kind: "not-strict-fence" });
  });

  // Minor: JSON has no notion of a single-quoted string, so treating `'` as
  // a string delimiter makes bare-object detection depend on apostrophe
  // parity in surrounding prose — "don't" and "won't" together would
  // "close" and "reopen" a fake string, corrupting brace-depth tracking.
  it("does not treat an apostrophe in prose as a string delimiter", () => {
    const text = "I don't know why it won't build, but here's the answer: {\"kind\":\"spec\"}";
    const r = extractJsonBlock(text, K);
    expect(r).toMatchObject({ kind: "not-strict-fence" });
  });

  // Perf: bareCandidates used to call exclude.find() per character, making
  // it quadratic in (text length x fence count) — 20+ seconds on 1MB of
  // adversarial input, synchronously blocking the orchestrator's loop, well
  // under MAX_OUTPUT_BYTES (8MB). Must be linear.
  it("stays fast on a large adversarial input instead of scanning quadratically", () => {
    const opener = '```json\n{"kind":"x"}\n';
    const big = opener.repeat(Math.ceil((1_000_000) / opener.length));
    const start = Date.now();
    extractJsonBlock(big, K);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
