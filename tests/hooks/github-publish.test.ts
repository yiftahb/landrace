import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gitIn, hookRepository, type Git } from "#landrace/hooks/github.js";
import type { Effect, HookContext, Snapshot } from "#namespace.js";
import { createFakeTracker, type FakeTracker } from "#tests/support/fake-tracker.js";
import { commitOn, gitRepoWithOrigin, removeRepos } from "#tests/support/repo.js";

/*
 * Real git, real processes: see tests/agent/worktree.test.ts for why a minute.
 */
jest.setTimeout(60_000);

const exec = promisify(execFile);
const run = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", args, { cwd })).stdout.trim();

/** The token the fake GitHub is configured with, and the header git would carry it in. */
const TOKEN = "test-token";
const BASIC = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");

const made: string[] = [];
afterAll(async () => {
  while (made.length) await rm(made.pop() as string, { recursive: true, force: true });
  await removeRepos();
});

/** The operator's checkout with a bare `origin`, and a commit on a branch the way a build leaves one. */
const checkout = gitRepoWithOrigin;
const build = (root: string, branch: string, file = "built.ts"): Promise<string> => commitOn(root, branch, file);

/** git, run for real, with every call it was handed written down. */
const recording = (root: string): { git: Git; calls: Array<{ args: string[]; env: Record<string, string> }> } => {
  const calls: Array<{ args: string[]; env: Record<string, string> }> = [];
  const real = gitIn(root);
  return { calls, git: async (args, env = {}) => { calls.push({ args, env }); return real(args, env); } };
};

const snapshotOf = async (gh: FakeTracker, ticket = "1"): Promise<Snapshot> => {
  const graph = await gh.registry.source?.read(ticket, gh.ctx);
  const snapshot: Snapshot = { graph, node: graph?.nodes.find((n) => n.id === ticket) };
  let merged = snapshot;
  for (const hook of gh.registry.pre) merged = { ...merged, ...(await hook.run({ ...gh.ctx, ticket, snapshot: merged })) };
  return merged;
};

const contextOf = (gh: FakeTracker, snapshot: Snapshot, log: HookContext["log"] = () => {}): HookContext =>
  ({ ...gh.ctx, ticket: "1", snapshot, log });

const post = (gh: FakeTracker) => {
  const hook = gh.registry.post[0];
  if (!hook) throw new Error("the fake tracker registered no post hook");
  return hook;
};

describe("the branch facts the pre hook reads", () => {
  it("reports every local branch head and every head origin last showed, from the checkout alone", async () => {
    const { root } = await checkout();
    const sha = await build(root, "landrace/1");
    const main = await run(root, "rev-parse", "main");
    const gh = createFakeTracker([{ number: 1 }], { git: gitIn(root) });

    const fragment = await gh.registry.pre[0]?.run({ ...gh.ctx, ticket: "1", snapshot: {} });

    expect(fragment?.git).toEqual({
      local: { main, "landrace/1": sha },
      remote: { main },
    });
    // No network: the fake GitHub was asked nothing about branches.
    expect(gh.requests.filter((r) => /git\/refs|branches/.test(r.path))).toEqual([]);
  });
});

describe("branch.push", () => {
  const push: Effect = { type: "branch.push", branch: "landrace/1" };

  it("pushes the branch to origin, and reads back as satisfied once the remote-tracking ref has caught up", async () => {
    const { root, origin } = await checkout();
    const sha = await build(root, "landrace/1");
    const gh = createFakeTracker([{ number: 1 }], { git: gitIn(root) });

    const before = await snapshotOf(gh);
    expect(post(gh).satisfied(before, push)).toBe(false);

    await post(gh).apply(push, contextOf(gh, before));

    expect(await run(origin, "rev-parse", "refs/heads/landrace/1")).toBe(sha);
    expect(await run(root, "rev-parse", "refs/remotes/origin/landrace/1")).toBe(sha);
    expect(post(gh).satisfied(await snapshotOf(gh), push)).toBe(true);
  });

  it("is satisfied, with nothing to push, when the checkout has no such branch", async () => {
    const { root } = await checkout();
    const gh = createFakeTracker([{ number: 1 }], { git: gitIn(root) });
    expect(post(gh).satisfied(await snapshotOf(gh), push)).toBe(true);
  });

  it("is not satisfied again after a fix round commits on top of what was pushed", async () => {
    const { root } = await checkout();
    await build(root, "landrace/1");
    const gh = createFakeTracker([{ number: 1 }], { git: gitIn(root) });
    await post(gh).apply(push, contextOf(gh, await snapshotOf(gh)));

    await commitOn(root, "landrace/1", "fix.ts");

    expect(post(gh).satisfied(await snapshotOf(gh), push)).toBe(false);
  });

  /*
   * argv is readable by every process on the machine, and a token in a URL
   * is also written into git's own errors and the reflog. The header goes
   * through git's environment config instead, scoped to github.com.
   */
  it("carries the token in git's environment, never on its command line", async () => {
    const { root } = await checkout();
    await build(root, "landrace/1");
    const { git, calls } = recording(root);
    const gh = createFakeTracker([{ number: 1 }], { git });

    await post(gh).apply(push, contextOf(gh, await snapshotOf(gh)));

    const pushed = calls.find((c) => c.args[0] === "push");
    expect(pushed).toBeDefined();
    for (const call of calls) {
      expect(call.args.join(" ")).not.toContain(TOKEN);
      expect(call.args.join(" ")).not.toContain(BASIC);
    }
    expect(Object.values(pushed?.env ?? {})).toContain(`AUTHORIZATION: basic ${BASIC}`);
    expect(Object.values(pushed?.env ?? {})).toContain("http.https://github.com/.extraheader");
  });

  it("never forces, and says so when origin has moved on without this checkout", async () => {
    const { root, origin } = await checkout();
    await build(root, "landrace/1");
    // Somebody else's commit on the same branch, pushed straight to origin.
    const theirs = await mkdtemp(join(tmpdir(), "lr-theirs-"));
    made.push(theirs);
    await run(theirs, "clone", "-q", `file://${origin}`, ".");
    await run(theirs, "config", "user.email", "o@example.com");
    await run(theirs, "config", "user.name", "o");
    await run(theirs, "checkout", "-q", "-b", "landrace/1");
    await writeFile(join(theirs, "other.ts"), "export const other = 1;\n");
    await run(theirs, "add", "-A");
    await run(theirs, "commit", "-qm", "theirs");
    await run(theirs, "push", "-q", "origin", "landrace/1");
    const remote = await run(origin, "rev-parse", "refs/heads/landrace/1");

    const { git, calls } = recording(root);
    const gh = createFakeTracker([{ number: 1 }], { git });
    await expect(post(gh).apply(push, contextOf(gh, await snapshotOf(gh))))
      .rejects.toThrow(/landrace\/1[\s\S]*does not force-push/);

    expect(await run(origin, "rev-parse", "refs/heads/landrace/1")).toBe(remote);
    const args = calls.flatMap((c) => c.args);
    expect(args).not.toContain("--force");
    expect(args).not.toContain("-f");
    expect(args.filter((a) => a.startsWith("+"))).toEqual([]);
  });

  /*
   * Attacked directly: a git whose failure quotes the header back — the way
   * a trace variable in the operator's own environment would make it. What
   * reaches the error, and so the log and the ticket, must not carry it.
   */
  it("keeps the token out of the error when git's own output quotes it", async () => {
    const logged: string[] = [];
    const leaky: Git = async (args) => {
      if (args[0] === "for-each-ref") return `refs/heads/landrace/1\0${"a".repeat(40)}\n`;
      throw new Error(`fatal: unable to access: header AUTHORIZATION: basic ${BASIC} (token ${TOKEN})`);
    };
    const gh = createFakeTracker([{ number: 1 }], { git: leaky });
    const snapshot = await snapshotOf(gh);

    const failure = await post(gh)
      .apply(push, contextOf(gh, snapshot, (event, data) => logged.push(`${event} ${JSON.stringify(data)}`)))
      .then(() => null, (e: unknown) => String(e));

    expect(failure).toMatch(/could not push landrace\/1/);
    expect(failure).not.toContain(TOKEN);
    expect(failure).not.toContain(BASIC);
    expect(logged.join("\n")).not.toContain(TOKEN);
  });

  it("refuses an effect that names no branch, or one git would refuse", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    const snapshot = await snapshotOf(gh);
    expect(() => post(gh).satisfied(snapshot, { type: "branch.push" })).toThrow(/branch/);
    await expect(post(gh).apply({ type: "branch.push", branch: "--force" }, contextOf(gh, snapshot)))
      .rejects.toThrow(/not a usable branch name/);
  });
});

describe("pull.open", () => {
  const open: Effect = { type: "pull.open", branch: "landrace/1" };

  it("opens a pull request from the effect's branch into the default branch, closing the ticket", async () => {
    const { root } = await checkout();
    await build(root, "landrace/1");
    const gh = createFakeTracker([{ number: 1, title: "Add CSV export" }], { git: gitIn(root) });

    await post(gh).apply(open, contextOf(gh, await snapshotOf(gh)));

    expect([...gh.pulls.values()]).toEqual([
      expect.objectContaining({ head: "landrace/1", base: "main", title: "Add CSV export", body: "Closes #1", closes: [1] }),
    ]);
    // And the graph now carries it, by branch, which is what satisfied() reads.
    expect(post(gh).satisfied(await snapshotOf(gh), open)).toBe(true);
  });

  /*
   * One ticket, two branches: a pull request from one says nothing about the
   * other, so each is opened — and each is satisfied — on its own.
   */
  it("is satisfied per branch, not by the ticket having some pull request", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    gh.openPull({ head: "api/1", closes: [1] });
    const snapshot = await snapshotOf(gh);

    expect(post(gh).satisfied(snapshot, { type: "pull.open", branch: "api/1" })).toBe(true);
    expect(post(gh).satisfied(snapshot, { type: "pull.open", branch: "ui/1" })).toBe(false);
  });

  it("counts a merged pull request as opened, and an abandoned one as not", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    gh.openPull({ head: "landrace/1", merged: true });
    gh.openPull({ head: "old/1", closes: [1], state: "CLOSED" });
    const snapshot = await snapshotOf(gh);

    expect(post(gh).satisfied(snapshot, open)).toBe(true);
    expect(post(gh).satisfied(snapshot, { type: "pull.open", branch: "old/1" })).toBe(false);
  });

  /*
   * The crash window: the request went out, the process died before the next
   * read, and the replanned effect asks again. GitHub's "already exists" is
   * the effect having landed.
   */
  it("counts GitHub's 'a pull request already exists' as done", async () => {
    const { root } = await checkout();
    await build(root, "landrace/1");
    const gh = createFakeTracker([{ number: 1 }], { git: gitIn(root) });
    const stale = await snapshotOf(gh);

    await post(gh).apply(open, contextOf(gh, stale));
    await expect(post(gh).apply(open, contextOf(gh, stale))).resolves.toBeUndefined();
    expect(gh.pulls.size).toBe(1);
  });

  it("names the permission when the token may not open pull requests", async () => {
    const { root } = await checkout();
    await build(root, "landrace/1");
    const gh = createFakeTracker([{ number: 1 }], { git: gitIn(root) });
    gh.breakOn((r) => r.method === "POST" && r.path === "/pulls", 403);

    await expect(post(gh).apply(open, contextOf(gh, await snapshotOf(gh))))
      .rejects.toThrow(/Pull requests: Read and write/);
  });

  it("says so, rather than asking GitHub, when there is no such branch to open one from", async () => {
    const { root } = await checkout();
    const gh = createFakeTracker([{ number: 1 }], { git: gitIn(root) });

    await expect(post(gh).apply(open, contextOf(gh, await snapshotOf(gh))))
      .rejects.toThrow(/landrace\/1[\s\S]*no such branch/);
    expect(gh.requests.filter((r) => r.path === "/pulls")).toEqual([]);
  });
});

/*
 * Where the hook looks when nobody tells it: the repository its own file is
 * in, which for a project's `.landrace/hooks/` is that project — never the
 * directory the process happened to be started from.
 */
describe("the checkout the shipped hook works in", () => {
  it("is the repository the hook file lives in", async () => {
    const expected = realpathSync(await run(join(process.cwd(), ".landrace"), "rev-parse", "--show-toplevel"));
    expect(realpathSync(await hookRepository())).toBe(expected);
  });
});
