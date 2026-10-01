import type { LoadedWorkflow, Workflow, Workspace } from "#namespace.js";
import { claimProblems } from "#workflow/validate.js";

const rule = (labels: string[], reason: string) => ({ when: { "node.state.labels": { $in: labels } }, else: reason });

const flow = (id: string, admit: string[], eligible: Workflow["eligible"]): LoadedWorkflow => ({
  id, dir: `/ws/workflows/${id}`, steps: new Map(),
  workflow: { version: 1, name: id, description: "test", admit, ...(eligible ? { eligible } : {}), stages: [] } as unknown as Workflow,
});
const space = (...workflows: LoadedWorkflow[]): Workspace => ({ dir: "/ws", workflows });
const oneSource = (): string => "hooks/github.ts";

describe("claimProblems: two workflows over one source", () => {
  it("is clean when what one admits the other refuses", () => {
    const ws = space(flow("main", ["lr:auto"], [rule(["lr:auto"], "no")]), flow("fast", ["lr:fast"], [rule(["lr:fast"], "no")]));
    expect(claimProblems(ws, oneSource)).toEqual([]);
  });

  it("names both workflows when one's admit labels satisfy the other's eligible rule", () => {
    const ws = space(flow("main", ["lr:auto"], [rule(["lr:auto"], "no")]), flow("fast", ["lr:fast"], [rule(["lr:auto", "lr:fast"], "no")]));
    expect(claimProblems(ws, oneSource)).toEqual([{
      rule: "claims",
      message: "workflows main and fast both claim an item started in main (admit [lr:auto] satisfies fast's eligible)",
    }]);
  });

  it("abstains when the other's eligible reads anything but labels", () => {
    const reads = [{ when: { "node.state.assignees": { $in: ["ann"] } }, else: "no" }];
    expect(claimProblems(space(flow("main", ["lr:auto"], [rule(["lr:auto"], "no")]), flow("fast", ["lr:fast"], reads)), oneSource)).toEqual([]);
    const mixed = [rule(["lr:auto"], "a"), ...reads];
    expect(claimProblems(space(flow("main", ["lr:auto"], [rule(["lr:auto"], "no")]), flow("fast", ["lr:fast"], mixed)), oneSource)).toEqual([]);
  });

  it("abstains when the sources are not the same, or not known", () => {
    const ws = space(flow("main", ["lr:auto"], [rule(["lr:auto"], "no")]), flow("fast", ["lr:fast"], [rule(["lr:auto", "lr:fast"], "no")]));
    expect(claimProblems(ws, (id: string) => `src-${id}`)).toEqual([]);
    expect(claimProblems(ws, () => "")).toEqual([]);
  });

  it("abstains for a workflow that admits nothing or states no eligible rule", () => {
    expect(claimProblems(space(flow("main", [], [rule(["lr:auto"], "no")]), flow("fast", ["lr:fast"], [rule(["lr:auto", "lr:fast"], "no")])), oneSource)).toEqual([]);
    expect(claimProblems(space(flow("main", ["lr:auto"], undefined), flow("fast", ["lr:fast"], undefined)), oneSource)).toEqual([]);
  });

  it("checks both directions, one problem per pair and direction", () => {
    const both = [rule(["lr:auto", "lr:fast"], "no")];
    expect(claimProblems(space(flow("main", ["lr:auto"], both), flow("fast", ["lr:fast"], both)), oneSource).map((p: { message: string }) => p.message)).toEqual([
      "workflows main and fast both claim an item started in main (admit [lr:auto] satisfies fast's eligible)",
      "workflows fast and main both claim an item started in fast (admit [lr:fast] satisfies main's eligible)",
    ]);
  });
});
