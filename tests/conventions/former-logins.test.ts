import { entriesFromComments, foreignRecords, formerLoginsOf, markTrust, parseOrigin, renderMarker, renderOrigin } from "#conventions.js";
import type { Logins, RuntimeConfig, TrackerComment } from "#namespace.js";

/*
 * #237: a former tracker login's marks count up to its `until`; every other
 * mark is foreign — neither a record nor a reply.
 */
const T = "2026-11-01T09:00:00Z";
const BEFORE = "2026-11-01T08:59:59Z";
const AFTER = "2026-11-01T09:00:01Z";
const LOGINS: Logins = { current: "new", former: [{ login: "old", until: T }] };
const NONE: Logins = { current: "new", former: [] };

const marked = (stage: string, kind = "entered"): string =>
  "did it" + renderMarker({ stage, kind, round: 1, marker: `${kind}:${stage}:1` });
const comment = (login: string, body: string, created_at: string, updated_at?: string): TrackerComment => ({
  id: 1, body, created_at, ...(updated_at === undefined ? {} : { updated_at }), user: { login },
});

describe("markTrust", () => {
  it("trusts a former login's mark created and edited at or before its until", () => {
    expect(markTrust("old", { created: BEFORE, edited: BEFORE }, LOGINS)).toBe("ours");
    expect(markTrust("old", { created: T, edited: T }, LOGINS)).toBe("ours");
  });

  it("compares instants, not strings: an until in another offset", () => {
    const logins: Logins = { current: "new", former: [{ login: "old", until: "2026-11-01T11:00:00+02:00" }] };
    expect(markTrust("old", { created: BEFORE, edited: BEFORE }, logins)).toBe("ours");
    expect(markTrust("old", { created: AFTER, edited: AFTER }, logins)).toBe("after-until");
  });

  it("is after-until when created after, or edited after", () => {
    expect(markTrust("old", { created: AFTER, edited: AFTER }, LOGINS)).toBe("after-until");
    expect(markTrust("old", { created: BEFORE, edited: AFTER }, LOGINS)).toBe("after-until");
  });

  it("is no-time with no created time, no edit time, or one that does not parse", () => {
    expect(markTrust("old", { created: undefined, edited: BEFORE }, LOGINS)).toBe("no-time");
    expect(markTrust("old", { created: "", edited: BEFORE }, LOGINS)).toBe("no-time");
    expect(markTrust("old", { created: BEFORE, edited: undefined }, LOGINS)).toBe("no-time");
    expect(markTrust("old", { created: "yesterday", edited: BEFORE }, LOGINS)).toBe("no-time");
  });

  it("needs no edit time where the thing is known never to have been edited", () => {
    expect(markTrust("old", { created: BEFORE, edited: null }, LOGINS)).toBe("ours");
  });

  it("gives the current login no time check", () => {
    expect(markTrust("new", { created: undefined, edited: undefined }, LOGINS)).toBe("ours");
    expect(markTrust("NEW[bot]", { created: AFTER, edited: AFTER }, LOGINS)).toBe("ours");
  });

  it("is unlisted for an account in neither list, or none at all", () => {
    expect(markTrust("mallory", { created: BEFORE, edited: BEFORE }, LOGINS)).toBe("unlisted");
    expect(markTrust(undefined, { created: BEFORE, edited: BEFORE }, LOGINS)).toBe("unlisted");
    expect(markTrust(null, { created: BEFORE, edited: BEFORE }, LOGINS)).toBe("unlisted");
    expect(markTrust("old", { created: BEFORE, edited: BEFORE }, NONE)).toBe("unlisted");
  });

  it("refuses a blank current login, as reading markers without one re-runs every step", () => {
    expect(() => markTrust("old", { created: BEFORE, edited: BEFORE }, { current: " ", former: [] })).toThrow(/login/);
  });
});

describe("formerLoginsOf", () => {
  const config = (tracker: unknown): RuntimeConfig => ({ tracker } as unknown as RuntimeConfig);

  it("is the configured list, and empty without the key", () => {
    expect(formerLoginsOf(config({ formerLogins: [{ login: "old", until: T }] }))).toEqual([{ login: "old", until: T }]);
    expect(formerLoginsOf(config({ repo: "a/b" }))).toEqual([]);
    expect(formerLoginsOf(config(undefined))).toEqual([]);
  });

  it("refuses a list the schema would have refused, rather than trusting it", () => {
    expect(() => formerLoginsOf(config({ formerLogins: [{ login: "old" }] }))).toThrow(/formerLogins/);
    expect(() => formerLoginsOf(config({ formerLogins: [{ login: "old", until: "2026-11-01" }] }))).toThrow(/formerLogins/);
    expect(() => formerLoginsOf(config({ formerLogins: "old" }))).toThrow(/formerLogins/);
  });
});

describe("entriesFromComments, with former logins", () => {
  it("reads a former login's marker within its cutoff as a record", () => {
    const [entry] = entriesFromComments([comment("old", marked("spec"), BEFORE, BEFORE)], LOGINS);
    expect(entry).toMatchObject({ stage: "spec", kind: "entered", byAgent: true });
  });

  it("drops every foreign mark: neither a record nor a reply", () => {
    const entries = entriesFromComments([
      comment("old", marked("spec"), AFTER, AFTER),
      comment("old", marked("spec"), BEFORE, AFTER),
      comment("old", marked("spec"), BEFORE),
      comment("mallory", marked("spec"), BEFORE, BEFORE),
    ], LOGINS);
    expect(entries).toEqual([]);
  });

  it("reads a plain comment from any author as a reply", () => {
    const entries = entriesFromComments([
      comment("old", "hello", AFTER, AFTER),
      comment("mallory", "hi", BEFORE),
      comment("new", "board reply", AFTER, AFTER),
    ], LOGINS);
    expect(entries.map((e) => [e.kind, e.byAgent])).toEqual([["human", false], ["human", false], ["human", false]]);
  });

  it("reads old then new as one run", () => {
    const entries = entriesFromComments([
      comment("old", marked("spec"), BEFORE, BEFORE),
      comment("new", marked("build"), AFTER, AFTER),
    ], LOGINS);
    expect(entries.map((e) => e.stage)).toEqual(["spec", "build"]);
  });
});

describe("foreignRecords", () => {
  it("counts each foreign mark and names each author once with why", () => {
    expect(foreignRecords([
      comment("old", marked("a"), AFTER, AFTER),
      comment("old", marked("b"), AFTER, AFTER),
      comment("old", marked("c"), BEFORE),
      comment("mallory", marked("d"), BEFORE, BEFORE),
      comment("old", marked("e"), BEFORE, BEFORE),
      comment("mallory", "plain", BEFORE, BEFORE),
    ], LOGINS)).toEqual({
      count: 4,
      authors: [{ login: "old", why: "after-until" }, { login: "old", why: "no-time" }, { login: "mallory", why: "unlisted" }],
    });
  });

  it("is nothing without a foreign mark", () => {
    expect(foreignRecords([comment("new", marked("a"), AFTER)], LOGINS)).toEqual({ count: 0, authors: [] });
  });
});

describe("parseOrigin, with former logins", () => {
  const body = "child" + renderOrigin({ parent: "1", stage: "breakdown", round: 1 });

  it("keeps an origin a former login wrote before its cutoff", () => {
    expect(parseOrigin(body, "old", BEFORE, LOGINS)).toEqual({ parent: "1", stage: "breakdown", round: 1 });
  });

  it("loses one written after it, or with no time", () => {
    expect(parseOrigin(body, "old", AFTER, LOGINS)).toBeNull();
    expect(parseOrigin(body, "old", undefined, LOGINS)).toBeNull();
    expect(parseOrigin(body, "mallory", BEFORE, LOGINS)).toBeNull();
  });

  it("keeps the current login's without a time", () => {
    expect(parseOrigin(body, "new", undefined, LOGINS)).not.toBeNull();
  });
});
