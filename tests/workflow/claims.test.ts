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

  /*
   * The shipped label model: full-cycle admits lr:auto and turns lr:fast away
   * (`$nin`); fastlane admits and needs both. Every rule is labels alone, so
   * the check judges each direction rather than abstaining — and says so
   * when a rule turning a label away is all that stands between two claims.
   */
  const notFast = { when: { "node.state.labels": { $nin: ["lr:fast"] } }, else: "a fastlane item (lr:fast)" };
  const fullCycle = (admit = ["lr:auto"]) => flow("full-cycle", admit, [rule(["lr:auto"], "no lr:auto label"), notFast]);
  const fast = (admit = ["lr:auto", "lr:fast"]) => flow("fast", admit, [rule(["lr:auto"], "no lr:auto label"), rule(["lr:fast"], "no lr:fast label")]);

  it("is clean for full-cycle turning lr:fast away and fastlane needing both", () => {
    expect(claimProblems(space(fullCycle(), fast()), oneSource)).toEqual([]);
  });

  it("judges a rule that turns a label away, rather than abstaining on it", () => {
    // Fastlane admitting lr:auto alone starts an item full-cycle's rules accept, $nin and all.
    expect(claimProblems(space(fullCycle(), fast(["lr:auto"])), oneSource).map((p: { message: string }) => p.message)).toEqual([
      "workflows fast and full-cycle both claim an item started in fast (admit [lr:auto] satisfies full-cycle's eligible)",
    ]);
    // Without its $nin, full-cycle would claim what fastlane starts.
    const greedy = flow("full-cycle", ["lr:auto"], [rule(["lr:auto"], "no lr:auto label")]);
    expect(claimProblems(space(greedy, fast()), oneSource).map((p: { message: string }) => p.message)).toEqual([
      "workflows fast and full-cycle both claim an item started in fast (admit [lr:auto, lr:fast] satisfies full-cycle's eligible)",
    ]);
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

  it("abstains for a workflow that admits nothing", () => {
    expect(claimProblems(space(flow("main", [], [rule(["lr:auto"], "no")]), flow("fast", ["lr:fast"], [rule(["lr:auto", "lr:fast"], "no")])), oneSource)).toEqual([]);
  });

  /*
   * Certain, not unknown: a workflow with no eligible rule claims every item
   * its source lists, so it claims every item the other starts too.
   */
  it("names both workflows when the other states no eligible rule, and so claims everything", () => {
    expect(claimProblems(space(flow("main", ["lr:auto"], [rule(["lr:auto"], "no")]), flow("fast", ["lr:fast"], undefined)), oneSource)).toEqual([{
      rule: "claims",
      message: "workflows main and fast both claim an item started in main (fast states no eligible rule, so it claims every item)",
    }]);
    expect(claimProblems(space(flow("main", ["lr:auto"], undefined), flow("fast", ["lr:fast"], undefined)), oneSource).map((p: { message: string }) => p.message)).toEqual([
      "workflows main and fast both claim an item started in main (fast states no eligible rule, so it claims every item)",
      "workflows fast and main both claim an item started in fast (main states no eligible rule, so it claims every item)",
    ]);
  });

  /*
   * A listed node carries itself and nothing else, so a rule reading a run's
   * counters can never be answered from one: the claim abstains to eligible
   * for every item, and that, too, is certain.
   */
  it("names both workflows when the other's eligible reads what no listed item carries, and so claims everything", () => {
    const counters = [rule(["lr:fast"], "no"), { when: { "run.counters.spec": { $lt: 3 } }, else: "too many rounds" }];
    expect(claimProblems(space(flow("main", ["lr:auto"], [rule(["lr:auto"], "no")]), flow("fast", ["lr:fast"], counters)), oneSource)).toEqual([{
      rule: "claims",
      message: "workflows main and fast both claim an item started in main " +
        "(fast's eligible reads run.counters.spec, which no listed item carries, so it claims every item)",
    }]);
  });

  it("checks both directions, one problem per pair and direction", () => {
    const both = [rule(["lr:auto", "lr:fast"], "no")];
    expect(claimProblems(space(flow("main", ["lr:auto"], both), flow("fast", ["lr:fast"], both)), oneSource).map((p: { message: string }) => p.message)).toEqual([
      "workflows main and fast both claim an item started in main (admit [lr:auto] satisfies fast's eligible)",
      "workflows fast and main both claim an item started in fast (admit [lr:fast] satisfies main's eligible)",
    ]);
  });
});
