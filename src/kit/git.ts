/*
 * git, as every tracker and forge integration runs it: in the operator's own
 * checkout, never the network, except for the one push that publishes a
 * branch. Published as part of `landrace/kit`.
 *
 * What stays with the integration is whatever is its forge's: which push URLs
 * it will act on, and the credential it hands git — passed in here as plain
 * git configuration — along with scrubbing that credential out of whatever git
 * says back.
 */
import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isReservedId } from "#conventions.js";
import type { BranchHeads, Git, Snapshot } from "#namespace.js";

export type { BranchHeads, Git } from "#namespace.js";

const execFileAsync = promisify(execFile);

/**
 * git in `dir`, reporting git's own words rather than a stack trace.
 *
 * The operator's environment is passed through — HOME, an ssh agent, a proxy
 * are all how their git already reaches their remote — with prompting off: a
 * push that wants a password must fail and say so, not wait on a terminal
 * nobody is watching.
 */
export function gitIn(dir: string): Git {
  return async (args, env = {}, { signal, timeoutMs } = {}) => {
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd: dir,
        env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" },
        maxBuffer: 16 * 1024 * 1024,
        ...(signal === undefined ? {} : { signal }),
        ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
      });
      return stdout;
    } catch (e) {
      const what = `git ${args[0] ?? ""} in ${dir}`;
      if (signal?.aborted) throw new Error(`${what} was aborted`);
      if ((e as { killed?: unknown }).killed === true && timeoutMs !== undefined) {
        throw new Error(`${what} did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped`);
      }
      const stderr = String((e as { stderr?: unknown }).stderr ?? "").trim();
      throw new Error(`${what}: ${stderr || (e instanceof Error ? e.message : String(e))}`);
    }
  };
}

/**
 * The repository `file` is in — a path, or a file: URL. For a hook in a
 * project's `.landrace/hooks/`, that project, whatever directory the process
 * was started from.
 *
 * The file is the caller's to find, and not by asking from in here: a frame
 * read in this module names this module's file, so an integration run against
 * a linked landrace would read landrace's repository rather than its own.
 */
export async function repositoryOf(file: string): Promise<string> {
  const here = dirname(file.startsWith("file:") ? fileURLToPath(file) : file);
  return (await gitIn(here)(["rev-parse", "--show-toplevel"])).trim();
}

/** git in the repository `root` answers, found the first time it is needed. */
export function ownGit(root: () => Promise<string>): Git {
  let found: Promise<string> | undefined;
  return async (args, env, opts) => {
    found ??= root();
    return gitIn(await found)(args, env, opts);
  };
}

/**
 * Every local branch head, and every head origin had when this checkout last
 * heard from it — out of the checkout's own refs, never the network. A
 * remote-tracking ref is exactly what a push moves, so the pass after
 * `branch.push` reads its own push back from here.
 *
 * ponytail: every branch, on every pass, into the snapshot. A repository with
 * thousands of branches pays for all of them each time; narrow this to the
 * branches the workflow's effects name if one ever does.
 */
export async function branchHeads(git: Git): Promise<BranchHeads> {
  const out = await git(["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads", "refs/remotes/origin"]);
  const local: Record<string, string> = {};
  const remote: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const [ref = "", sha = ""] = line.split("\0");
    const into = ref.startsWith("refs/heads/") ? local : ref.startsWith("refs/remotes/origin/") ? remote : null;
    const name = ref.replace(/^refs\/(heads|remotes\/origin)\//, "");
    // origin/HEAD points at a branch rather than being one, and a reserved
    // key is a prototype write rather than a name.
    if (into === null || sha === "" || name === "HEAD" || isReservedId(name)) continue;
    into[name] = sha;
  }
  return { local, remote };
}

/**
 * The branch heads the pre hook read this pass. Absent is a halt, for the
 * reason `botLoginOf` gives: "satisfied" would drop a push that never
 * happened, and "not satisfied" would push on every tick.
 */
export function headsOf(s: Snapshot): { local: Record<string, unknown>; remote: Record<string, unknown> } {
  const git = s.git as { local?: unknown; remote?: unknown } | undefined;
  const isMap = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
  if (!git || !isMap(git.local) || !isMap(git.remote)) {
    throw new Error("the snapshot does not record this checkout's branches, so no push can be checked");
  }
  return { local: git.local, remote: git.remote };
}

/** One branch's head out of a map a snapshot carried, own keys only: a branch called "constructor" is still a branch. */
export const headIn = (heads: Record<string, unknown>, branch: string): string | undefined =>
  Object.hasOwn(heads, branch) && typeof heads[branch] === "string" ? heads[branch] : undefined;

/** How long one push may take before it is stopped: it holds the item's lock while it runs. */
export const PUSH_TIMEOUT_MS = 5 * 60_000;

/**
 * What a publishing effect says when there is nothing on the branch to
 * publish. The push checks for it and a forge answers it to `pull.open`, so
 * both say it in one sentence: a halt that clears itself once somebody
 * commits, because the next tick asks again.
 */
export const nothingCommitted = (branch: string, item: string): Error =>
  new Error(
    `nothing was committed on ${branch} for #${item}: it is already part of origin's default branch, so ` +
    "there is nothing to push or propose. Commit to the branch and the next tick carries on",
  );

/**
 * origin's one push URL, for the integration to check before anything is
 * pushed to it.
 *
 * Exactly one. `git push origin` pushes to every push URL origin has, and a
 * step that may write shares this repository's config, so one more pushurl is
 * one line away. An origin with anything but one push URL — `git remote
 * get-url --push --all`, after every rewrite a config could apply — is
 * refused before anything else is built.
 */
export async function originPushUrl(git: Git, branch: string, signal: AbortSignal): Promise<string> {
  const urls = (await git(["remote", "get-url", "--push", "--all", "origin"], {}, { signal }))
    .split("\n").map((u) => u.trim()).filter(Boolean);
  const [url] = urls;
  if (urls.length !== 1 || url === undefined) {
    throw new Error(
      `refusing to push ${branch}: origin has ${urls.length} push URLs, and landrace pushes an item's branch ` +
      "to exactly one destination — the one it can check. Leave origin a single push URL " +
      "(git remote set-url --push origin <url>) and the item carries on",
    );
  }
  return url;
}

/**
 * Publish one branch to origin, fast-forward only, with `config` — the
 * integration's credential, if it hands one — added to git's own.
 *
 * `GIT_CONFIG_*` is git's own way to take configuration from the environment,
 * appended after any the operator already set, so nothing rides on git's
 * command line: argv is readable by every process on the machine.
 *
 * Hooks are off for every push. A step that may write can point
 * core.hooksPath at a script of its own, and a pre-push or
 * reference-transaction hook runs inside this very environment. The push is
 * the one branch and nothing more: an explicit refspec makes git ignore
 * `remote.origin.push`, a mirror remote refuses one outright, and following
 * tags or pushing submodules is switched off here rather than left to config.
 *
 * What git says back is in the error as git said it: a caller that handed a
 * credential scrubs it out before the error goes anywhere.
 *
 * Never forced: a branch origin has moved on is somebody else's work, and
 * the way through it is a person's.
 */
export async function pushBranch(
  git: Git,
  branch: string,
  item: string,
  signal: AbortSignal,
  config: Array<[string, string]>,
): Promise<void> {
  // Nothing to publish either when origin already has everything the
  // branch has: a person's push, or the forge's "Update branch", moved it on
  // and a fetch brought the news. A fast-forward-only push of it would be
  // refused, on every tick, over commits that are already there.
  const theirs = `refs/remotes/origin/${branch}`;
  if ((await git(["for-each-ref", "--format=%(objectname)", theirs], {}, { signal })).trim() !== "") {
    const contained = await git(["merge-base", "--is-ancestor", `refs/heads/${branch}`, theirs], {}, { signal })
      .then(() => true, () => false);
    if (contained) return;
  }

  // Nothing to publish: the branch is origin's default branch, or behind
  // it. Asked of refs this checkout already has — origin/HEAD, as the clone
  // or `git remote set-head` left it — and skipped when it has none; the
  // forge's own answer to `pull.open` says the same thing then.
  const base = (await git(["for-each-ref", "--format=%(objectname)", "refs/remotes/origin/HEAD"], {}, { signal })).trim();
  if (base !== "") {
    const ahead = (await git(["rev-list", "--count", `${base}..refs/heads/${branch}`], {}, { signal })).trim();
    if (ahead === "0") throw nothingCommitted(branch, item);
  }

  const all: Array<[string, string]> = [
    ["core.hooksPath", "/dev/null"], ["push.followTags", "false"], ["push.recurseSubmodules", "no"], ...config,
  ];
  const at = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? "", 10) || 0;
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(at + all.length) };
  for (const [i, [key, value]] of all.entries()) {
    env[`GIT_CONFIG_KEY_${at + i}`] = key;
    env[`GIT_CONFIG_VALUE_${at + i}`] = value;
  }

  try {
    await git(["push", "origin", `refs/heads/${branch}:refs/heads/${branch}`], env, { signal, timeoutMs: PUSH_TIMEOUT_MS });
  } catch (e) {
    const said = e instanceof Error ? e.message : String(e);
    const behind = /non-fast-forward|fetch first/i.test(said)
      ? ` — origin's ${branch} has commits this checkout does not, and landrace does not force-push; ` +
        "bring the branch up to date by hand and the item carries on"
      : "";
    throw new Error(`could not push ${branch} to origin${behind}: ${said}`);
  }
}
