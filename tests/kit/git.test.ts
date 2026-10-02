import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  branchHeads, fetchBranch, gitIn, headIn, headsOf, nothingCommitted, originPushUrl, ownGit, pushBranch, repositoryOf,
} from "#kit/git.js";
import type { Git, Snapshot } from "#namespace.js";
import { commitAt, commitOn, gitRepo, gitRepoWithOrigin, pushedElsewhere, removeRepos } from "#tests/support/repo.js";

/* Real git, real processes: see tests/agent/worktree.test.ts for why a minute. */
jest.setTimeout(60_000);

const exec = promisify(execFile);
const run = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", args, { cwd })).stdout.trim();
const signal = new AbortController().signal;

afterAll(removeRepos);

type Call = { args: string[]; env: Record<string, string> };

/** Real git in `root`, with every call written down. */
const recording = (root: string): { git: Git; calls: Call[] } => {
  const calls: Call[] = [];
  const real = gitIn(root);
  return {
    calls,
    git: async (args, env = {}, opts) => {
      calls.push({ args, env });
      return real(args, env, opts);
    },
  };
};

const snapshotWith = (fields: Partial<Snapshot>): Snapshot => fields as Snapshot;

/** The configuration a call handed git through its environment, in order, past any the operator had set. */
const configOf = (env: Record<string, string>): Array<[string, string]> =>
  Object.keys(env).filter((k) => k.startsWith("GIT_CONFIG_KEY_"))
    .sort((a, b) => Number(a.slice(15)) - Number(b.slice(15)))
    .map((k) => [env[k] ?? "", env[k.replace("KEY", "VALUE")] ?? ""] as [string, string]);

describe("repositoryOf", () => {
  it("is the repository a file is in, from a path or a file: URL", async () => {
    const root = await gitRepo();
    const file = join(root, "src", "a.ts");
    expect(realpathSync(await repositoryOf(file))).toBe(realpathSync(root));
    expect(realpathSync(await repositoryOf(pathToFileURL(file).href))).toBe(realpathSync(root));
  });
});

describe("ownGit", () => {
  it("finds its repository the first time it is needed, and only then", async () => {
    const root = await gitRepo();
    let asked = 0;
    const git = ownGit(async () => {
      asked++;
      return root;
    });
    expect(asked).toBe(0);
    expect(realpathSync((await git(["rev-parse", "--show-toplevel"])).trim())).toBe(realpathSync(root));
    await git(["status"]);
    expect(asked).toBe(1);
  });
});

describe("branchHeads", () => {
  it("reads every local head and origin's, leaving out origin/HEAD and a reserved name", async () => {
    const { root } = await gitRepoWithOrigin();
    const built = await commitOn(root, "landrace/1", "a.ts");
    await run(root, "branch", "constructor", "main");
    await run(root, "remote", "set-head", "origin", "main");
    const main = await commitAt(root, "main");

    const heads = await branchHeads(gitIn(root));

    expect(heads.local).toEqual({ main, "landrace/1": built });
    expect(heads.remote).toEqual({ main });
    expect(Object.hasOwn(heads.local, "constructor")).toBe(false);
  });
});

describe("headsOf", () => {
  it("halts when the snapshot carries no heads, rather than guessing either way", () => {
    expect(() => headsOf(snapshotWith({}))).toThrow(/does not record this checkout's branches/);
    expect(() => headsOf(snapshotWith({ git: { local: {} } }))).toThrow(/does not record/);
  });

  it("answers the two maps the snapshot carries", () => {
    const git = { local: { a: "1" }, remote: { a: "2" } };
    expect(headsOf(snapshotWith({ git }))).toEqual(git);
  });
});

describe("headIn", () => {
  it("reads own keys only, and only a string", () => {
    expect(headIn({ a: "sha" }, "a")).toBe("sha");
    expect(headIn({}, "constructor")).toBeUndefined();
    expect(headIn({ a: 1 }, "a")).toBeUndefined();
  });
});

describe("nothingCommitted", () => {
  it("names the branch and the item, and says how it clears", () => {
    expect(nothingCommitted("landrace/7", "7").message).toBe(
      "nothing was committed on landrace/7 for #7: it is already part of origin's default branch, so there is " +
      "nothing to push or propose. Commit to the branch, then Retry",
    );
  });
});

describe("originPushUrl", () => {
  it("is origin's one push URL", async () => {
    const { root, origin } = await gitRepoWithOrigin();
    expect(await originPushUrl(gitIn(root), "landrace/1", signal)).toBe(`file://${origin}`);
  });

  it("refuses an origin with more than one push URL", async () => {
    const { root, origin } = await gitRepoWithOrigin();
    await run(root, "remote", "set-url", "--add", "--push", "origin", `file://${origin}`);
    await run(root, "remote", "set-url", "--add", "--push", "origin", `file://${origin}-2`);
    await expect(originPushUrl(gitIn(root), "landrace/1", signal))
      .rejects.toThrow(/refusing to push landrace\/1: origin has 2 push URLs/);
  });
});

describe("pushBranch", () => {
  it("publishes the branch to origin, with hooks off and the caller's config after any already set", async () => {
    const { root, origin } = await gitRepoWithOrigin();
    const built = await commitOn(root, "landrace/1", "a.ts");
    const { git, calls } = recording(root);
    const saved = { ...process.env };
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "user.name";
    process.env.GIT_CONFIG_VALUE_0 = "someone";
    try {
      await pushBranch(git, "landrace/1", "1", signal, [["credential.helper", ""]]);
    } finally {
      process.env = saved;
    }

    expect(await commitAt(origin, "refs/heads/landrace/1")).toBe(built);
    const push = calls.find((c) => c.args[0] === "push");
    expect(push?.args).toEqual(["push", "origin", "refs/heads/landrace/1:refs/heads/landrace/1"]);
    expect(push?.env).toEqual({
      GIT_CONFIG_COUNT: "5",
      GIT_CONFIG_KEY_1: "core.hooksPath", GIT_CONFIG_VALUE_1: "/dev/null",
      GIT_CONFIG_KEY_2: "push.followTags", GIT_CONFIG_VALUE_2: "false",
      GIT_CONFIG_KEY_3: "push.recurseSubmodules", GIT_CONFIG_VALUE_3: "no",
      GIT_CONFIG_KEY_4: "credential.helper", GIT_CONFIG_VALUE_4: "",
    });
  });

  it("pushes nothing when origin already has everything the branch has", async () => {
    const { root } = await gitRepoWithOrigin();
    await commitOn(root, "landrace/1", "a.ts");
    await pushBranch(gitIn(root), "landrace/1", "1", signal, []);
    const { git, calls } = recording(root);

    await pushBranch(git, "landrace/1", "1", signal, []);

    expect(calls.some((c) => c.args[0] === "push")).toBe(false);
  });

  it("refuses a branch with nothing on it past origin's default branch", async () => {
    const { root } = await gitRepoWithOrigin();
    await run(root, "remote", "set-head", "origin", "main");
    await run(root, "branch", "landrace/2", "main");
    await expect(pushBranch(gitIn(root), "landrace/2", "2", signal, []))
      .rejects.toThrow(nothingCommitted("landrace/2", "2").message);
  });

  it("says a rejected push is origin having moved on, and never forces", async () => {
    const git: Git = async (args) => {
      if (args[0] === "for-each-ref") return "";
      if (args[0] === "push") throw new Error("git push in /x: ! [rejected] landrace/3 (non-fast-forward)");
      throw new Error(`unscripted git ${args.join(" ")}`);
    };
    await expect(pushBranch(git, "landrace/3", "3", signal, [])).rejects.toThrow(
      "could not push landrace/3 to origin — origin's landrace/3 has commits this checkout does not, and " +
      "landrace does not force-push; bring the branch up to date by hand and the item carries on: " +
      "git push in /x: ! [rejected] landrace/3 (non-fast-forward)",
    );
  });
});

/*
 * Re-review N2: a push made elsewhere — a person's, the forge's "Update
 * branch" — reached no step's worktree, since nothing here fetched; a review
 * recorded the stale head, and the merge it guards looped until stuck.
 */
describe("fetchBranch", () => {
  it("brings origin's branch into its remote-tracking ref alone, and answers its commit", async () => {
    const { root, origin } = await gitRepoWithOrigin();
    const built = await commitOn(root, "landrace/1", "a.ts");
    await pushBranch(gitIn(root), "landrace/1", "1", signal, []);
    const theirs = await pushedElsewhere(origin, "landrace/1");
    expect(await commitAt(root, "refs/remotes/origin/landrace/1")).toBe(built);
    const { git, calls } = recording(root);

    expect(await fetchBranch(git, `file://${origin}`, "landrace/1", signal, [["credential.helper", ""]])).toBe(theirs);

    expect(await commitAt(root, "refs/remotes/origin/landrace/1")).toBe(theirs);
    // The local branch is the worktree's to move forward, never the fetch's.
    expect(await commitAt(root, "refs/heads/landrace/1")).toBe(built);
    expect(await commitAt(root, "FETCH_HEAD")).toBeNull();
    const fetch = calls.find((c) => c.args[0] === "fetch");
    expect(fetch?.args).toEqual([
      "fetch", "--no-tags", "--no-write-fetch-head", `file://${origin}`, "+refs/heads/landrace/1:refs/remotes/origin/landrace/1",
    ]);
    for (const call of calls) {
      expect(configOf(call.env)).toEqual([
        ["core.hooksPath", "/dev/null"], ["fetch.recurseSubmodules", "false"], ["credential.helper", ""],
      ]);
    }
  });

  it("answers null, and fetches nothing, when origin has no such branch", async () => {
    const { root, origin } = await gitRepoWithOrigin();
    const { git, calls } = recording(root);
    expect(await fetchBranch(git, `file://${origin}`, "landrace/9", signal, [])).toBeNull();
    expect(calls.map((c) => c.args[0])).toEqual(["ls-remote"]);
    expect(await commitAt(root, "refs/remotes/origin/landrace/9")).toBeNull();
  });

  it("says which branch it could not fetch, in git's words", async () => {
    const { root } = await gitRepoWithOrigin();
    await expect(fetchBranch(gitIn(root), "file:///nowhere/at/all", "landrace/1", signal, []))
      .rejects.toThrow(/could not fetch landrace\/1 from origin: git ls-remote/);
  });
});
