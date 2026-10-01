import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createClient, GitHubForge } from "landrace/integrations/github";
import { branchHeads, gitIn } from "landrace/kit";
import type { Effect, Git, HookContext, Snapshot } from "#namespace.js";
import { createFakeTracker, noBranches, type FakeTracker } from "#tests/support/fake-tracker.js";
import { commitAt, commitOn, gitRepoWithOrigin, removeRepos } from "#tests/support/repo.js";

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

type Call = { args: string[]; env: Record<string, string> };

/** The origin the fake GitHub is: the only one landrace hands its token to. */
const ORIGIN = "https://github.com/acme/widgets.git";

/**
 * git, run for real, with every call it was handed written down — and, when
 * `url` is given, reporting that as origin's push URL. The token path is then
 * taken exactly as it would be for a GitHub origin, while the push itself
 * still lands in the local bare repository and nothing leaves the machine.
 */
const recording = (root: string, url?: string, intercept = false): { git: Git; calls: Call[] } => {
  const calls: Call[] = [];
  const real = gitIn(root);
  return {
    calls,
    git: async (args, env = {}, opts) => {
      calls.push({ args, env });
      if (url !== undefined && args[0] === "remote" && args[1] === "get-url") return `${url}\n`;
      // Intercepted where the destination is real GitHub: recorded, never sent.
      if (intercept && args[0] === "push") return "";
      return real(args, env, opts);
    },
  };
};

/** No git at all: origin's URL, one local branch never pushed, and a push that does what it is told. */
const scripted = (url: string, push: () => Promise<string> = async () => ""): { git: Git; calls: Call[] } => {
  const calls: Call[] = [];
  const git: Git = async (args, env = {}) => {
    calls.push({ args, env });
    if (args[0] === "remote") return `${url}\n`;
    if (args[0] === "for-each-ref") return args.includes("refs/heads") ? `refs/heads/landrace/1\0${"a".repeat(40)}\n` : "";
    if (args[0] === "push") return push();
    throw new Error(`the script has no answer for git ${args.join(" ")}`);
  };
  return { git, calls };
};

/** The configuration a call handed git through its environment, as key/value pairs. */
const configOf = (env: Record<string, string>): Array<[string, string]> =>
  Array.from({ length: Number(env.GIT_CONFIG_COUNT ?? 0) }, (_, i) =>
    [env[`GIT_CONFIG_KEY_${i}`] ?? "", env[`GIT_CONFIG_VALUE_${i}`] ?? ""] as [string, string]);

const pushOf = (calls: Call[]): Call => {
  const found = calls.find((c) => c.args[0] === "push");
  if (!found) throw new Error("git was never asked to push");
  return found;
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
    const { git, calls } = recording(root, ORIGIN);
    const gh = createFakeTracker([{ number: 1 }], { git });

    await post(gh).apply(push, contextOf(gh, await snapshotOf(gh)));

    for (const call of calls) {
      expect(call.args.join(" ")).not.toContain(TOKEN);
      expect(call.args.join(" ")).not.toContain(BASIC);
    }
    expect(configOf(pushOf(calls).env)).toContainEqual([`http.${ORIGIN}.extraheader`, `AUTHORIZATION: basic ${BASIC}`]);
  });

  /*
   * `git push origin` pushes to every push URL origin has, and a step that
   * may write shares this config: one more pushurl, pointing at another
   * repository on github.com, and a header scoped to the host would go there
   * too. landrace pushes to exactly one destination — the one it checked.
   */
  it("refuses an origin with more than one push URL, before any token is built", async () => {
    const { root } = await checkout();
    await build(root, "landrace/1");
    await run(root, "config", "--add", "remote.origin.pushurl", ORIGIN);
    await run(root, "config", "--add", "remote.origin.pushurl", "https://github.com/attacker/evil.git");
    const { git, calls } = recording(root, undefined, true);
    const gh = createFakeTracker([{ number: 1 }], { git });

    await expect(post(gh).apply(push, contextOf(gh, await snapshotOf(gh))))
      .rejects.toThrow(/2 push URLs[\s\S]*exactly one/);
    expect(calls.filter((c) => c.args[0] === "push")).toEqual([]);
    expect(JSON.stringify(calls)).not.toContain(BASIC);
  });

  it("pushes nowhere at all when origin names two destinations", async () => {
    const { root, origin } = await checkout();
    await build(root, "landrace/1");
    const second = await mkdtemp(join(tmpdir(), "lr-second-"));
    made.push(second);
    await run(second, "init", "-q", "--bare", "-b", "main");
    await run(root, "config", "--add", "remote.origin.pushurl", `file://${origin}`);
    await run(root, "config", "--add", "remote.origin.pushurl", `file://${second}`);
    const gh = createFakeTracker([{ number: 1 }], { git: gitIn(root) });

    await expect(post(gh).apply(push, contextOf(gh, await snapshotOf(gh)))).rejects.toThrow(/exactly one/);
    expect(await commitAt(origin, "refs/heads/landrace/1")).toBeNull();
    expect(await commitAt(second, "refs/heads/landrace/1")).toBeNull();
  });

  /*
   * And the header is scoped to that one URL, not to github.com: were a
   * second destination to slip in some other way, git would not hand it
   * the token. Asked of git itself, under the environment the push was given.
   */
  it("scopes the header to the exact URL origin pushes to", async () => {
    const { root } = await checkout();
    await build(root, "landrace/1");
    await run(root, "remote", "set-url", "origin", ORIGIN);
    const { git, calls } = recording(root, undefined, true);
    const gh = createFakeTracker([{ number: 1 }], { git });

    await post(gh).apply(push, contextOf(gh, await snapshotOf(gh)));

    const env = pushOf(calls).env;
    expect(configOf(env).map(([key]) => key)).not.toContain("http.https://github.com/.extraheader");
    const header = (url: string): Promise<string | null> =>
      exec("git", ["config", "--get-urlmatch", "http.extraheader", url], { cwd: root, env: { ...process.env, ...env } })
        .then((r) => r.stdout.trim(), () => null);
    expect(await header(ORIGIN)).toBe(`AUTHORIZATION: basic ${BASIC}`);
    expect(await header(`${ORIGIN}/info/refs`)).toBe(`AUTHORIZATION: basic ${BASIC}`);
    expect(await header("https://github.com/attacker/evil.git")).toBeNull();
    expect(await header("https://github.com/acme/widgets.git-evil")).toBeNull();
  });

  /*
   * An explicit refspec is the whole of what is pushed: git ignores
   * remote.origin.push when one is given, refuses a mirror remote outright,
   * and follows tags only when asked — which the push says it is not.
   */
  it("pushes the ticket's branch and nothing else, whatever origin's push settings say", async () => {
    const { root, origin } = await checkout();
    const sha = await build(root, "landrace/1");
    await run(root, "branch", "secret", "main");
    await run(root, "-c", "user.email=t@example.com", "-c", "user.name=t", "tag", "-a", "v1", "-m", "v1", "main");
    await run(root, "config", "remote.origin.push", "refs/heads/*:refs/heads/*");
    await run(root, "config", "push.followTags", "true");
    const gh = createFakeTracker([{ number: 1 }], { git: gitIn(root) });

    await post(gh).apply(push, contextOf(gh, await snapshotOf(gh)));

    expect(await commitAt(origin, "refs/heads/landrace/1")).toBe(sha);
    expect(await commitAt(origin, "refs/heads/secret")).toBeNull();
    expect(await commitAt(origin, "refs/tags/v1")).toBeNull();
  });

  it("pushes nothing to a mirror remote, and says why", async () => {
    const { root, origin } = await checkout();
    await build(root, "landrace/1");
    await run(root, "config", "remote.origin.mirror", "true");
    const gh = createFakeTracker([{ number: 1 }], { git: gitIn(root) });

    await expect(post(gh).apply(push, contextOf(gh, await snapshotOf(gh))))
      .rejects.toThrow(/could not push landrace\/1[\s\S]*mirror/);
    expect(await commitAt(origin, "refs/heads/landrace/1")).toBeNull();
  });

  /*
   * The environment the token rides in is inherited by everything git starts
   * — and an agent in a write step shares this repository's config, so it
   * can point core.hooksPath at a script of its own. The control push shows
   * the planted hooks really do run; landrace's own push runs none of them.
   */
  it("runs none of the checkout's hooks, not even ones an agent configured", async () => {
    const { root, origin } = await checkout();
    const sha = await build(root, "landrace/1");
    const hooks = await mkdtemp(join(tmpdir(), "lr-hooks-"));
    made.push(hooks);
    const seen = join(hooks, "seen.txt");
    for (const name of ["pre-push", "reference-transaction"]) {
      await writeFile(join(hooks, name), `#!/bin/sh\nenv >> "${seen}"\ncat > /dev/null\nexit 0\n`, { mode: 0o755 });
    }
    await run(root, "config", "core.hooksPath", hooks);

    await run(root, "branch", "control", "main");
    await run(root, "push", "-q", "origin", "control");
    expect(existsSync(seen)).toBe(true);
    await rm(seen);

    const { git, calls } = recording(root, ORIGIN);
    const gh = createFakeTracker([{ number: 1 }], { git });
    await post(gh).apply(push, contextOf(gh, await snapshotOf(gh)));

    expect(await commitAt(origin, "refs/heads/landrace/1")).toBe(sha);
    expect(configOf(pushOf(calls).env)).toContainEqual(["core.hooksPath", "/dev/null"]);
    expect(existsSync(seen)).toBe(false);
  });

  /*
   * The token goes to GitHub, for this repository, and nowhere else — and
   * only for a URL in a form nothing can read two ways. The decision is made
   * on the string git will use; a parser here that disagreed with git's or
   * curl's about where the host ends would hand the token to wherever git
   * thinks the host is.
   */
  it.each([
    ORIGIN,
    "https://github.com/acme/widgets",
    "https://github.com/acme/widgets/",
    "https://github.com/acme/widgets.git/",
    "https://GITHUB.com/acme/widgets.git",
    "https://GitHub.com/Acme/Widgets.git",
  ])("hands the token to a push to %s", async (url) => {
    const { git, calls } = scripted(url);
    const gh = createFakeTracker([{ number: 1 }], { git });

    await post(gh).apply(push, contextOf(gh, await snapshotOf(gh)));

    const config = configOf(pushOf(calls).env);
    expect(config).toContainEqual([`http.${url}.extraheader`, `AUTHORIZATION: basic ${BASIC}`]);
    expect(config).toContainEqual(["core.hooksPath", "/dev/null"]);
  });

  /* ssh, and hosts that are not GitHub: the operator's own credentials, and no token at all. */
  it.each([
    "git@github.com:acme/widgets.git",
    "git@GitHub.com:acme/widgets",
    "ssh://git@github.com/acme/widgets.git",
    "file:///srv/git/widgets.git",
    "https://gitlab.example.com/acme/widgets.git",
  ])("pushes to %s with no token", async (url) => {
    const { git, calls } = scripted(url);
    const gh = createFakeTracker([{ number: 1 }], { git });

    await post(gh).apply(push, contextOf(gh, await snapshotOf(gh)));

    expect(JSON.stringify(calls)).not.toContain(BASIC);
    expect(configOf(pushOf(calls).env)).toContainEqual(["core.hooksPath", "/dev/null"]);
  });

  /*
   * Everything that looks like GitHub and is not in one of those forms:
   * userinfo, a backslash or percent-encoding a parser may or may not read
   * as part of the host, a port, a host that only starts with github.com, a
   * query, a fragment, an upper-case scheme. Pushing without a token would
   * still be pushing to something that might be another repository, so it
   * is refused — and no token is ever built.
   */
  it.each([
    "https://github.com\\@evil.com/acme/widgets.git",
    "https://github.com%40evil.com/acme/widgets.git",
    "https://github.com/acme%2Fwidgets.git",
    "https://github.com/acme/wid%67ets.git",
    "https://github.com:443/acme/widgets.git",
    "https://github.com.evil.com/acme/widgets.git",
    "https://me:pat@github.com/acme/widgets.git",
    "https://github.com@evil.com/acme/widgets.git",
    "https://github.com/acme/widgets.git?x=1",
    "https://github.com/acme/widgets.git#main",
    "HTTPS://github.com/acme/widgets.git",
    "https://github.com/acme/widgets/extra.git",
    "http://github.com/acme/widgets.git",
  ])("refuses to push to %s, and builds no token", async (url) => {
    const { git, calls } = scripted(url);
    const gh = createFakeTracker([{ number: 1 }], { git });

    await expect(post(gh).apply(push, contextOf(gh, await snapshotOf(gh))))
      .rejects.toThrow(/refusing to push landrace\/1/);
    expect(calls.filter((c) => c.args[0] === "push")).toEqual([]);
    expect(JSON.stringify(calls)).not.toContain(BASIC);
  });

  /* A password may carry a raw "@": everything up to the last one before the host is left out. */
  it("names no credentials when it refuses a URL that carries them", async () => {
    const { git } = scripted("https://u:p@ss@github.com/other/x");
    const gh = createFakeTracker([{ number: 1 }], { git });

    const failure = await post(gh).apply(push, contextOf(gh, await snapshotOf(gh))).then(() => "", (e: unknown) => String(e));

    expect(failure).toMatch(/refusing to push/);
    expect(failure).not.toMatch(/ss@|p@ss|u:p/);
  });

  it.each(["https://github.com/someone/else.git", "git@github.com:someone/else.git"])(
    "refuses to push to %s, which is not the tracker's repository",
    async (url) => {
      const { git, calls } = scripted(url);
      const gh = createFakeTracker([{ number: 1 }], { git });

      await expect(post(gh).apply(push, contextOf(gh, await snapshotOf(gh))))
        .rejects.toThrow(/someone\/else[\s\S]*acme\/widgets/);
      expect(calls.filter((c) => c.args[0] === "push")).toEqual([]);
    },
  );

  /*
   * A build that committed nothing leaves the branch where origin's default
   * branch already is: pushing it proposes nothing, and GitHub would refuse
   * the pull request anyway. Said here, naming the ticket and the way out,
   * and asked again every tick — so it clears itself once somebody commits.
   */
  it("refuses a branch nothing was committed to, naming the ticket and the way out", async () => {
    const { root, origin } = await checkout();
    await run(root, "remote", "set-head", "origin", "main");
    await run(root, "branch", "landrace/1", "main");
    const gh = createFakeTracker([{ number: 1 }], { git: gitIn(root) });

    await expect(post(gh).apply(push, contextOf(gh, await snapshotOf(gh))))
      .rejects.toThrow(/nothing was committed on landrace\/1 for #1[\s\S]*commit to the branch/i);
    expect(await commitAt(origin, "refs/heads/landrace/1")).toBeNull();

    await commitOn(root, "landrace/1", "late.ts");
    await expect(post(gh).apply(push, contextOf(gh, await snapshotOf(gh)))).resolves.toBeUndefined();
  });

  it("counts a branch origin's default branch has since moved past as nothing committed too", async () => {
    const { root } = await checkout();
    await run(root, "remote", "set-head", "origin", "main");
    await run(root, "branch", "landrace/1", "main");
    await writeFile(join(root, "later.ts"), "export const later = 1;\n");
    await run(root, "add", "-A");
    await run(root, "commit", "-qm", "later");
    await run(root, "push", "-q", "origin", "main");
    const gh = createFakeTracker([{ number: 1 }], { git: gitIn(root) });

    await expect(post(gh).apply(push, contextOf(gh, await snapshotOf(gh))))
      .rejects.toThrow(/nothing was committed on landrace\/1/);
  });

  /* Bounded, and stopped with the run: a push that hangs holds the ticket's lock. */
  it("stops when the run is aborted", async () => {
    const { root, origin } = await checkout();
    await build(root, "landrace/1");
    const gh = createFakeTracker([{ number: 1 }], { git: gitIn(root) });
    const stop = new AbortController();
    stop.abort();

    await expect(post(gh).apply(push, { ...contextOf(gh, await snapshotOf(gh)), signal: stop.signal }))
      .rejects.toThrow(/abort/i);
    expect(await commitAt(origin, "refs/heads/landrace/1")).toBeNull();
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
   * #20: pr-human-review pushes as it is entered, and a ticket comes back to
   * it after a person's reply. By then a person may have pushed to the pull
   * request, or pressed "Update branch", and a fetch brought the news: origin
   * already has everything the branch has. That is nothing to publish, not a
   * push to refuse on every tick.
   */
  it("pushes nothing, and succeeds, when origin already has everything the branch has", async () => {
    const { root, origin } = await checkout();
    await build(root, "landrace/1");
    await run(root, "push", "-q", "origin", "landrace/1");
    const theirs = await mkdtemp(join(tmpdir(), "lr-theirs-"));
    made.push(theirs);
    await run(theirs, "clone", "-q", "-b", "landrace/1", `file://${origin}`, ".");
    await run(theirs, "config", "user.email", "o@example.com");
    await run(theirs, "config", "user.name", "o");
    await writeFile(join(theirs, "updated.ts"), "export const updated = 1;\n");
    await run(theirs, "add", "-A");
    await run(theirs, "commit", "-qm", "update branch");
    await run(theirs, "push", "-q", "origin", "landrace/1");
    await run(root, "fetch", "-q", "origin");
    const remote = await run(origin, "rev-parse", "refs/heads/landrace/1");

    const gh = createFakeTracker([{ number: 1 }], { git: gitIn(root) });
    await expect(post(gh).apply(push, contextOf(gh, await snapshotOf(gh)))).resolves.toBeUndefined();

    expect(await run(origin, "rev-parse", "refs/heads/landrace/1")).toBe(remote);
  });

  /*
   * Attacked directly: a git whose failure quotes the header back — the way
   * a trace variable in the operator's own environment would make it. What
   * reaches the error, and so the log and the ticket, must not carry it.
   */
  it("keeps the token out of the error when git's own output quotes it", async () => {
    const logged: string[] = [];
    const { git: leaky } = scripted(ORIGIN, async () => {
      throw new Error(`fatal: unable to access: header AUTHORIZATION: basic ${BASIC} (token ${TOKEN})`);
    });
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

  /*
   * Only a push that was behind gets the "not forced" explanation: a server
   * hook refusing it is a different problem, and pointing the operator at
   * the branch history would send them the wrong way.
   */
  it("says the branch moved on only when that is why the push was refused", async () => {
    const { git } = scripted(ORIGIN, async () => {
      throw new Error("! [remote rejected] landrace/1 -> landrace/1 (pre-receive hook declined)\nerror: failed to push some refs");
    });
    const gh = createFakeTracker([{ number: 1 }], { git });

    const failure = await post(gh).apply(push, contextOf(gh, await snapshotOf(gh))).then(() => "", (e: unknown) => String(e));

    expect(failure).toMatch(/pre-receive hook declined/);
    expect(failure).not.toMatch(/force-push/);
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

  /* GitHub's own way of saying what the push check says, in the same words. */
  it("reads GitHub's 'No commits between' as nothing committed on the branch", async () => {
    const { root } = await checkout();
    await build(root, "landrace/1");
    const gh = createFakeTracker([{ number: 1 }], { git: gitIn(root) });
    gh.breakOn((r) => r.method === "POST" && r.path === "/pulls", 422, {
      message: "Validation Failed",
      errors: [{ resource: "PullRequest", code: "custom", message: "No commits between main and landrace/1" }],
    });

    await expect(post(gh).apply(open, contextOf(gh, await snapshotOf(gh))))
      .rejects.toThrow(/nothing was committed on landrace\/1 for #1[\s\S]*commit to the branch/i);
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
 * Where the forge runs git when nobody hands it one: the repository of the
 * file that constructed it, which for a project's `.landrace/hooks/` is that
 * project — never the directory the process happened to be started from.
 */
describe("the checkout the forge works in", () => {
  /** The forge's branch heads, read from a directory that is no repository at all, against this repository's. */
  const readsThisRepository = async (forge: GitHubForge): Promise<void> => {
    const root = await run(process.cwd(), "rev-parse", "--show-toplevel");
    const back = process.cwd();
    const away = await mkdtemp(join(tmpdir(), "lr-away-"));
    made.push(away);
    process.chdir(away);
    try {
      expect(await forge.heads()).toEqual(await branchHeads(gitIn(root)));
    } finally {
      process.chdir(back);
    }
  };
  const client = () => createClient({ repo: "acme/widgets", token: TOKEN });

  it("is the repository of the file that constructs it, whatever the working directory", async () => {
    await readsThisRepository(new GitHubForge({ client: client() }));
  });

  /*
   * A subclass is how one piece of a role is changed, and it can live in a
   * shared package outside the project: the file that says `new` is still
   * the project's, and its repository is the one to read and push.
   */
  it("is the constructing file's repository when the forge is a subclass defined elsewhere", async () => {
    const lib = await mkdtemp(join(tmpdir(), "lr-lib-"));
    made.push(lib);
    const file = join(lib, "forges.cjs");
    await writeFile(file, [
      "module.exports = (Base) => [",
      "  class Implicit extends Base {},",
      "  class Explicit extends Base { constructor(opts) { super(opts); } },",
      "];",
    ].join("\n"));
    type Forge = new (opts: ConstructorParameters<typeof GitHubForge>[0]) => GitHubForge;
    const [Implicit, Explicit] = (createRequire(__filename)(file) as (base: typeof GitHubForge) => [Forge, Forge])(GitHubForge);
    await readsThisRepository(new Implicit({ client: client() }));
    await readsThisRepository(new Explicit({ client: client() }));
  });
});

/*
 * A forge beside another vendor's tracker: `Closes #7` in a pull request's
 * body closes GitHub's issue #7 on merge — some unrelated issue — and a
 * closing reference read back would tie the pull request to it. Off, the
 * forge writes none and reads none, and a head is the only tie.
 */
describe("a forge with closing references off", () => {
  const forgeOver = (gh: FakeTracker): GitHubForge =>
    new GitHubForge({ client: createClient({ repo: "acme/widgets", token: TOKEN, fetchImpl: gh.fetchImpl }), git: noBranches });

  it("opens a pull request with no closing reference in its body", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    await forgeOver(gh).openPull({ ticket: "1", branch: "landrace/1", title: "t" }, gh.ctx);
    expect([...gh.pulls.values()]).toEqual([expect.objectContaining({ head: "landrace/1", body: "" })]);
    expect([...gh.pulls.values()][0]?.closes).toBeUndefined();
  });

  it("ties a pull request to a ticket by its head alone, and asks GitHub for no closing reference", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    gh.openPull({ number: 20, head: "feature/x", closes: [1] });
    gh.openPull({ number: 21, head: "landrace/1", closes: [1] });
    const forge = forgeOver(gh);

    expect((await forge.pullsNaming("1", gh.ctx)).map((p) => [p.number, p.tickets])).toEqual([[21, []]]);
    expect((await forge.pulls(gh.ctx)).map((p) => p.tickets)).toEqual([[], []]);
    expect(gh.graphql.filter((q) => /closingIssuesReferences|closedByPullRequestsReferences/.test(q.query))).toEqual([]);
  });
});

/* git that does not finish is stopped, whether it overran or the run was stopped. */
describe("the git the hook runs", () => {
  it("is stopped when it overruns its time, and says so", async () => {
    const { root } = await checkout();
    // Waits on stdin, which nothing will ever write to.
    await expect(gitIn(root)(["hash-object", "--stdin"], {}, { timeoutMs: 300 })).rejects.toThrow(/did not finish within/);
  });

  it("is stopped when the run is aborted, and says so", async () => {
    const { root } = await checkout();
    const stop = new AbortController();
    const waiting = gitIn(root)(["hash-object", "--stdin"], {}, { signal: stop.signal });
    stop.abort();
    await expect(waiting).rejects.toThrow(/aborted/);
  });
});
