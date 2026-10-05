import { definePreflight } from "#hooks/contracts.js";
import type { Preflight, RuntimeContext, Step } from "#namespace.js";
import { declaredCapabilities, declaredCreateFields, runPreflights } from "#runner/preflight.js";

/**
 * The engine's *when* for a permission problem: run every registered
 * preflight, in order, before the first tick, page or MCP connection — and
 * stop the whole run at the first one that throws, naming which one failed.
 */
const ctx = {} as RuntimeContext;

const ok = (id: string, ran: string[]): Preflight =>
  definePreflight({
    id,
    check: async () => {
      ran.push(id);
    },
  });

describe("runPreflights", () => {
  it("runs every preflight, in order, when all of them pass", async () => {
    const ran: string[] = [];
    await runPreflights([ok("a", ran), ok("b", ran), ok("c", ran)], ctx);
    expect(ran).toEqual(["a", "b", "c"]);
  });

  it("does nothing, and throws nothing, when there are none to run", async () => {
    await expect(runPreflights([], ctx)).resolves.toBeUndefined();
  });

  it("stops at the first one that throws, naming its id, and never runs the rest", async () => {
    const ran: string[] = [];
    const broken = definePreflight({
      id: "contents",
      check: async () => {
        throw new Error('token needs "Contents: Read and write" on acme/widgets');
      },
    });

    await expect(runPreflights([ok("a", ran), broken, ok("c", ran)], ctx)).rejects.toThrow(
      /preflight "contents" failed: token needs "Contents: Read and write" on acme\/widgets/,
    );
    expect(ran).toEqual(["a"]);
  });

  /**
   * A hook is arbitrary code; nothing stops it rejecting with something that
   * is not a well-behaved Error, and reading `.message` off one throws from
   * inside the very catch whose job is to report the failure.
   */
  it("survives a preflight that rejects with something that is not an Error", async () => {
    const broken = definePreflight({ id: "weird", check: async () => Promise.reject("boom") });
    await expect(runPreflights([broken], ctx)).rejects.toThrow(/preflight "weird" failed: boom/);
  });

  /** Passes ctx through unchanged, so a preflight can read config, secrets and log. */
  it("hands each preflight the context it was given", async () => {
    const seen: RuntimeContext[] = [];
    const spy = definePreflight({
      id: "spy",
      check: async (c) => {
        seen.push(c);
      },
    });
    await runPreflights([spy], ctx);
    expect(seen).toEqual([ctx]);
  });
});

describe("declaredCapabilities", () => {
  const step = (capabilities?: string[]): Step => ({ ...(capabilities === undefined ? {} : { capabilities }) }) as Step;

  // What a preflight skips is what no step of any loaded workflow asks for.
  it("is every capability any step of any workflow declares, and nothing for none", () => {
    const build = new Map([["build.md", step(["repo:read", "repo:write"])], ["triage.md", step()]]);
    const breakdown = new Map([["split.md", step(["repo:read", "items:create"])]]);
    expect([...declaredCapabilities([build, breakdown])].sort()).toEqual(["items:create", "repo:read", "repo:write"]);
    expect(declaredCapabilities([build]).has("items:create")).toBe(false);
    expect(declaredCapabilities([]).size).toBe(0);
  });
});

describe("declaredCreateFields", () => {
  const filing = (routes: NonNullable<Step["output"]>["routes"]): Step =>
    ({ output: { discriminator: "kind", shapes: { bug: {} }, routes } }) as unknown as Step;

  // A route's one effect and its list both file issues, so both are read.
  it("is each project's fields any route's tracker.create maps, from either form of route", () => {
    const support = new Map([
      ["one.md", filing([{ when: { kind: "bug" }, effect: { type: "tracker.create", project: "ENG", title: "t", fieldsFrom: { customfield_1: "a" } } }])],
      ["many.md", filing([{
        when: { kind: "bug" },
        effects: [
          { type: "tracker.comment" },
          { type: "tracker.create", project: "ENG", title: "t", fieldsFrom: { customfield_2: "b" } },
          { type: "tracker.create", project: "OPS", title: "t", fieldsFrom: { customfield_3: "c" } },
          { type: "tracker.create", project: "OPS", title: "t" },
        ],
      }])],
    ]);
    const fields = declaredCreateFields([support]);
    expect([...fields.keys()].sort()).toEqual(["ENG", "OPS"]);
    expect([...(fields.get("ENG") ?? [])].sort()).toEqual(["customfield_1", "customfield_2"]);
    expect([...(fields.get("OPS") ?? [])]).toEqual(["customfield_3"]);
    expect(declaredCreateFields([]).size).toBe(0);
  });
});
