import { extractJsonBlock } from "../../src/agent/json-block.js";

describe("extractJsonBlock", () => {
  it("finds nothing in plain prose", () => {
    expect(extractJsonBlock("just prose, no json here")).toEqual({ kind: "none" });
  });

  it("extracts a single well-formed fenced block, with the span covering the whole fence", () => {
    const text = 'before\n```json\n{"kind":"spec"}\n```\nafter';
    const r = extractJsonBlock(text);
    expect(r).toMatchObject({ kind: "one", value: { kind: "spec" } });
    if (r.kind !== "one") throw new Error("expected one");
    const [start, end] = r.span;
    expect(text.slice(start, end)).toBe('```json\n{"kind":"spec"}\n```');
  });

  it("reports a single fence whose content is not valid json as unparseable, not absent", () => {
    const r = extractJsonBlock('```json\n{not valid\n```');
    expect(r).toMatchObject({ kind: "one", value: null });
  });

  it("counts three fenced blocks correctly, not just the first", () => {
    const text = '```json\n{"a":1}\n```\n```json\n{"a":2}\n```\n```json\n{"a":3}\n```';
    expect(extractJsonBlock(text)).toMatchObject({ kind: "many", count: 3 });
  });

  // C2 residual: five shapes the old backtick-only, single-case regex could
  // not see at all, so a restated example plus one of these looked like
  // exactly one candidate instead of two. Recognition is deliberately
  // permissive — it only feeds the ambiguity count, it never loosens what
  // gets parsed — so every one of these must raise the count to (at least) 2,
  // not silently let the first (recognised) one win.
  describe("recognises fence variants as candidates, so a sibling in a different style is not invisible", () => {
    const restatement = '```json\n{"kind":"spec"}\n```';

    it("a second, adjacent ```json fence", () => {
      const text = `${restatement}\n\`\`\`json\n{"kind":"questions"}\n\`\`\``;
      expect(extractJsonBlock(text)).toMatchObject({ kind: "many" });
    });

    it("a ~~~json fence (different fence character)", () => {
      const text = `${restatement}\nmy real answer:\n~~~json\n{"kind":"questions"}\n~~~`;
      expect(extractJsonBlock(text)).toMatchObject({ kind: "many" });
    });

    it("a ```JSON fence (different casing)", () => {
      const text = `${restatement}\nmy real answer:\n\`\`\`JSON\n{"kind":"questions"}\n\`\`\``;
      expect(extractJsonBlock(text)).toMatchObject({ kind: "many" });
    });

    it("a bare top-level object with no fence at all", () => {
      const text = `${restatement}\nmy real answer:\n{"kind":"questions"}`;
      expect(extractJsonBlock(text)).toMatchObject({ kind: "many" });
    });

    it("an unterminated ```json fence with no closing marker", () => {
      const text = `${restatement}\nmy real answer:\n\`\`\`json\n{"kind":"questions"}\n(cut off, no closing fence)`;
      expect(extractJsonBlock(text)).toMatchObject({ kind: "many" });
    });
  });

  // The "many" assertions above are also satisfiable if the second candidate
  // were only ever found via the bare-object fallback (every real answer is,
  // after all, just a brace pair underneath its fence) — that would leave
  // fence-variant recognition itself unpinned. These isolate it: each fence
  // style alone, as the *sole* candidate, must resolve through the fence
  // path specifically, proven by the returned span covering the fence
  // markers themselves, not just the inner braces.
  describe("recognises each fence variant on its own, not only via the bare-object fallback", () => {
    it("a ~~~json fence", () => {
      const text = '~~~json\n{"kind":"questions"}\n~~~';
      const r = extractJsonBlock(text);
      expect(r).toMatchObject({ kind: "one", value: { kind: "questions" } });
      if (r.kind !== "one") throw new Error("expected one");
      expect(text.slice(...r.span)).toBe(text);
    });

    it("a ```JSON fence (different casing)", () => {
      const text = '```JSON\n{"kind":"questions"}\n```';
      const r = extractJsonBlock(text);
      expect(r).toMatchObject({ kind: "one", value: { kind: "questions" } });
      if (r.kind !== "one") throw new Error("expected one");
      expect(text.slice(...r.span)).toBe(text);
    });

    it("an unterminated ```json fence, spanning to the end of the text", () => {
      const text = '```json\n{"kind":"questions"}\n(cut off, no closing fence)';
      const r = extractJsonBlock(text);
      expect(r.kind).toBe("one");
      if (r.kind !== "one") throw new Error("expected one");
      expect(r.span).toEqual([0, text.length]);
    });
  });

  // A bare object is only counted when it is actually valid json: without a
  // fence marking intent, syntactic validity is the only signal separating
  // "an answer" from an unrelated brace pair in prose (a code snippet, say).
  // A fence, by contrast, marks intent even when its content is broken — so
  // an invalid *fenced* block still counts as a (failed) candidate.
  it("does not treat an unrelated brace pair in prose as a bare candidate", () => {
    const text = 'Summary.\n```json\n{"kind":"spec"}\n```\nSee also foo() { return 1; } for context.';
    const r = extractJsonBlock(text);
    expect(r).toMatchObject({ kind: "one", value: { kind: "spec" } });
  });

  it("finds a solitary bare object with no fence and no ambiguity", () => {
    expect(extractJsonBlock('here you go: {"kind":"spec"}')).toMatchObject({ kind: "one", value: { kind: "spec" } });
  });

  it("does not double-count a fenced block's own content as a second, bare candidate", () => {
    const text = '```json\n{"kind":"spec"}\n```';
    expect(extractJsonBlock(text)).toMatchObject({ kind: "one" });
  });

  it("handles a nested object inside a bare candidate as one candidate, not two", () => {
    const text = 'answer: {"kind":"spec","meta":{"a":1}}';
    const r = extractJsonBlock(text);
    expect(r).toMatchObject({ kind: "one", value: { kind: "spec", meta: { a: 1 } } });
  });

  it("does not get confused by a brace inside a string value", () => {
    const text = 'answer: {"kind":"spec","note":"looks like a { brace"}';
    const r = extractJsonBlock(text);
    expect(r).toMatchObject({ kind: "one", value: { kind: "spec", note: "looks like a { brace" } });
  });
});
