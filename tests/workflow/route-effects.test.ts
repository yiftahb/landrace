import { stageSchema, stepFrontMatterSchema } from "#workflow/schema.js";

/*
 * A route takes `effect` or `effects`, never both and never neither: one
 * destination for the step's prose, or several fed from the output's fields.
 */
describe("a route's effects", () => {
  const front = (route: Record<string, unknown>) => stepFrontMatterSchema.safeParse({
    output: { discriminator: "kind", shapes: { done: { reply: "string" } }, routes: [{ when: { kind: "done" }, ...route }] },
  });

  it("takes one effect, as every workflow written before it does", () => {
    expect(front({ effect: { type: "tracker.comment", marker: "done:{round}" } }).success).toBe(true);
  });

  it("takes a list of effects", () => {
    const parsed = front({ effects: [{ type: "tracker.comment", from: "reply" }, { type: "tracker.comment" }] });
    expect(parsed.success).toBe(true);
  });

  it("refuses a route with both", () => {
    const parsed = front({ effect: { type: "tracker.comment" }, effects: [{ type: "tracker.comment" }] });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/effect or effects, not both/);
  });

  it("refuses a route with neither", () => {
    const parsed = front({});
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/effect or effects/);
  });

  it("refuses an empty list", () => {
    expect(front({ effects: [] }).success).toBe(false);
  });
});

describe("a stage's closed key", () => {
  it("takes run", () => {
    expect(stageSchema.safeParse({ id: "retro", closed: "run" }).success).toBe(true);
  });

  it("takes nothing else", () => {
    expect(stageSchema.safeParse({ id: "retro", closed: true }).success).toBe(false);
    expect(stageSchema.safeParse({ id: "retro", closed: "skip" }).success).toBe(false);
  });
});
