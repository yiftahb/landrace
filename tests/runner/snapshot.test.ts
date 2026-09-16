import { buildSnapshot } from "../../src/runner/snapshot.js";
import { definePreHook } from "../../src/hooks/contracts.js";
import type { HookContext } from "../../src/namespace.js";

const ctx = (): Omit<HookContext, "snapshot"> => ({
  ticket: 1,
  config: {} as HookContext["config"],
  secrets: new Map(),
  signal: new AbortController().signal,
  log: () => {},
});

describe("buildSnapshot", () => {
  it("merges fragments in declaration order", async () => {
    const s = await buildSnapshot({
      ticket: 1,
      hooks: [
        definePreHook({ id: "a", run: () => ({ x: 1, shared: "first" }) }),
        definePreHook({ id: "b", run: () => ({ y: 2, shared: "second" }) }),
      ],
      ctx: ctx(),
    });
    expect(s).toMatchObject({ x: 1, y: 2, shared: "second" });
  });

  it("gives each hook what previous hooks produced", async () => {
    const s = await buildSnapshot({
      ticket: 1,
      hooks: [
        definePreHook({ id: "a", run: () => ({ base: 2 }) }),
        definePreHook({
          id: "b",
          run: ({ snapshot }) => ({ doubled: ((snapshot as { base: number }).base ?? 0) * 2 }),
        }),
      ],
      ctx: ctx(),
    });
    expect(s.doubled).toBe(4);
  });

  it("derives run state from entries and the stage label", async () => {
    const at = "2026-01-01T00:00:00Z";
    const s = await buildSnapshot({
      ticket: 1,
      hooks: [
        definePreHook({
          id: "t",
          run: () => ({
            ticket: { labels: ["lr:auto", "lr:stage:spec"] },
            entries: [{ stage: "spec", kind: "output", round: 1, at, byAgent: true }],
          }),
        }),
      ],
      ctx: ctx(),
    });
    expect(s.run).toMatchObject({ stage: "spec", counters: { spec: 1 } });
  });

  it("carries the clock in, so core never reads it", async () => {
    const s = await buildSnapshot({ ticket: 1, hooks: [], ctx: ctx(), now: 1234 });
    expect(s.now).toBe(1234);
  });

  it("names the hook that threw, rather than failing anonymously", async () => {
    await expect(
      buildSnapshot({
        ticket: 1,
        hooks: [definePreHook({ id: "flaky", run: () => { throw new Error("no network"); } })],
        ctx: ctx(),
      }),
    ).rejects.toThrow(/pre hook "flaky".*no network/);
  });

  // N1/N3 class: `(e as Error).message` on a non-Error rejection does not
  // evaluate to undefined, it *throws* — from inside the very catch block
  // whose job is to attribute the failure. A hook is a plain interface, and
  // nothing stops one (especially one doing real network I/O) from rejecting
  // with something that is not an Error.
  it("does not itself crash when the hook rejects with a non-Error value", async () => {
    await expect(
      buildSnapshot({
        ticket: 1,
        hooks: [definePreHook({ id: "flaky", run: () => { throw null; } })],
        ctx: ctx(),
      }),
    ).rejects.toThrow(/pre hook "flaky"/);
  });

  it("records the snapshot hash, which the decision cache reads later", async () => {
    const s = await buildSnapshot({
      ticket: 1, hooks: [], ctx: ctx(), now: 5, digest: (input) => `len:${input.length}`,
    });
    expect(String(s.hash)).toMatch(/^len:\d+$/);
  });

  it("gives the same hash for the same inputs at different times", async () => {
    const digest = (input: string) => `len:${input.length}`;
    const a = await buildSnapshot({ ticket: 1, hooks: [], ctx: ctx(), now: 1, digest });
    const b = await buildSnapshot({ ticket: 1, hooks: [], ctx: ctx(), now: 999, digest });
    expect(a.hash).toBe(b.hash);
  });

  it("places the ticket as null when no stage label is present", async () => {
    const s = await buildSnapshot({
      ticket: 1,
      hooks: [definePreHook({ id: "t", run: () => ({ ticket: { labels: ["lr:auto"] } }) })],
      ctx: ctx(),
    });
    expect(s.run).toMatchObject({ stage: null });
  });
});
