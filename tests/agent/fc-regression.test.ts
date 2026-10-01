import { extractJsonBlock } from "#agent/json-block.js";

/**
 * Fix round 4: the five FC cases from task-7-8-fix4-brief.md, written and
 * watched failing against the round-3 (ambiguity-counting) implementation
 * *before* the trailing rule replaced it, per explicit instruction. Each of
 * these discarded a completed, honest agent run and blocked the item
 * terminally under round 3 — the ruling is that the answer is simply the
 * last strict ```json fence with nothing but whitespace after it, and none
 * of these should be treated as ambiguous or unparseable once that lands.
 */
describe("FC1-FC5 (fix round 4 regression, must succeed under the trailing rule)", () => {
  it("FC1 — a literal ~~~json mentioned in prose does not swallow the real trailing answer", () => {
    const text = '| `~~~json` | refused |\n\n```json\n{"kind":"done"}\n```';
    expect(extractJsonBlock(text)).toMatchObject({ kind: "found", value: { kind: "done" } });
  });

  it("FC2 — an inline mention of a fence marker before the answer is not a second candidate", () => {
    const text =
      "Earlier I referenced a fenced json block by mistake, then kept going.\n\n" +
      '```json\n{"kind":"done"}\n```';
    expect(extractJsonBlock(text)).toMatchObject({ kind: "found", value: { kind: "done" } });
  });

  it("FC3 — prose legitimately containing a bare {\"kind\":\"spec\"}-shaped mention is not a second candidate", () => {
    const text = 'My answer is {"kind":"spec"} as described below.\n\n```json\n{"kind":"spec"}\n```';
    expect(extractJsonBlock(text)).toMatchObject({ kind: "found", value: { kind: "spec" } });
  });

  it("FC4 — a second ```json fence showing an example payload is superseded by the trailing one", () => {
    const text =
      'Example:\n```json\n{"kind":"example"}\n```\n\n' +
      'My real answer:\n```json\n{"kind":"spec"}\n```';
    expect(extractJsonBlock(text)).toMatchObject({ kind: "found", value: { kind: "spec" } });
  });

  it("FC5 — CRLF line endings still parse", () => {
    const text = '```json\r\n{"kind":"spec"}\r\n```';
    expect(extractJsonBlock(text)).toMatchObject({ kind: "found", value: { kind: "spec" } });
  });
});
