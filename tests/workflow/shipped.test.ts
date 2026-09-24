import { readFile } from "node:fs/promises";

/**
 * `tests/esm/cli-validate.test.ts` already proves the shipped workflow
 * validates clean against the GitHub hook's declared paths and relations —
 * "validates the shipped .landrace workflow clean, on every rule" runs
 * `runValidate(".landrace")`, which is `validate()` plus `snapshotProvides()`
 * plus the config and secret checks. A second case here asking the narrower
 * question would only re-run the same coverage rule against the same files.
 *
 * What that file does not check is that the old, pre-graph vocabulary is
 * actually gone from the source rather than merely unreachable — a stale
 * `artifacts.pr.*` or `"ticket.labels"` path left in a comment or an unused
 * branch would not fail validation but would still mislead the next reader.
 */
describe("the shipped .landrace workflow", () => {
  it("reads no path the graph removed", async () => {
    const text = await readFile(".landrace/workflow.yaml", "utf8");
    expect(text).not.toMatch(/artifacts\.pr\./);
    expect(text).not.toMatch(/"ticket\.labels"/);
  });
});
