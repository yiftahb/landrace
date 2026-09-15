import { createLogger, type LandraceEvent } from "../../src/runner/events.js";

describe("createLogger", () => {
  it("emits an event with its name and data", () => {
    const seen: LandraceEvent[] = [];
    createLogger({ sink: (e) => seen.push(e) })("tick.started", { tickets: 3 });
    expect(seen).toEqual([{ name: "tick.started", tickets: 3 }]);
  });

  it("redacts a secret value wherever it appears", () => {
    const seen: LandraceEvent[] = [];
    const log = createLogger({ sink: (e) => seen.push(e), redactValues: ["ghp_secret"] });
    log("step.invoked", { cmd: "claude --token ghp_secret", nested: { v: "ghp_secret" } });
    expect(JSON.stringify(seen)).not.toContain("ghp_secret");
    expect(JSON.stringify(seen)).toContain("[redacted]");
  });

  it("redacts inside arrays too", () => {
    const seen: LandraceEvent[] = [];
    createLogger({ sink: (e) => seen.push(e), redactValues: ["tok"] })("agent.event", { argv: ["a", "tok"] });
    expect(JSON.stringify(seen)).not.toContain('"tok"');
  });

  it("ignores an empty redaction entry rather than redacting everything", () => {
    const seen: LandraceEvent[] = [];
    createLogger({ sink: (e) => seen.push(e), redactValues: [""] })("tick.started", { a: "hello" });
    expect(seen[0]).toMatchObject({ a: "hello" });
  });

  it("drops agent.event unless debug is on, and keeps everything else", () => {
    const quiet: LandraceEvent[] = [];
    const q = createLogger({ sink: (e) => quiet.push(e) });
    q("agent.event", { raw: "thinking" });
    q("ticket.evaluated", { ticket: 1 });
    expect(quiet.map((e) => e.name)).toEqual(["ticket.evaluated"]);

    const loud: LandraceEvent[] = [];
    const d = createLogger({ sink: (e) => loud.push(e), debug: true });
    d("agent.event", { raw: "thinking" });
    expect(loud).toHaveLength(1);
  });
});
