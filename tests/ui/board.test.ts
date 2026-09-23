import type { Candidate, Held, Running, Workflow } from "#namespace.js";
import { boardView, createBoard, laneOf } from "#ui/board.js";

const workflow: Workflow = {
  version: 1, name: "t",
  eligible: [{ when: { "ticket.labels": { $in: ["go"] } }, else: "no go label" }],
  stages: [
    { id: "spec", entry: true, triggers: [{ when: { "run.stage": null } }] },
    { id: "done", terminal: true, triggers: [{ when: { "run.stage": "spec" } }] },
  ],
};

const c = (ticket: number, labels: string[], title = `t${ticket}`, url = `https://x/${ticket}`): Candidate =>
  ({ ticket, title, url, labels, assignees: [] });

const view = (candidates: Candidate[], over: Partial<Parameters<typeof boardView>[0]> = {}) =>
  boardView({
    workflow, candidates, listedAt: 1, now: 100, pid: 1,
    running: new Map(), elsewhere: new Map(), ...over,
  });

const laneFor = (candidate: Candidate, over = {}) => view([candidate], over).rows[0]?.lane;

describe("laneOf", () => {
  const row = (note: string, stage: string | null = "spec") => ({ ticket: 1, title: "t", stage, note });
  it.each([
    ["skipped: no go label", "not-admitted"],
    ["halted: more than one lr:stage:* label (a, b)", "needs-you"],
    ["blocked: needs a human", "needs-you"],
    ["waiting on you", "needs-you"],
    ["working", "waiting"],
    ["queued", "waiting"],
  ] as const)("%s -> %s", (note, lane) => {
    expect(laneOf(row(note), workflow)).toBe(lane);
  });

  it("puts a ticket at a terminal stage in discharged", () => {
    expect(laneOf(row("queued", "done"), workflow)).toBe("discharged");
  });

  it("never discharges a ticket that needs a human, terminal or not", () => {
    expect(laneOf(row("blocked: needs a human", "done"), workflow)).toBe("needs-you");
  });
});

describe("boardView", () => {
  it("puts a ticket with an agent running in `running`, over whatever its labels say", () => {
    const running = new Map<number, Running>([[1, { stage: "spec", round: 2, model: "opus", since: 40 }]]);
    const row = view([c(1, ["go", "lr:awaiting"])], { running }).rows[0];
    expect(row).toMatchObject({ lane: "running", round: 2, model: "opus", since: 40 });
  });

  it("puts a ticket locked by another process in `elsewhere`, naming the holder", () => {
    const held: Held = { ticket: 1, holder: "conversation:77", kind: "conversation", pid: 77, at: 90, deadlineMs: 1, token: "t" };
    const row = view([c(1, ["go"])], { elsewhere: new Map([[1, held]]) }).rows[0];
    expect(row?.lane).toBe("elsewhere");
    expect(row?.note).toContain("conversation");
  });

  it("does not report this process's own lock as elsewhere", () => {
    const own: Held = { ticket: 1, holder: "tick:1", kind: "tick", pid: 1, at: 90, deadlineMs: 1, token: "t" };
    expect(laneFor(c(1, ["go"]), { elsewhere: new Map([[1, own]]) })).toBe("waiting");
  });

  it("orders rows by lane, then by ticket", () => {
    const rows = view([c(3, ["go"]), c(1, ["go", "lr:blocked"]), c(2, [])]).rows;
    expect(rows.map((r) => [r.lane, r.ticket])).toEqual([["needs-you", 1], ["waiting", 3], ["not-admitted", 2]]);
  });

  it("drops a url that is not http(s), because it becomes an href", () => {
    expect(view([c(1, ["go"], "t", "javascript:alert(1)")]).rows[0]?.url).toBe("");
    expect(view([c(1, ["go"], "t", "https://ok/1")]).rows[0]?.url).toBe("https://ok/1");
  });

  it("flattens a title to one line", () => {
    expect(view([c(1, ["go"], "a\nb\u001b[2Jc")]).rows[0]?.title).toBe("a b [2Jc");
  });
});

describe("createBoard", () => {
  const shell = (now: () => number, held: (t: number) => Promise<Held | null> = async () => null) =>
    createBoard({ workflow, held, now, pid: 1 });

  it("opens a running row on step.started and closes it on step.finished", async () => {
    let t = 10;
    const board = shell(() => t);
    board.list([c(1, ["go"])]);
    board.observe({ name: "step.started", ticket: 1, stage: "spec", round: 1, model: "opus" });
    t = 20;
    expect((await board.view()).rows[0]).toMatchObject({ lane: "running", since: 10 });
    board.observe({ name: "step.finished", ticket: 1, stage: "spec", round: 1, ok: true });
    expect((await board.view()).rows[0]?.lane).toBe("waiting");
  });

  it("ignores a step event that names no ticket", async () => {
    const board = shell(() => 0);
    board.list([c(1, ["go"])]);
    board.observe({ name: "step.started", stage: "spec", round: 1 });
    expect((await board.view()).rows[0]?.lane).toBe("waiting");
  });

  it("reports no rows and a null listedAt before the first tick lands", async () => {
    expect(await shell(() => 5).view()).toEqual({ generatedAt: 5, listedAt: null, rows: [] });
  });

  it("asks the lock only about tickets it has listed", async () => {
    const asked: number[] = [];
    const board = shell(() => 0, async (t) => { asked.push(t); return null; });
    board.list([c(4, ["go"]), c(9, ["go"])]);
    await board.view();
    expect(asked.sort()).toEqual([4, 9]);
  });
});
