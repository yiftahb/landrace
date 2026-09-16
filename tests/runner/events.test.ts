import { createLogger } from "../../src/runner/events.js";
import type { LandraceEvent } from "../../src/namespace.js";

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

  // Fix round 4: the length check trims to decide whether a value is long
  // enough, but redaction used the untrimmed value — a secret sourced from a
  // quoted .env line (`TOKEN=" ghp_secret "`) validated fine on its trimmed
  // length and then never matched the bare form of itself anywhere it
  // actually appears in a log line, leaking it in full.
  it("redacts a secret whose configured value has surrounding whitespace, matching its bare form", () => {
    const seen: LandraceEvent[] = [];
    const log = createLogger({ sink: (e) => seen.push(e), redactValues: ["  ghp_secretvalue123  "] });
    log("step.invoked", { cmd: "claude --token ghp_secretvalue123" });
    expect(JSON.stringify(seen)).not.toContain("ghp_secretvalue123");
    expect(JSON.stringify(seen)).toContain("[redacted]");
  });

  // debug, and an assertion on what actually came out: without it the event
  // is dropped for being an agent.event, `seen` stays empty, and a test that
  // cannot fail claims the array case is covered.
  it("redacts inside arrays too", () => {
    const seen: LandraceEvent[] = [];
    createLogger({ sink: (e) => seen.push(e), redactValues: ["ghp_tokenvalue"], debug: true })(
      "agent.event", { argv: ["a", "ghp_tokenvalue"] });
    expect(seen).toEqual([{ name: "agent.event", argv: ["a", "[redacted]"] }]);
  });

  /**
   * Both debug-only events, for the same reason in two sizes: agent output is
   * voluminous and attacker-influenced, and a whole snapshot per pass would
   * bury every other line. Printed on request, and data either way.
   */
  it("drops the debug-only events unless debug is on, and keeps everything else", () => {
    const quiet: LandraceEvent[] = [];
    const q2 = createLogger({ sink: (e) => quiet.push(e) });
    q2("snapshot.built", { snapshot: { ticket: { number: 1 } } });
    q2("tick.started", {});
    expect(quiet.map((e) => e.name)).toEqual(["tick.started"]);

    const loud: LandraceEvent[] = [];
    createLogger({ sink: (e) => loud.push(e), debug: true })("snapshot.built", { snapshot: {} });
    expect(loud).toHaveLength(1);
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
