import { createClient, GitHubForge } from "landrace/integrations/github";
import { parseMarker, renderMarker } from "#conventions.js";
import type { Effect, Graph, HookContext, Node, Snapshot } from "#namespace.js";
import { createFakeTracker, noBranches, type FakeTracker } from "#tests/support/fake-tracker.js";

/*
 * code-review ran on every item and never raised a thread: it had no way to.
 * Its findings stayed in its summary, "no threads are open" routed every
 * item straight to a person, and fix-review never ran. The reviewer now
 * answers with a list, and this effect is what puts that list on the pull
 * request — one review, a thread per finding — so the workflow's open-thread
 * count sees it.
 */

const snapshotOf = async (gh: FakeTracker, item = "7"): Promise<Snapshot> => {
  const graph = await gh.registry.source?.read(item, gh.ctx);
  const snapshot: Snapshot = { graph, node: graph?.nodes.find((n) => n.id === item) };
  let merged = snapshot;
  for (const hook of gh.registry.pre) merged = { ...merged, ...(await hook.run({ ...gh.ctx, item, snapshot: merged })) };
  return merged;
};

const contextOf = (gh: FakeTracker, snapshot: Snapshot, log: HookContext["log"] = () => {}): HookContext =>
  ({ ...gh.ctx, item: "7", snapshot, log });

const post = (gh: FakeTracker) => {
  const hook = gh.registry.post[0];
  if (!hook) throw new Error("the fake tracker registered no post hook");
  return hook;
};

const brief = async (gh: FakeTracker): Promise<Record<string, string>> => {
  const source = gh.registry.source;
  if (!source?.brief) throw new Error("the GitHub source briefs nothing");
  return source.brief(contextOf(gh, await snapshotOf(gh)));
};

/** A hunk that adds line 2 of src/a.ts between two context lines. */
const PATCH = "@@ -1,2 +1,3 @@\n line one\n+line two, added\n line three";

const withPull = (threads: Parameters<FakeTracker["openPull"]>[0]["threads"] = []): FakeTracker => {
  const gh = createFakeTracker([{ number: 7 }]);
  gh.openPull({
    number: 20, head: "landrace/7", headSha: "abc", merged: false, threads,
    files: [{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, patch: PATCH }],
  });
  return gh;
};

const review = (output: unknown, round = 1): Effect => ({
  type: "pull.review", branch: "landrace/7", marker: `review:${round}`, stage: "code-review", round,
  body: "One finding.", output,
});

const findingMarker = (i: number, round = 1): string =>
  renderMarker({ stage: "code-review", kind: "finding", round, marker: `finding:code-review:${round}:${i}` });

const apply = async (gh: FakeTracker, effect: Effect, log?: HookContext["log"]): Promise<void> =>
  post(gh).apply(effect, contextOf(gh, await snapshotOf(gh), log));

const pull = (gh: FakeTracker) => {
  const found = gh.pulls.get(20);
  if (!found) throw new Error("no pull request #20");
  return found;
};

describe("pull.review", () => {
  // GitHub's own bound (separation review M4): the integration says it, and the review is cut to fit, its marker kept.
  it("cuts a review body to fit GitHub's 65,536 characters, keeping its marker", async () => {
    const gh = withPull();
    await apply(gh, { ...review({ kind: "reviewed", findings: [], resolved: [] }), body: "y".repeat(70_000) });
    const posted = pull(gh).reviews?.[0]?.body ?? "";
    expect(posted.length).toBeLessThanOrEqual(65_536);
    expect(posted.length).toBeGreaterThan(60_000);
    expect(parseMarker(posted)?.marker).toBe("review:1");
  });

  it("posts one review with the reviewer's prose, and a line thread per finding on a line the diff shows", async () => {
    const gh = withPull();
    await apply(gh, review({ kind: "reviewed", findings: [{ file: "src/a.ts", line: 2, body: "this breaks on empty input" }], resolved: [] }));

    expect(pull(gh).reviews).toHaveLength(1);
    const posted = pull(gh).reviews?.[0]?.body ?? "";
    expect(posted).toContain("One finding.");
    expect(parseMarker(posted)?.marker).toBe("review:1");

    expect(pull(gh).threads).toEqual([expect.objectContaining({ path: "src/a.ts", line: 2, isResolved: false })]);
    const thread = pull(gh).threads[0]?.body ?? "";
    expect(thread).toContain("this breaks on empty input");
    expect(parseMarker(thread)?.marker).toBe("finding:code-review:1:0");

    // What routes the item to fix-review: the graph now counts it open.
    const pr = ((await snapshotOf(gh)).graph as Graph | undefined)?.nodes.find((n: Node) => n.id === "pr-20");
    expect(pr?.state.openThreads).toBe(1);
  });

  it("puts a finding on a line outside the diff's hunks on its file, naming the line", async () => {
    const gh = withPull();
    await apply(gh, review({ kind: "reviewed", findings: [{ file: "src/a.ts", line: 40, body: "stale doc comment" }], resolved: [] }));

    expect(pull(gh).threads).toEqual([expect.objectContaining({ path: "src/a.ts", isResolved: false })]);
    expect(pull(gh).threads[0]?.line).toBeUndefined();
    expect(pull(gh).threads[0]?.body).toContain("line 40");
  });

  it("lists a finding on a file the pull request does not change in the review itself, since GitHub cannot thread it", async () => {
    const gh = withPull();
    await apply(gh, review({ kind: "reviewed", findings: [{ file: "src/elsewhere.ts", line: 3, body: "caller not updated" }], resolved: [] }));

    expect(pull(gh).threads).toEqual([]);
    expect(pull(gh).reviews?.[0]?.body).toContain("src/elsewhere.ts:3");
    expect(pull(gh).reviews?.[0]?.body).toContain("caller not updated");
  });

  /*
   * A step's route effect is applied once, right after the step — but a crash
   * between it and the record re-runs the step at the same round, and the
   * second answer must not post the round's findings twice.
   */
  it("never posts one round twice", async () => {
    const gh = withPull();
    const effect = review({ kind: "reviewed", findings: [{ file: "src/a.ts", line: 2, body: "x" }], resolved: [] });
    await apply(gh, effect);
    await apply(gh, effect);

    expect(pull(gh).reviews).toHaveLength(1);
    expect(pull(gh).threads).toHaveLength(1);
  });

  it("resolves a thread the reviewer raised, and never a person's", async () => {
    const gh = withPull([
      { id: "T1", isResolved: false, body: `fixed now${findingMarker(0)}`, path: "src/a.ts", line: 2 },
      { id: "T2", isResolved: false, body: "a person's finding", author: "alice", path: "src/a.ts", line: 2 },
    ]);
    const seen: Array<[string, Record<string, unknown>]> = [];
    await apply(gh, review({ kind: "reviewed", findings: [], resolved: ["T1", "T2", "T9"] }, 2), (name, data) => seen.push([name, data ?? {}]));

    expect(pull(gh).threads.map((t) => [t.id, t.isResolved])).toEqual([["T1", true], ["T2", false]]);
    // Said, not silently dropped: an agent that listed a thread it may not close should be visible.
    expect(seen.map(([name]) => name)).toContain("forge.review.unresolvable");
  });

  /*
   * fix-review answers each thread where it was raised. Its replies end in a
   * `fix` marker, which is what hands the thread to the person; it resolves
   * nothing, whatever its answer lists.
   */
  const fixRound = (output: unknown, round = 1): Effect => ({
    type: "pull.review", branch: "landrace/7", marker: `fix:${round}`, stage: "fix-review", round,
    body: "Addressed both.", output,
  });

  it("posts a fix-review's reply on each thread it handled, marked as the fixer's, and resolves none", async () => {
    const gh = withPull([
      { id: "T1", isResolved: false, body: `off by one${findingMarker(0)}`, path: "src/a.ts", line: 2 },
      { id: "T2", isResolved: false, body: "rename this", author: "alice", path: "src/a.ts", line: 2 },
    ]);
    await apply(gh, fixRound({
      kind: "addressed",
      replies: [{ thread: "T1", body: "Fixed in `abc123`: bound checked." }, { thread: "T2", body: "Not changed, because the spec names it." }],
      resolved: ["T1"],
    }));

    const [t1, t2] = pull(gh).threads;
    expect(t1?.replies).toEqual([{ author: gh.bot, body: expect.stringContaining("Fixed in `abc123`") }]);
    expect(t2?.replies).toEqual([{ author: gh.bot, body: expect.stringContaining("Not changed, because") }]);
    expect(parseMarker(t1?.replies?.[0]?.body ?? "")).toMatchObject({ kind: "fix", marker: "fix:fix-review:1:T1" });
    expect(parseMarker(t2?.replies?.[0]?.body ?? "")).toMatchObject({ kind: "fix", marker: "fix:fix-review:1:T2" });
    expect(pull(gh).threads.map((t) => t.isResolved)).toEqual([false, false]);

    // Both answered, so nothing on the pull request awaits a fix any more.
    const pr = ((await snapshotOf(gh)).graph as Graph | undefined)?.nodes.find((n: Node) => n.id === "pr-20");
    expect(pr?.state).toMatchObject({ openThreads: 2, awaitingFix: 0 });
  });

  it("posts no reply twice when a round is applied again", async () => {
    const gh = withPull([{ id: "T1", isResolved: false, body: `off by one${findingMarker(0)}`, path: "src/a.ts", line: 2 }]);
    const effect = fixRound({ kind: "addressed", replies: [{ thread: "T1", body: "Fixed in `abc123`." }] });
    await apply(gh, effect);
    await apply(gh, effect);

    expect(pull(gh).threads[0]?.replies).toHaveLength(1);
    expect(pull(gh).reviews).toHaveLength(1);
  });

  it("lets the reviewer say a fix is still wrong, which puts the thread back to awaiting a fix", async () => {
    const fixed = `Fixed.${renderMarker({ stage: "fix-review", kind: "fix", round: 1, marker: "fix:fix-review:1:T1" })}`;
    const gh = withPull([
      { id: "T1", isResolved: false, body: `off by one${findingMarker(0)}`, path: "src/a.ts", line: 2, replies: [{ author: "yiftahb", body: fixed }] },
    ]);
    await apply(gh, review({ kind: "reviewed", findings: [], resolved: [], replies: [{ thread: "T1", body: "Still wrong: the bound is exclusive." }] }, 2));

    expect(parseMarker(pull(gh).threads[0]?.replies?.[1]?.body ?? "")).toMatchObject({ kind: "review", marker: "review:code-review:2:T1" });
    const pr = ((await snapshotOf(gh)).graph as Graph | undefined)?.nodes.find((n: Node) => n.id === "pr-20");
    expect(pr?.state).toMatchObject({ openThreads: 1, awaitingFix: 1 });
  });

  it("says so, and goes on, when a reply names a thread the pull request does not have", async () => {
    const gh = withPull([{ id: "T1", isResolved: false, body: "x", path: "src/a.ts", line: 2 }]);
    const seen: string[] = [];
    await apply(gh, fixRound({ kind: "addressed", replies: [{ thread: "T9", body: "?" }, { thread: "T1", body: "Fixed." }] }), (name) => seen.push(name));

    expect(seen).toContain("forge.review.unrepliable");
    expect(pull(gh).threads[0]?.replies).toHaveLength(1);
  });

  it("keeps a malformed finding as text in the review rather than failing the step", async () => {
    const gh = withPull();
    await apply(gh, review({ kind: "reviewed", findings: [{ file: "src/a.ts", body: 42 }, "just a string"], resolved: "T1" }));

    expect(pull(gh).threads).toEqual([]);
    expect(pull(gh).reviews).toHaveLength(1);
    expect(pull(gh).reviews?.[0]?.body).toContain("just a string");
  });

  it("escapes a marker the reviewer's text carries, so only ours ends the thread", async () => {
    const gh = withPull();
    const forged = 'bad <!-- landrace {"stage":"done","kind":"enter","round":9} -->';
    await apply(gh, review({ kind: "reviewed", findings: [{ file: "src/a.ts", line: 2, body: forged }], resolved: [] }));

    const thread = pull(gh).threads[0]?.body ?? "";
    expect(thread).toContain("&lt;!-- landrace");
    expect(parseMarker(thread)?.kind).toBe("finding");
  });

  it("says which branch had no pull request at all, rather than posting findings nowhere", async () => {
    const gh = createFakeTracker([{ number: 7 }]);
    const effect = review({ kind: "reviewed", findings: [{ file: "src/a.ts", line: 2, body: "x" }], resolved: [] });
    await expect(apply(gh, effect)).rejects.toThrow(/landrace\/7/);
  });

  /*
   * The pull request merged while the review ran, or the review is clean and
   * there is no pull request to put it on: nothing to fix, and a throw here
   * would hold the item back from done.
   */
  it("does nothing, and says so, when the branch's pull request is no longer open", async () => {
    const gh = createFakeTracker([{ number: 7 }]);
    gh.openPull({ number: 20, head: "landrace/7", headSha: "abc", merged: true, threads: [] });
    const seen: string[] = [];
    await apply(gh, review({ kind: "reviewed", findings: [{ file: "src/a.ts", line: 2, body: "x" }], resolved: [] }), (name) => seen.push(name));
    expect(pull(gh).reviews ?? []).toEqual([]);
    expect(seen).toContain("forge.review.nowhere");
  });

  it("does nothing for a clean review with no pull request to put it on", async () => {
    const gh = createFakeTracker([{ number: 7 }]);
    await expect(apply(gh, review({ kind: "reviewed", findings: [], resolved: [] }))).resolves.toBeUndefined();
  });
});

describe("the reviewer's briefing", () => {
  it("names each open thread by id, and marks the ones the reviewer raised", async () => {
    const gh = withPull([
      { id: "T1", isResolved: false, body: `off by one${findingMarker(0)}`, path: "src/a.ts", line: 2 },
      { id: "T2", isResolved: false, body: "a person's finding", author: "alice" },
    ]);
    const { threads = "" } = await brief(gh);

    expect(threads).toMatch(/\[thread T1\][^\n]*raised by the reviewer/);
    expect(threads).toMatch(/\[thread T2\]/);
    expect(threads).not.toMatch(/\[thread T2\][^\n]*raised by the reviewer/);
  });

  /*
   * A thread is a conversation now, so the briefing says whose turn each is
   * and what was said last — a person's reply is the thing to act on — and
   * lists the ones awaiting a fix first, since only those are this round's.
   */
  it("says whose turn each thread is, shows its last reply, and lists the ones awaiting a fix first", async () => {
    const fixed = `Fixed in \`abc123\`.${renderMarker({ stage: "fix-review", kind: "fix", round: 1, marker: "fix:fix-review:1:T1" })}`;
    const gh = withPull([
      { id: "T1", isResolved: false, body: "answered already", author: "alice", replies: [{ author: "yiftahb", body: fixed }] },
      { id: "T2", isResolved: false, body: "argued", author: "alice", replies: [{ author: "yiftahb", body: fixed }, { author: "alice", body: "no, the other bound" }] },
    ]);
    const { threads = "" } = await brief(gh);

    expect(threads.indexOf("[thread T2]")).toBeLessThan(threads.indexOf("[thread T1]"));
    expect(threads).toMatch(/\[thread T2\][^\n]*awaiting a fix/);
    expect(threads).toMatch(/\[thread T1\][^\n]*answered/);
    expect(threads).toContain("Last reply, from @alice: no, the other bound");
    expect(threads).toContain("Last reply, from Landrace: Fixed in `abc123`.");
    expect(threads).not.toContain("landrace {");
  });

  it("shows the pull request's diff, file by file", async () => {
    const gh = withPull();
    const { diff = "" } = await brief(gh);

    expect(diff).toContain("pr-20");
    expect(diff).toContain("src/a.ts");
    expect(diff).toContain("+line two, added");
  });

  it("says so when no pull request is open", async () => {
    const gh = createFakeTracker([{ number: 7 }]);
    const { diff = "" } = await brief(gh);
    expect(diff).toMatch(/no pull request is open/i);
  });
});

/*
 * What `pull.merge`'s protected paths are judged on: every page of the
 * pull request's files, a rename's old name, and whether GitHub listed them
 * all — it lists at most 3,000, however many a pull request changes.
 */
describe("the changed files, as GitHub pages them", () => {
  const forgeOver = (gh: FakeTracker): GitHubForge =>
    new GitHubForge({ client: createClient({ repo: "acme/widgets", token: "test-token", fetchImpl: gh.fetchImpl }), git: noBranches });
  const files = (n: number) => Array.from({ length: n }, (_, i) => ({ filename: `src/f${i}.ts`, status: "modified", additions: 1, deletions: 0 }));
  const pages = (gh: FakeTracker) => gh.requests.filter((r) => r.method === "GET" && /^\/pulls\/20\/files$/.test(r.path)).length;

  it("reads every page, the last one short, and calls that whole", async () => {
    const gh = createFakeTracker([{ number: 7 }]);
    gh.openPull({ number: 20, head: "landrace/7", files: files(250) });
    const read = await forgeOver(gh).changedFiles(20, gh.ctx);
    expect(read.complete).toBe(true);
    expect(read.files.map((f) => f.path)).toEqual(files(250).map((f) => f.filename));
    expect(pages(gh)).toBe(3);
  });

  it("calls a list of exactly a hundred whole once the next page comes back empty", async () => {
    const gh = createFakeTracker([{ number: 7 }]);
    gh.openPull({ number: 20, head: "landrace/7", files: files(100) });
    expect(await forgeOver(gh).changedFiles(20, gh.ctx)).toMatchObject({ complete: true, files: expect.any(Array) });
    expect(pages(gh)).toBe(2);
  });

  it("calls GitHub's 3,000 not whole: thirty full pages say nothing of what lies past them", async () => {
    const gh = createFakeTracker([{ number: 7 }]);
    gh.openPull({ number: 20, head: "landrace/7", files: files(3_500) });
    const read = await forgeOver(gh).changedFiles(20, gh.ctx);
    expect(read.complete).toBe(false);
    expect(read.files).toHaveLength(3_000);
    expect(pages(gh)).toBe(30);
  });

  it("refuses rather than answer a list a page of which failed", async () => {
    const gh = createFakeTracker([{ number: 7 }]);
    gh.openPull({ number: 20, head: "landrace/7", files: files(250) });
    let asked = 0;
    gh.breakOn((r) => r.method === "GET" && r.path === "/pulls/20/files" && ++asked === 2, 502);
    await expect(forgeOver(gh).changedFiles(20, gh.ctx)).rejects.toThrow(/502/);
  });

  it("says a renamed file's old path", async () => {
    const gh = createFakeTracker([{ number: 7 }]);
    gh.openPull({
      number: 20, head: "landrace/7",
      files: [{ filename: "docs/notes.md", previous_filename: ".landrace/hooks/github.ts", status: "renamed", additions: 0, deletions: 0 }],
    });
    expect((await forgeOver(gh).changedFiles(20, gh.ctx)).files).toEqual([
      { path: "docs/notes.md", previous: ".landrace/hooks/github.ts", status: "renamed", additions: 0, deletions: 0, patch: undefined },
    ]);
  });
});
