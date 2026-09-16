import { mayWriteRepo, unknownCapabilities } from "#conventions.js";

describe("step capabilities", () => {
  it("accepts every capability the shipped steps declare", () => {
    expect(unknownCapabilities(["repo:read", "repo:write"])).toEqual([]);
    expect(unknownCapabilities([])).toEqual([]);
    expect(unknownCapabilities(undefined)).toEqual([]);
  });

  /**
   * The whole point of the list. A capability the engine does not enforce is
   * worse than no capability at all, because the operator reads the step file,
   * sees the word, and believes they are covered — so a name nobody enforces
   * has to be a refusal, never a value that is quietly carried around.
   */
  it("names a capability nothing enforces, rather than ignoring it", () => {
    expect(unknownCapabilities(["repo:read", "net:egress"])).toEqual(["net:egress"]);
    expect(unknownCapabilities(["repo:admin", "shell"])).toEqual(["repo:admin", "shell"]);
  });

  it("is case- and whitespace-exact, so a near miss is refused rather than guessed at", () => {
    expect(unknownCapabilities(["Repo:Write"])).toEqual(["Repo:Write"]);
    expect(unknownCapabilities([" repo:write"])).toEqual([" repo:write"]);
  });

  it("says a step may write only when it declared so", () => {
    expect(mayWriteRepo(["repo:read", "repo:write"])).toBe(true);
    expect(mayWriteRepo(["repo:read"])).toBe(false);
    expect(mayWriteRepo([])).toBe(false);
    // Absent, not empty: a step that declares no capabilities at all is the
    // most restricted one there is, never the least.
    expect(mayWriteRepo(undefined)).toBe(false);
  });
});
