describe("the github adapter is reached by id, not imported", () => {
  it("builds a tracker, a pre hook and a post hook for a known id", async () => {
    const { createTrackerAdapter } = await import("../../src/adapters/index.js");
    const a = createTrackerAdapter("github", { repo: "acme/widgets", token: "t" });
    expect(a).toMatchObject({ id: "github" });
    expect(a.pre.id).toBe("github");
    expect(a.post.handles).toEqual(expect.arrayContaining(["tracker.label", "tracker.comment", "tracker.status"]));
  });

  it("names the known adapters when asked for one that does not exist", async () => {
    const { createTrackerAdapter } = await import("../../src/adapters/index.js");
    expect(() => createTrackerAdapter("jira", { repo: "a/b", token: "t" })).toThrow(/unknown tracker adapter "jira".*github/);
  });

  it("nothing outside src/adapters imports a tracker implementation", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) => {
        const p = join(d, n);
        return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
      });
    const offenders = walk("src")
      .filter((f) => !f.startsWith("src/adapters"))
      .filter((f) => /adapters\/github/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
