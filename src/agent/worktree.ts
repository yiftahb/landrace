import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import { GIT_GUARD_ARGS, INHERITED_ENV_KEYS } from "#conventions.js";
import type { ControlPaths, GitDirs, RemoteGuard, WorktreeBranch, WorktreePreparation, WorktreeSetup, WorktreeState } from "#namespace.js";
import { CommonDirRefused, commonDirIntact } from "#kit/git.js";
import { commonDirOf as sandboxCommonDir, sandboxRoot } from "#sandbox.js";
import { containedPath } from "#workflow/load.js";
import { messageOf } from "#runner/errors.js";

const exec = promisify(execFile);

/**
 * The slot a write step's worktree is kept in between steps, until the item
 * ends: beside the item's own, which every converge and conversation cuts and
 * removes, so an install in it outlives the run that made it.
 */
export const keptSlot = (item: string): string => `${item}.write`;

/** The items that have a kept write worktree under this repository's sandbox, by its slot's folder. */
export async function keptItems(repoRoot: string, scope?: string): Promise<string[]> {
  const root = await rootFor(repoRoot);
  const names = await readdir(scope === undefined ? root : join(root, scopeDir(scope)));
  return names.filter((n) => n.endsWith(".write")).map((n) => n.slice(0, -".write".length));
}

/** The files whose change means what `setup` installs has changed, unless `agent.worktree.lockfiles` names others: the lockfiles at the repository root. */
export const DEFAULT_LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"];

/**
 * How long one call to origin may take before it is stopped — the forge's
 * limit on its own fetch of the same origin: it holds the item's lock and a
 * `tick.concurrency` slot while it runs.
 */
const FETCH_TIMEOUT_MS = 5 * 60_000;

/** How much of a failed setup command's output its reason carries. */
const SETUP_TAIL = 2000;

/**
 * `$TMPDIR/landrace/<repo>/worktrees/`, beside that repository's locks.
 *
 * `<repo>` is the resolved common git directory, digested — not
 * `basename(repoRoot)`, which is what this was and which is a name, not an
 * identity: two checkouts called `widgets` resolved to one sandbox, and the
 * second one to start found a directory registered to no worktree it could
 * see and cleared it. That was the other repository's live sandbox, deleted
 * out from under a running agent. Same defect as the lock root, same
 * identity, same helper.
 *
 * Created here rather than left to `git worktree add`, and then resolved:
 * every path below is compared against this one, so a component of it
 * replaced by a link has to be caught here, where the comparison is still
 * possible. Otherwise the whole sandbox — and with it the `rm -rf` below —
 * quietly relocates to wherever the link points, and each path under it still
 * looks perfectly contained.
 */
async function rootFor(repoRoot: string): Promise<string> {
  const root = join(sandboxRoot(repoRoot), "worktrees");
  await mkdir(root, { recursive: true });
  const real = await realpath(root);
  if (real !== root) {
    throw new Error(`refusing to use ${root} as a sandbox root: it resolves to ${real}, outside the sandbox`);
  }
  return root;
}

/**
 * Where #item's sandbox goes — proven to be inside this repository's own
 * sandbox root before anything is created there and, more to the point,
 * before anything is deleted there.
 *
 * `rm -rf` on a path assembled from outside input is the highest-consequence
 * operation in this codebase, and an item is a validated string to the
 * typechecker and a value out of a tracker hook at runtime, which are not the
 * same claim. `containedPath` is the existing answer to exactly this shape:
 * it rejects a segment that climbs out before resolving anything, and
 * compares both ends after fs.realpath, so a path that exists but leads
 * somewhere else is refused rather than followed.
 */
export async function pathFor(item: string, repoRoot: string, scope?: string): Promise<string> {
  const root = await rootFor(repoRoot);
  const relative = scope === undefined ? item : join(scopeDir(scope), item);
  const where = await containedPath(root, relative);
  if (where.ok) return where.path;
  // Not there yet, which is the ordinary case — and the shape check and the
  // containment check both ran before the lookup that said so.
  if (where.kind === "missing") return join(root, relative);
  throw new Error(`refusing to touch a sandbox for #${item} under ${root}: that path ${where.reason}`);
}

/**
 * A person's folder under the sandbox root: their id as `Sandbox.scope`
 * holds it, encoded, which no separator survives. Refused when it would name
 * the root itself, or its parent — `.` and `..` encode as themselves — or
 * an item's own folder: a kept slot ends `.write`, and a sweep reading the
 * root would take the folder for one.
 */
function scopeDir(scope: string): string {
  if (scope === "" || scope === "." || scope === ".." || scope.includes("/") || scope.includes("\\") || scope.endsWith(".write")) {
    throw new Error(`refusing "${scope}" as a person's sandbox folder: it is not an encoded person id`);
  }
  return scope;
}

/**
 * git's own message, not a stack trace: an operator can act on "not a git
 * repository". Hooks and fsmonitor off (GIT_GUARD_ARGS); `dirs`, for a
 * command in a step's worktree, pins where git looks.
 */
async function git(args: string[], cwd: string, what: string, dirs?: GitDirs): Promise<string> {
  try {
    const { stdout } = await exec("git", [...GIT_GUARD_ARGS, ...args], { cwd, env: { ...process.env, ...(dirs ?? pinned(cwd)) } });
    return stdout;
  } catch (e) {
    const stderr = String((e as { stderr?: unknown }).stderr ?? "").trim();
    throw new Error(`${what}: ${stderr || messageOf(e)}`);
  }
}

/**
 * The common directory every git the engine runs in `cwd` is pinned to, as
 * the sandbox found it the first time (`commonDirOf` in `#sandbox.js`): a
 * `commondir` a step planted in it since hands git no config of its own, and
 * is refused while it is there, since git still reads branches through it
 * (`commonDirIntact`). Nothing outside a repository, where git says so in its
 * own words. In a worktree, `gitDirsOf` pins its admin folder instead, whose
 * own `commondir` is the one git's branches follow there.
 */
function pinned(cwd: string): { GIT_COMMON_DIR?: string } {
  try {
    const common = sandboxCommonDir(cwd);
    commonDirIntact(common);
    return { GIT_COMMON_DIR: common };
  } catch (e) {
    if (e instanceof CommonDirRefused) throw e;
    return {};
  }
}

/** git's environment for a command in `cwd` that `git` does not run: the operator's, pinned. */
const envAt = (cwd: string): NodeJS.ProcessEnv => ({ ...process.env, ...pinned(cwd) });

/** The repository's common git directory, resolved, as the operator's checkout at `repoRoot` answers it (`gitCommonDir`). */
function commonDirOf(repoRoot: string, what: string): string {
  try {
    return sandboxCommonDir(repoRoot);
  } catch (e) {
    throw new Error(`${what}: ${messageOf(e)}`);
  }
}

/**
 * The admin folder under `<common>/worktrees` whose `gitdir` names
 * `<path>/.git`: the engine finds it, never the worktree's own `.git` file,
 * which a step that may write can point anywhere.
 *
 * Exactly one, or a halt naming what was found: none, and the worktree is not
 * this repository's; two, and a step made a second — which one git would use
 * is what the step chose. And none holding `config.worktree`: landrace never
 * makes one, and with `extensions.worktreeConfig` on, a folder a step renamed
 * in could set a filter there that runs on the engine's next checkout.
 */
async function adminDirOf(path: string, common: string, what: string): Promise<string> {
  const under = join(common, "worktrees");
  const names = await readdir(under).catch((e: unknown) => {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
    throw new Error(`${what}: ${messageOf(e)}`);
  });
  const want = join(path, ".git");
  const naming: string[] = [];
  for (const name of names) {
    const folder = join(under, name);
    const gitdir = await readFile(join(folder, "gitdir"), "utf8").catch(() => null);
    // Relative to the admin folder when git writes relative paths (worktree.useRelativePaths).
    if (gitdir !== null && resolve(folder, gitdir.trim()) === want) naming.push(folder);
  }
  const [admin] = naming;
  if (naming.length !== 1 || admin === undefined) {
    throw new Error(
      `${what}: refusing to run git in ${path}: ${naming.length === 0
        ? `no admin folder under ${under} names it`
        : `${naming.length} admin folders name it, ${naming.join(", ")}, and git would use whichever its .git file points at`}`,
    );
  }
  const own = join(admin, "config.worktree");
  let holds: boolean;
  try {
    holds = await holdsSomething(own);
  } catch (e) {
    throw new Error(`${what}: refusing to run git in ${path}: ${own} could not be read: ${messageOf(e)}`);
  }
  if (holds) {
    throw new Error(
      `${what}: refusing to run git in ${path}: ${own} holds something, and landrace never makes one; ` +
      "a step that may write could have put it there to configure git. Remove it and the item carries on",
    );
  }
  return admin;
}

/**
 * Whether `path` holds anything git could act on: a regular file with more
 * than whitespace in it, a folder with anything in it, or anything else — a
 * link, a socket, a FIFO. Missing, empty and whitespace-only set nothing: the
 * last two are what a Linux sandbox leaves where it was told to deny a path.
 * A path that cannot be read throws.
 *
 * A regular file with a second name holds something whatever it says now: a
 * sandbox denies by path, so a step fills it through the other name once it
 * has passed. One over `MOST_READ` bytes holds something unread, so a file of
 * gigabytes cannot exhaust the engine before the refusal is recorded. And it
 * is opened without following a link or waiting on a FIFO, then judged by
 * what was opened, since something could swap it after the `lstat`.
 */
const MISSING = new Set(["ENOENT", "ENOTDIR"]);
const MOST_READ = 4096;

async function holdsSomething(path: string): Promise<boolean> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (e) {
    // Under a name that is a file, nothing is there.
    if (MISSING.has((e as NodeJS.ErrnoException).code ?? "")) return false;
    throw e;
  }
  if (stat.isDirectory()) return (await readdir(path)).length > 0;
  if (!stat.isFile() || stat.nlink > 1 || stat.size > MOST_READ) return true;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "";
    if (MISSING.has(code)) return false;
    // Swapped for a link since the lstat.
    if (code === "ELOOP") return true;
    throw e;
  }
  try {
    const now = await handle.stat();
    if (!now.isFile() || now.nlink > 1 || now.size > MOST_READ) return true;
    const buffer = Buffer.alloc(MOST_READ + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead > MOST_READ || buffer.subarray(0, bytesRead).toString("utf8").trim() !== "";
  } finally {
    await handle.close();
  }
}

/** Whether anything is at `path`, whatever it holds; one that cannot be looked at throws. */
async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, (e: unknown) => {
    if (MISSING.has((e as NodeJS.ErrnoException).code ?? "")) return false;
    throw e;
  });
}

/**
 * Where the engine's git finds a step's worktree: its admin folder by lookup,
 * the common directory as the operator's checkout answers it — never the
 * admin folder's `commondir` — and the worktree itself.
 */
export async function gitDirsOf(path: string, repoRoot: string): Promise<GitDirs> {
  const what = `could not find the git directories of ${path}`;
  const common = commonDirOf(repoRoot, what);
  return { GIT_DIR: await adminDirOf(path, common, what), GIT_COMMON_DIR: common, GIT_WORK_TREE: path };
}

/**
 * That a worktree reads as git made it, before it is handed to a person or
 * an agent is run in it, or setup runs there: its `.git` file points at the
 * admin folder found by lookup, which has a `commondir`
 * naming this repository's common directory, and no `config`, `hooks` or
 * `info` of its own. A checkout whose `.git` is a directory has no admin
 * folder, and passes.
 *
 * The engine's own git never reads `commondir` (`gitDirsOf`). But a write
 * step's sandbox reaches every admin folder, and one git made while the step
 * ran — another item's worktree, a turn's, a pairing's — was on no list it
 * was handed. The person pairing there runs git of their own, and so does an
 * agent run there: both follow `commondir` to whatever the step built, and
 * run its hooks or fsmonitor. Asked again at each hand-out, never once: a
 * step still running can write after it, which `docs/security.md` states.
 */
export async function worktreeIntact(path: string, repoRoot: string): Promise<void> {
  const dotGit = join(path, ".git");
  if (await lstat(dotGit).then((s) => s.isDirectory(), () => false)) return;
  const what = `refusing to hand out or run in ${path}`;
  const common = commonDirOf(repoRoot, what);
  const admin = await adminDirOf(path, common, what);
  // The .git file is what a person's or a setup command's git reads first: pointed anywhere
  // else, it hands that git a directory of the step's, whatever the admin folder holds.
  const pointer = (await readFile(dotGit, "utf8").catch((e: unknown) => {
    throw new Error(`${what}: ${messageOf(e)}`);
  })).match(/^gitdir: (.+?)\s*$/m)?.[1];
  const pointed = pointer === undefined ? null : await realpath(resolve(path, pointer)).catch(() => resolve(path, pointer));
  if (pointed !== await realpath(admin)) {
    throw new Error(
      `${what}: ${dotGit} points at ${pointed ?? "no gitdir"}, not ${admin}, the admin folder that names it; ` +
      "a step that may write could have pointed it at a git directory of its own",
    );
  }
  const file = join(admin, "commondir");
  const named = await readFile(file, "utf8").catch((e: unknown) => {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`${what}: ${messageOf(e)}`);
  });
  if (named === null) {
    throw new Error(`${what}: ${file} is missing, so git there would read ${admin} as a repository of its own`);
  }
  const target = resolve(admin, named.trim());
  const resolved = await realpath(target).catch(() => null);
  if (resolved !== common) {
    throw new Error(
      `${what}: ${file} names ${resolved ?? `${target}, which does not exist`}, not ${common}; ` +
      "a step that may write could have pointed it at a git directory of its own",
    );
  }
  for (const own of ["config", "hooks", "info"]) {
    const at = join(admin, own);
    if (await lstat(at).then(() => true, () => false)) {
      throw new Error(`${what}: ${at} exists, and git never makes one in an admin folder; a step that may write could have put it there`);
    }
  }
}

// `commondir` in the common directory too: git reads it in any git directory,
// the main one included, so written there it would hand every git in the
// checkout — the operator's, and the engine's fetch, push and `worktree add`,
// whose `rev-parse --git-common-dir` follows it — a config of the step's.
const COMMON_CONTROL_FILES = ["config", "config.worktree", "commondir", "hooks", "info"];
const ADMIN_CONTROL_FILES = ["config", "config.worktree", "commondir", "gitdir", "hooks", "info"];

/**
 * What a write step's agent may not write, so neither the engine's git nor
 * the operator's runs code it planted: the repository's `config`,
 * `config.worktree`, `commondir`, `hooks` and `info`, the same five in each
 * admin folder with its `gitdir`, and `<path>/.git` when it is a file. An
 * admin folder's own `config` and `hooks` are never git's, but a step that
 * renamed one away and made it again without `commondir` would have git — the
 * operator's, in a checkout that is a linked worktree — read them as a
 * repository's. Everything else under the git directory — objects, refs, the
 * index, `HEAD` — stays writable: a step commits, fetches and merges.
 *
 * `deny` is what the executor is handed. On macOS, every one, those not there
 * yet too: made by the step, one would be read. On Linux, only those that
 * exist: bwrap makes each missing path it is told to deny, and an empty
 * `<common>/commondir` it left stopped every git in the checkout. `absent` is
 * every one missing now, on each platform, for `plantedControlPaths` to judge
 * once the run ends.
 *
 * And on Linux, none at all while `extensions.worktreeConfig` is on: git then
 * reads every admin folder's `config.worktree`, those made while the step runs
 * too, and the sandbox cannot keep the step from making one. Read with the
 * repository's includes followed, which can only refuse more, and as git reads
 * a boolean; a config that cannot be read refuses too. Nor, on any
 * platform, while a control file has a second name, which a deny by path
 * leaves writable.
 *
 * And on Linux, nothing that a lost refusal record would hide. A path listed
 * absent is judged only after the run, so a record that failed to be written
 * left it there, denied and never judged again. So what can be is judged from
 * the repository itself, before every run: `<common>/hooks` and `info` are
 * made empty when missing, so they are denied and never absent (`git init`
 * makes both, and empty they change nothing); `<common>/config`, which `git
 * init` always makes, must be there; `<common>/config.worktree` must hold
 * nothing, since git reads none with the extension off; and every admin
 * folder must read as git made it (`adminFolderProblems`), which is judged
 * again after the run through `commons`. `<common>/commondir` is refused
 * wherever the engine's git runs (`commonDirIntact`).
 */
export async function gitControlPaths(path: string, repoRoot: string, platform: NodeJS.Platform = process.platform): Promise<ControlPaths> {
  const what = `could not list the git paths a write step may not write in ${path}`;
  const common = commonDirOf(repoRoot, what);
  const linux = platform === "linux";
  if (linux) {
    const config = join(common, "config");
    if (!(await exists(config).catch((e: unknown) => {
      throw new Error(`${what}: ${messageOf(e)}`);
    }))) {
      throw new Error(
        `${what}: ${config} is missing, and git init always makes one; a step that may write could have moved it away. ` +
        "Put the repository's config back and the item carries on",
      );
    }
    await worktreeConfigOff(common, repoRoot, what);
    for (const folder of ["hooks", "info"]) {
      await mkdir(join(common, folder)).catch((e: unknown) => {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw new Error(`${what}: ${messageOf(e)}`);
      });
    }
  }
  const under = join(common, "worktrees");
  const names = await readdir(under).catch((e: unknown) => {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
    throw new Error(`${what}: ${messageOf(e)}`);
  });
  const dotGit = join(path, ".git");
  const isFile = await lstat(dotGit).then((s) => !s.isDirectory(), () => false);
  const all = [
    ...COMMON_CONTROL_FILES.map((f) => join(common, f)),
    ...names.sort().flatMap((n) => ADMIN_CONTROL_FILES.map((f) => join(under, n, f))),
    ...(isFile ? [dotGit] : []),
  ];
  const absent: string[] = [];
  const linked: string[] = [];
  for (const at of all) {
    const stat = await lstat(at).catch((e: unknown) => {
      if (MISSING.has((e as NodeJS.ErrnoException).code ?? "")) return null;
      throw new Error(`${what}: ${messageOf(e)}`);
    });
    if (stat === null) absent.push(at);
    else if (stat.isFile() && stat.nlink > 1) linked.push(at);
  }
  // On every platform: each sandbox denies by path, and a file with a second
  // name is written through that one. Git never links a control file.
  if (linked.length > 0) {
    throw new Error(
      `${what}: ${linked.join(", ")} ${linked.length === 1 ? "has" : "have"} more than one link, so a sandbox that denies ` +
      "the path cannot keep a step from writing it through another name, and a step that may write could have linked it. " +
      "Replace it with a copy of its own, or remove it, and the item carries on",
    );
  }
  if (linux) {
    const own = join(common, "config.worktree");
    let holds: boolean;
    try {
      holds = await holdsSomething(own);
    } catch (e) {
      throw new Error(`${what}: ${own} could not be read: ${messageOf(e)}`);
    }
    const problems = [
      ...(holds ? [`${own} holds something, and with extensions.worktreeConfig off git has no reason to make one`] : []),
      ...(await adminFolderProblems(common).catch((e: unknown) => {
        throw new Error(`${what}: ${messageOf(e)}`);
      })),
    ];
    if (problems.length > 0) throw new Error(`${what}: ${problems.join("; ")}: ${PLANTED_FIX}`);
  }
  // An admin folder with no `gitdir` or `commondir` yet is another item's
  // `git worktree add` under way, which writes both after making the folder:
  // judged after the run, they read as planted and halted an item that did
  // nothing. Its control files are judged before each use instead
  // (`adminDirOf`, `worktreeIntact`), as those of a folder made while the
  // step ran are. So no admin `commondir` is ever absent, and only
  // `<common>/commondir` is judged by existence (`plantedControlPaths`).
  const making = names
    .map((n) => join(under, n))
    .filter((folder) => absent.includes(join(folder, "gitdir")) || absent.includes(join(folder, "commondir")));
  return {
    deny: linux ? all.filter((at) => !absent.includes(at)) : all,
    absent: absent.filter((at) => !making.includes(dirname(at))),
    commons: linux ? [common] : [],
  };
}

/** What every refusal of a planted control path ends with. */
const PLANTED_FIX = "a step that may write could have put it there. Remove it and the item carries on";

/**
 * Each admin folder under `<common>/worktrees` that does not read as git made
 * it, as a sentence naming the path: a `commondir`, where there is one, that
 * resolves anywhere but `common`; a `config`, `hooks` or `info`, which git
 * never makes in one; a `config.worktree` holding something
 * (`holdsSomething`). Judged by content, never against a list taken before:
 * git decides what an admin folder holds, so one a step renamed away and made
 * again is caught however many refusal records were lost — the operator's own
 * linked worktree's too. A folder with no `commondir` yet is another item's
 * `git worktree add` under way, and passes; one git would then read as a
 * repository is refused for its `config` or `hooks`. A folder that cannot be
 * read is a problem too; `<common>/worktrees` that cannot, a throw.
 */
export async function adminFolderProblems(common: string): Promise<string[]> {
  const under = join(common, "worktrees");
  const names = await readdir(under).catch((e: unknown) => {
    if (MISSING.has((e as NodeJS.ErrnoException).code ?? "")) return [] as string[];
    throw e;
  });
  const problems: string[] = [];
  for (const name of names.sort()) {
    const folder = join(under, name);
    try {
      const file = join(folder, "commondir");
      const named = await smallFile(file);
      if (named !== null) {
        const target = resolve(folder, named.trim());
        const resolved = await realpath(target).catch(() => null);
        if (resolved !== common) problems.push(`${file} names ${resolved ?? `${target}, which does not exist`}, not ${common}`);
      }
      for (const own of ["config", "hooks", "info"]) {
        if (await exists(join(folder, own))) problems.push(`${join(folder, own)} exists, and git never makes one in an admin folder`);
      }
      const worktreeConfig = join(folder, "config.worktree");
      if (await holdsSomething(worktreeConfig)) problems.push(`${worktreeConfig} holds something, and landrace never makes one`);
    } catch (e) {
      problems.push(`${folder} could not be read: ${messageOf(e)}`);
    }
  }
  return problems;
}

/**
 * A regular file's text, or null when nothing is there. Opened without
 * following a link or waiting on a FIFO, as `holdsSomething` opens one, and
 * refused when it is anything else or over `MOST_READ` bytes: git writes an
 * admin folder's `commondir` as a short file, and a step's FIFO there would
 * otherwise hang the engine before the refusal is said.
 */
async function smallFile(path: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "";
    if (MISSING.has(code)) return null;
    if (code === "ELOOP") throw new Error(`${path} is a link, and git writes a file there`);
    throw e;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${path} is not a file, and git writes a file there`);
    if (stat.size > MOST_READ) throw new Error(`${path} is over ${MOST_READ} bytes, and git writes a short file there`);
    const buffer = Buffer.alloc(MOST_READ + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MOST_READ) throw new Error(`${path} is over ${MOST_READ} bytes, and git writes a short file there`);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Why a write run with no worktree (`agent.isolation: none`) is refused on
 * `platform`, or null where it runs. On Linux the sandbox denies the
 * checkout's control paths by binding each one read-only, and a step could
 * rename the checkout's `.git` away and make it again: the binds move with
 * the old one, and the engine's git reads what the step made. Comparing the
 * folder's identity before and after would keep that in one run's memory, so
 * a lost record would trust the remade one; this comes from the configuration,
 * and cannot be lost. Refused where the configuration is read, by `landrace
 * start` and `landrace mcp`, never by a run (`checkoutControlPaths`).
 */
export function noneWriteRefusal(platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== "linux") return null;
  return "on Linux, a step that may write does not run with agent.isolation: none: its sandbox denies the checkout's git " +
    "control paths by path, and a step could rename the checkout's .git away and make it again, which those denials do not " +
    "follow. Set agent.isolation: worktree, and each such step runs in a worktree of its own";
}

/** That `extensions.worktreeConfig` is not on in the repository at `common`, as git reads it there; why not, thrown. */
async function worktreeConfigOff(common: string, repoRoot: string, what: string): Promise<void> {
  const config = join(common, "config");
  const fix = "turn it off with `git config extensions.worktreeConfig false` and the item carries on";
  let value: string;
  try {
    const { stdout } = await exec(
      "git", [...GIT_GUARD_ARGS, "config", "--file", config, "--includes", "--type=bool", "extensions.worktreeConfig"],
      { cwd: repoRoot, env: envAt(repoRoot) },
    );
    value = stdout.trim();
  } catch (e) {
    const stderr = String((e as { stderr?: unknown }).stderr ?? "").trim();
    // Exit 1 and nothing said is a key that is not set.
    if ((e as { code?: unknown }).code === 1 && stderr === "") return;
    throw new Error(
      `${what}: extensions.worktreeConfig could not be read from ${config}, and on Linux a write step runs only with it off: ` +
      `${stderr || messageOf(e)}; ${fix}`,
    );
  }
  if (value === "true") {
    throw new Error(
      `${what}: extensions.worktreeConfig is on in ${config}, so git reads every worktree's config.worktree, and on Linux ` +
      `a write step's sandbox cannot keep it from making one; ${fix}`,
    );
  }
}

/**
 * For a write run with no worktree (`agent.isolation: none`): the control
 * paths of each checkout it reaches — where it runs, and the workspace's —
 * each once. A directory in no repository has none.
 *
 * Never refused here on Linux, though such a run is (`noneWriteRefusal`): a
 * run with no worktree is also the in-memory harness's, which enters none and
 * runs no agent, and refused here it failed every harness write step on Linux,
 * a third party's too. The refusal is made where the configuration is read —
 * `landrace start` and `landrace mcp` — which can tell the two apart.
 */
export async function checkoutControlPaths(dirs: readonly string[], platform: NodeJS.Platform = process.platform): Promise<ControlPaths> {
  const deny: string[] = [];
  const absent: string[] = [];
  const commons: string[] = [];
  for (const dir of dirs) {
    let top: string;
    try {
      top = await repositoryRoot(dir);
    } catch (e) {
      if (/not a git repository/i.test(messageOf(e))) continue;
      throw e;
    }
    const paths = await gitControlPaths(top, top, platform);
    deny.push(...paths.deny);
    absent.push(...paths.absent);
    commons.push(...paths.commons);
  }
  return { deny: [...new Set(deny)], absent: [...new Set(absent)], commons: [...new Set(commons)] };
}

/**
 * Why a write run is refused for what it left among the control paths that
 * were missing as it started, or null when it left nothing: each that holds
 * something now (`holdsSomething`), and each that cannot be read. Asked on
 * every way a run ends — an answer, a throw, its limit, an abort — and before
 * the engine's git runs there: a step on Linux may make one, which its
 * sandbox denies only once it exists. And every admin folder in `commons`
 * that does not read as git made it (`adminFolderProblems`): on Linux a step
 * can rename one away and make it again, which no list taken before the run
 * would catch.
 */
export async function plantedControlPaths({ absent, commons }: ControlPaths): Promise<string | null> {
  const planted: string[] = [];
  const unreadable: string[] = [];
  for (const path of absent) {
    try {
      // A `commondir` is judged by being there at all, not by what it holds:
      // every engine git refuses one in the common directory that exists
      // (`commonDirIntact`), so one left empty would pass here and stop the
      // next snapshot instead, with the run unrecorded and paid for again.
      // Only the common directory's is ever absent: an admin folder missing
      // its own is left out (`gitControlPaths`).
      if (basename(path) === "commondir" ? await exists(path) : await holdsSomething(path)) planted.push(path);
    } catch (e) {
      unreadable.push(`${path} (${messageOf(e)})`);
    }
  }
  const admins: string[] = [];
  for (const common of commons) {
    try {
      admins.push(...await adminFolderProblems(common));
    } catch (e) {
      admins.push(`the admin folders under ${join(common, "worktrees")} could not be read after the run: ${messageOf(e)}`);
    }
  }
  // An admin folder's path already named as planted is said once.
  const named = [...planted, ...unreadable.map((u) => u.slice(0, u.indexOf(" (")))];
  const reasons = [
    ...(planted.length === 0 ? [] : [
      `${planted.join(", ")} ${planted.length === 1 ? "was" : "were"} not there before the run and now ` +
      `${planted.length === 1 ? "holds" : "hold"} something`,
    ]),
    ...(unreadable.length === 0 ? [] : [
      `${unreadable.join(", ")} ${unreadable.length === 1 ? "was" : "were"} not there before the run and could not be read after it`,
    ]),
    ...admins.filter((problem) => !named.some((at) => problem.startsWith(`${at} `))),
  ];
  if (reasons.length === 0) return null;
  return `${reasons.join("; ")}: a step that may write could have put it there to configure git. Remove it and the item carries on`;
}

/**
 * `git` for a call that reaches origin, with the forge's guards on its own
 * fetch of the same origin: prompting off, so one that wants a password fails
 * and says so rather than waiting on a terminal nobody is watching, and
 * stopped at the run's abort or its own limit — it holds the item's lock and
 * a `tick.concurrency` slot while it runs, and a converge stuck on it would
 * hold both for good.
 */
async function gitRemote(args: string[], cwd: string, what: string, guard: RemoteGuard): Promise<string> {
  try {
    const { stdout } = await exec("git", [...GIT_GUARD_ARGS, ...args], {
      cwd,
      env: { ...envAt(cwd), GIT_TERMINAL_PROMPT: "0" },
      timeout: guard.timeoutMs,
      ...(guard.signal === undefined ? {} : { signal: guard.signal }),
    });
    return stdout;
  } catch (e) {
    // The subcommand, past any `-c key=value` before it.
    const command = args.find((arg, i) => !arg.startsWith("-") && args[i - 1] !== "-c") ?? "";
    if (guard.signal?.aborted) throw new Error(`${what}: git ${command} was aborted`);
    if ((e as { killed?: unknown }).killed === true) {
      throw new Error(`${what}: git ${command} did not finish within ${Math.round(guard.timeoutMs / 1000)}s and was stopped`);
    }
    const stderr = String((e as { stderr?: unknown }).stderr ?? "").trim();
    throw new Error(`${what}: ${stderr || messageOf(e)}`);
  }
}

/**
 * The repository a workflow directory belongs to.
 *
 * Asked once at startup rather than at the first invoke: a loop started
 * outside a repository would otherwise assemble happily, poll happily, and
 * fail at its first paid step — hours in, on an item it has already moved.
 */
export async function repositoryRoot(dir: string): Promise<string> {
  const out = await git(
    ["rev-parse", "--show-toplevel"],
    dir,
    `${dir} is not inside a git repository, so there is nothing to isolate a step against`,
  );
  return out.trim();
}

/** The commit `ref` names, or null when there is no such ref. */
async function commitOf(ref: string, cwd: string, what: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", [...GIT_GUARD_ARGS, "rev-parse", "--verify", "-q", `${ref}^{commit}`], { cwd, env: envAt(cwd) });
    return stdout.trim();
  } catch (e) {
    // `-q` makes a ref that is not there exit 1 and say nothing. Anything
    // else — not a repository, a corrupt ref — is a failure, not an absence.
    const stderr = String((e as { stderr?: unknown }).stderr ?? "").trim();
    if ((e as { code?: unknown }).code === 1 && stderr === "") return null;
    throw new Error(`${what}: ${stderr || messageOf(e)}`);
  }
}

/**
 * The branch moved forward to what the checkout knows of origin's, when
 * origin's has everything the local one has and more — a person's push, the
 * forge's "Update branch", once a fetch brought it here — and the commit the
 * step should start from either way.
 *
 * Never backwards, never across a fork: a local commit origin does not have
 * is a step's own, not yet pushed, and is kept. And never a branch another
 * checkout has out — the operator's own, say — whose files would no longer
 * match it. The update names the commit it moves from, so a branch that
 * moved meanwhile is left as it is.
 */
async function caughtUp(branch: string, local: string, repoRoot: string, what: string): Promise<string> {
  const theirs = await commitOf(`refs/remotes/origin/${branch}`, repoRoot, what);
  if (theirs === null || theirs === local) return local;
  const behind = await exec("git", [...GIT_GUARD_ARGS, "merge-base", "--is-ancestor", local, theirs], { cwd: repoRoot, env: envAt(repoRoot) }).then(
    () => true,
    (e: unknown) => {
      // Exit 1 is "not an ancestor"; anything else is a failure, not an answer.
      if ((e as { code?: unknown }).code === 1) return false;
      throw new Error(`${what}: ${String((e as { stderr?: unknown }).stderr ?? "").trim() || messageOf(e)}`);
    },
  );
  if (!behind) return local;
  await git(["update-ref", `refs/heads/${branch}`, theirs, local], repoRoot, what);
  return theirs;
}

/**
 * Origin's default branch, as `refs/remotes/origin/HEAD` names it, asked of
 * origin once when nothing has set it yet — a clone sets it, a `remote add`
 * and a push do not.
 */
async function defaultBranch(repoRoot: string, what: string, guard: RemoteGuard): Promise<string> {
  const named = async (): Promise<string | null> => {
    const ref = await exec("git", [...GIT_GUARD_ARGS, "symbolic-ref", "-q", "refs/remotes/origin/HEAD"], { cwd: repoRoot, env: envAt(repoRoot) }).then(
      ({ stdout }) => stdout.trim(),
      (e: unknown) => {
        // `-q` makes an unset ref exit 1 and say nothing; anything else is a failure, not an absence.
        const stderr = String((e as { stderr?: unknown }).stderr ?? "").trim();
        if ((e as { code?: unknown }).code === 1 && stderr === "") return null;
        throw new Error(`${what}: ${stderr || messageOf(e)}`);
      },
    );
    return ref?.startsWith("refs/remotes/origin/") ? ref.slice("refs/remotes/origin/".length) : null;
  };
  const known = await named();
  if (known !== null) return known;
  const fix = "run `git remote set-head origin --auto` in the repository, or `git remote set-head origin <branch>` to name it";
  await gitRemote(["remote", "set-head", "origin", "--auto"], repoRoot, `${what}: origin's default branch is unknown, and asking origin failed; ${fix}`, guard);
  const asked = await named();
  if (asked === null) throw new Error(`${what}: origin's default branch is unknown; ${fix}`);
  return asked;
}

/**
 * The commit a worktree with nothing of its own starts at — a stage with no
 * branch, or an item branch not yet made: origin's default branch, fetched
 * now. The operator's `HEAD` was this, and it is whatever their checkout has
 * out, however long ago it was pulled: an item specced there was specced on
 * stale code, and one built there carried their branch into its pull request.
 *
 * A fetch that fails fails the round with git's words, never a quiet fall back
 * to an older commit. Only a repository with no origin at all keeps `HEAD`.
 * The operator's checkout is never touched: only origin's ref moves.
 */
async function baseCommit(repoRoot: string, what: string, guard: RemoteGuard): Promise<string | null> {
  return (await fetchDefault(repoRoot, what, guard)) ?? commitOf("HEAD", repoRoot, what);
}

/**
 * Origin's default branch fetched into `refs/remotes/origin/<default>`, and
 * the commit it names now; null in a repository with no origin, where there
 * is nothing to fetch.
 */
async function fetchDefault(repoRoot: string, what: string, guard: RemoteGuard): Promise<string | null> {
  if (!(await hasOrigin(repoRoot, what))) return null;
  const branch = await defaultBranch(repoRoot, what, guard);
  const commit = await fetchTracking(branch, repoRoot, what, guard);
  if (commit === null) throw new Error(`${what}: origin's default branch ${branch} has no commit after fetching it`);
  return commit;
}

/**
 * Origin's `branch` fetched into `refs/remotes/origin/<branch>`, and the
 * commit it names; null when origin has no such branch, or there is no
 * origin. For an item branch this checkout does not have: a remote instance
 * taking over in-flight items, a second person's runtime, a fresh clone, a
 * branch deleted locally once pushed. Cut from the base instead, the step
 * works on a fork of the real branch and its push is refused for good (#233).
 *
 * Origin is asked whether it has the branch, never the tracking ref this
 * checkout kept: that may name a branch origin deleted since. A failure to
 * ask, or to fetch, fails the round, since falling back to the base is the
 * fork this exists to prevent.
 */
async function fetchItemBranch(branch: string, repoRoot: string, what: string, guard: RemoteGuard): Promise<string | null> {
  if (!(await hasOrigin(repoRoot, what))) return null;
  const ref = `refs/heads/${branch}`;
  const failed = `${what}: fetching origin's ${branch} failed`;
  const listed = await gitRemote(["ls-remote", "origin", ref], repoRoot, failed, guard);
  const there = listed.split("\n").some((line) => line.split("\t")[1]?.trim() === ref);
  if (!there) return null;
  const commit = await fetchTracking(branch, repoRoot, what, guard);
  if (commit === null) throw new Error(`${what}: origin's ${branch} has no commit after fetching it`);
  return commit;
}

async function hasOrigin(repoRoot: string, what: string): Promise<boolean> {
  return (await git(["remote"], repoRoot, what)).split("\n").includes("origin");
}

/** Origin's `branch` fetched into its remote-tracking ref, and the commit that ref names now. */
async function fetchTracking(branch: string, repoRoot: string, what: string, guard: RemoteGuard): Promise<string | null> {
  const tracking = `refs/remotes/origin/${branch}`;
  // The operator's repository, so only that one ref, as the forge's fetch of
  // the same origin takes it: their FETCH_HEAD and tags untouched, none of
  // their hooks run, and no submodule's remote asked, which can fail the round
  // whenever origin's new commits move an initialised one.
  await gitRemote(
    ["-c", "fetch.recurseSubmodules=false",
      "fetch", "-q", "--no-tags", "--no-write-fetch-head", "origin", `+refs/heads/${branch}:${tracking}`],
    repoRoot, `${what}: fetching origin's ${branch} failed`, guard,
  );
  return commitOf(tracking, repoRoot, what);
}

/** `git worktree list --porcelain`, one entry per worktree: where, at which commit, on which branch (null when detached). */
function registered(porcelain: string): Array<{ path: string; head: string | null; branch: string | null }> {
  return porcelain.split("\n\n").flatMap((block) => {
    const field = (name: string): string | null =>
      block.split("\n").find((line) => line.startsWith(`${name} `))?.slice(name.length + 1) ?? null;
    const path = field("worktree");
    const branch = field("branch")?.replace(/^refs\/heads\//, "") ?? null;
    return path === null ? [] : [{ path, head: field("HEAD"), branch }];
  });
}

/**
 * A worktree for one item, checked out on what its stage names.
 *
 * With no branch — a stage that names none — origin's default branch,
 * detached: the agent sees committed state only, cannot read the operator's
 * work in progress and cannot damage it, and nothing it commits outlives the
 * worktree. With one, a step that may write gets the branch itself — made at
 * origin's copy of it when only origin has it (`fetchItemBranch`), else at
 * origin's default branch the first time (see `baseCommit`) — with that
 * default branch fetched again every later time, for the step to merge,
 * so its commits are kept when the worktree goes; a read-only step gets the
 * branch's commit detached — the item's code, not main's, and no branch for
 * a commit it should never have made to land on.
 *
 * This is filesystem isolation, not process isolation — the agent still runs
 * as you, with your credentials on disk — which is exactly why containers
 * remain on the roadmap and why the capability check in `runStep` is the half
 * of this that actually refuses something.
 */
export async function ensureWorktree(
  item: string,
  repoRoot: string,
  on?: WorktreeBranch,
  /**
   * The directory's name, when it is not the item's own: a pairing's
   * `<item>.pair`, which the tick and a conversation — each cutting and
   * removing `<item>` as they run — never touch.
   */
  slot: string = item,
  /** `scope`: the person's folder its slots are in (`Sandbox.scope`); absent, the root's own. */
  { signal, timeoutMs = FETCH_TIMEOUT_MS, scope }: Partial<RemoteGuard> & { scope?: string | undefined } = {},
): Promise<string> {
  const guard = { signal, timeoutMs };
  const path = await pathFor(slot, repoRoot, scope);
  const what = `could not create a worktree for #${item}`;
  // Pruned first, so a registration whose directory is already gone reads as
  // gone rather than as a worktree to reuse or a branch someone still holds.
  await git(["worktree", "prune"], repoRoot, what);
  const all = registered(await git(["worktree", "list", "--porcelain"], repoRoot, what));

  // Started from origin's head when origin has moved the branch on: a step
  // sent back because the head moved must read the head that moved. The
  // item's own kept worktree holds no one's work but a step's commits, so it
  // is never a reason to leave the branch behind; it is reset onto the branch
  // when it is next reused.
  const kept = await pathFor(keptSlot(item), repoRoot, scope);
  const holder = on === undefined ? undefined : all.find((w) => w.branch === on.branch && w.path !== path && w.path !== kept);
  const local = on === undefined ? null : await commitOf(`refs/heads/${on.branch}`, repoRoot, what);
  // A branch only origin has is continued from origin's commit, never cut
  // again from the base (see `fetchItemBranch`). A write step gets the branch
  // made there, and only if nothing made it meanwhile; a read-only step looks
  // at the commit detached, and makes no branch.
  const remote = on !== undefined && local === null ? await fetchItemBranch(on.branch, repoRoot, what, guard) : null;
  if (on?.write && remote !== null) await git(["update-ref", `refs/heads/${on.branch}`, remote, ""], repoRoot, what);
  const tip = on === undefined ? null : local === null ? remote : holder ? local : await caughtUp(on.branch, local, repoRoot, what);
  const attach = on?.write ? on.branch : null;
  const base = tip === null ? await baseCommit(repoRoot, what, guard) : null;
  const detach = attach === null ? (tip ?? base) : null;
  // A write step on a branch that already exists merges origin's default
  // branch itself, from a sandbox that cannot reach an origin wanting
  // credentials: fetched here, or it merges whatever the branch's first build
  // fetched and git calls that up to date (#126). The branch is not moved.
  if (attach !== null && tip !== null && !holder) await fetchDefault(repoRoot, what, guard);

  if (attach !== null) {
    // git checks a branch out in one place at a time, and the other place is
    // usually the operator's own checkout. Taking it from there is not ours
    // to do, and git would refuse in words that name neither the item nor
    // the way out.
    if (holder) {
      throw new Error(
        `#${item}'s branch ${attach} is checked out at ${holder.path}, and git checks a branch out in one ` +
        "place at a time; landrace will not take it from there. Switch that checkout to another branch and " +
        "the item carries on.",
      );
    }
    // The item's kept worktree is ours to give up: another of its slots — a
    // pairing, a conversation's turn — needs the branch, and the kept one is
    // rebuilt when a write step next wants it.
    if (path !== kept && all.some((w) => w.path === kept && w.branch === attach)) {
      await removeWorktree(item, repoRoot, keptSlot(item), scope);
    }
  }

  // Re-used when it is already on what this step needs: a run that crashed
  // mid-step left it registered, git refuses to add a second worktree at the
  // same path anyway, and a write step's install is what reuse is for. On the
  // branch, it is reset to the commit the branch names now — one moved forward
  // under it, by origin or by a read-only step's catch-up — and what a
  // previous step left uncommitted is cleaned away, as a rebuild would; what
  // git ignores, `node_modules` and the copied files, stays. The kept one is
  // found detached, released when its last step ended, and is attached to the
  // branch again first. Detached, as it stands, at the commit it needs.
  const mine = all.find((w) => w.path === path);
  const released = mine !== undefined && path === kept && attach !== null && mine.branch === null && tip !== null;
  // In the worktree, git is pinned to the directories the engine found, never
  // the ones its `.git` file names: a step that may write could rewrite it.
  const dirs = mine && attach !== null && (mine.branch === attach || released) ? await gitDirsOf(path, repoRoot) : undefined;
  if (released) await git(["checkout", "-q", "--force", attach], path, what, dirs);
  if (mine && attach !== null && (mine.branch === attach || released)) {
    await git(["reset", "--hard", "-q", tip ?? "HEAD"], path, what, dirs);
    await git(["clean", "-fdq"], path, what, dirs);
    return path;
  }
  if (mine && attach === null && mine.branch === null && mine.head === detach) return path;

  // Anything else is rebuilt rather than switched: the worktree is disposable
  // and a commit lives on a branch, so what a previous step left uncommitted
  // does not carry over — the same as when converge unwinds. A directory that
  // exists but is registered nowhere is the residue of an interrupted remove;
  // the path is ours — `pathFor` is what makes that a fact rather than an
  // assumption — so clearing it is safe.
  // A remove git refuses — a `.git` file a step rewrote no longer points back
  // — is finished by hand: the directory cleared, then the registration pruned.
  if (mine) await git(["worktree", "remove", "--force", path], repoRoot, what).catch(() => undefined);
  await rm(path, { recursive: true, force: true });
  if (mine) await git(["worktree", "prune"], repoRoot, what);
  let add: string[];
  if (attach !== null && tip !== null) add = [path, attach];
  // The commit, not origin's ref: a branch started from a remote-tracking ref
  // would be set to track origin's default branch.
  else if (attach !== null && base !== null) add = ["-b", attach, path, base];
  else if (attach === null && detach !== null) add = ["--detach", path, detach];
  else throw new Error(`${what}: the repository has no commit to check out`);
  await git(["worktree", "add", ...add], repoRoot, what);
  return path;
}

/**
 * The item's kept worktree, detached where it stands, so the branch is free
 * while the item waits: git checks a branch out in one place at a time, and
 * a person trying the item or pushing a fix from their own checkout needs it.
 * `ensureWorktree` attaches it again for the next write step.
 *
 * Quiet on failure, as `removeWorktree` is: it runs as a converge unwinds, and
 * a branch left held is refused by name when a person switches to it.
 */
export async function releaseWorktree(item: string, repoRoot: string, scope?: string): Promise<void> {
  // Only a registered worktree: git run in a directory that is not one would
  // act on whichever repository encloses it.
  const path = await worktreeOf(keptSlot(item), repoRoot, scope).catch(() => null);
  if (path === null) return;
  // Pinned like every git in a worktree; a lookup that halts leaves the branch held, quietly.
  const dirs = await gitDirsOf(path, repoRoot).catch(() => null);
  if (dirs === null) return;
  await git(["checkout", "-q", "--detach"], path, "could not release the worktree", dirs).catch(() => undefined);
}

/**
 * Idempotent on purpose: this runs on every exit path, including the ones
 * reached because something already went wrong. A removal that threw there
 * would replace the real failure with its own.
 */
export async function removeWorktree(item: string, repoRoot: string, slot: string = item, scope?: string): Promise<void> {
  // A path this refuses is one that is not ours, and there is nothing of ours
  // at it to remove: doing nothing is the whole answer, and reporting it here
  // would be reporting it from the unwind of something else.
  const path = await pathFor(slot, repoRoot, scope).catch(() => null);
  if (path === null) return;
  // Pinned like every other git; one that cannot be pinned is not run, and that is one more failure left unsaid.
  const quiet = async (args: string[]): Promise<void> => {
    try {
      await exec("git", [...GIT_GUARD_ARGS, ...args], { cwd: repoRoot, env: envAt(repoRoot) });
    } catch {
      // See below.
    }
  };
  await quiet(["worktree", "remove", "--force", path]);
  // The registration and the directory can outlive each other — a remove that
  // failed because the repository moved leaves the directory behind, and that
  // is the disk leak. Both are cleared, and neither failure is reported: the
  // caller is usually already unwinding from something else.
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
  await quiet(["worktree", "prune"]);
}

/**
 * Where a slot's worktree is registered, or null when it has none.
 *
 * Asked before `ensureWorktree` wherever a person may already be working in
 * it: that one rebuilds a worktree that is not on the commit it expects, and
 * a pairing's detached checkout falls behind the moment main moves — a
 * rebuild would delete what the person had not committed.
 */
export async function worktreeOf(slot: string, repoRoot: string, scope?: string): Promise<string | null> {
  const path = await pathFor(slot, repoRoot, scope);
  const what = `could not read the worktree for ${slot}`;
  await git(["worktree", "prune"], repoRoot, what);
  return registered(await git(["worktree", "list", "--porcelain"], repoRoot, what)).some((w) => w.path === path)
    ? path
    : null;
}

/**
 * The commit a worktree is at. Asked of a step's worktree as it is cut, once
 * its branch has been brought up to origin's: the commit the step starts
 * from, which is what its record says it saw.
 */
export async function worktreeHead(path: string, repoRoot: string, dirs?: GitDirs): Promise<string> {
  return (await git(["rev-parse", "HEAD"], path, "could not read the worktree's commit", dirs ?? (await gitDirsOf(path, repoRoot)))).trim();
}

/**
 * What a worktree looks like right now: its commit, and every path git reports
 * as changed.
 *
 * Read before and after a step rather than asked as "is it clean", because a
 * worktree a previous run left dirty is not this step's doing — see
 * `changedSince`. Ignored paths (`dist/`, `node_modules/`) are outside this by
 * construction: they are not the repository's content, and they are discarded
 * with the worktree either way.
 */
export async function worktreeState(path: string, repoRoot: string): Promise<WorktreeState> {
  const dirs = await gitDirsOf(path, repoRoot);
  const head = await worktreeHead(path, repoRoot, dirs);
  const status = await git(
    ["status", "--porcelain", "-z", "--untracked-files=all"],
    path,
    "could not read the worktree's status",
    dirs,
  );
  return { head, changes: status.split("\0").filter((entry) => entry.length > 0) };
}

/**
 * What the step did to its worktree, in words a refusal can quote.
 *
 * The commit check is not decoration: `git add -A && git commit` leaves the
 * status completely clean, so a check that read only the status would call the
 * tidiest possible violation no violation at all.
 */
export function changedSince(before: WorktreeState, after: WorktreeState): string[] {
  const already = new Set(before.changes);
  const changes = after.changes.filter((entry) => !already.has(entry));
  return [
    ...(before.head === after.head ? [] : [`a commit (${before.head.slice(0, 8)} → ${after.head.slice(0, 8)})`]),
    ...changes,
  ];
}

/** The files `glob` matches in the checkout at `root`, among those `flags` select for `git ls-files`. */
async function filesMatching(root: string, glob: string, flags: string[], key = "copy", dirs?: GitDirs): Promise<string[]> {
  const out = await git(["ls-files", "-z", ...flags, "--", `:(glob)${glob}`], root, `could not read the files agent.worktree.${key} "${glob}" matches`, dirs);
  return out.split("\0").filter((f) => f.length > 0);
}

/** Why a glob of `agent.worktree.<key>` cannot be read from the repository root, or null. */
function globProblem(key: string, glob: string): string | null {
  if (isAbsolute(glob) || glob.startsWith("/")) return `agent.worktree.${key} "${glob}" is an absolute path; a glob is read from the repository root`;
  if (glob.split(/[\\/]/).includes("..")) return `agent.worktree.${key} "${glob}" climbs out of the repository with ".."`;
  return null;
}

/** What is wrong with `agent.worktree.lockfiles`, one line per glob: one that is absolute or climbs out with `..`. */
export function lockfileProblems(globs: readonly string[]): string[] {
  return globs.flatMap((glob) => globProblem("lockfiles", glob) ?? []);
}

/**
 * What is wrong with `agent.worktree.copy`, one line per glob and per file:
 * a glob that is absolute or climbs out with `..`, and every tracked file a
 * glob matches — copying one over the worktree would mask the branch's own
 * version of it. Asked at start and again before every copy, because a file
 * can be committed in between.
 */
export async function copyProblems(root: string, globs: readonly string[]): Promise<string[]> {
  const problems: string[] = [];
  for (const glob of globs) {
    const problem = globProblem("copy", glob);
    if (problem !== null) {
      problems.push(problem);
    } else {
      for (const file of await filesMatching(root, glob, [])) {
        problems.push(`agent.worktree.copy "${glob}" matches ${file}, which git tracks; only untracked or ignored files are copied`);
      }
    }
  }
  return problems;
}

/**
 * The untracked and ignored files the globs match, copied from the checkout
 * into the worktree at the same paths. A link that leads outside the
 * repository is not followed — it would hand the agent whatever it points at
 * — and a destination whose folder leads outside the worktree, through a
 * link the item's branch committed, is refused rather than written through.
 */
async function copyInto(path: string, root: string, globs: readonly string[], dirs: GitDirs): Promise<void> {
  const problems = await copyProblems(root, globs);
  // The item's branch too: a file it committed is untracked in the checkout
  // still, and copying over it would hand the operator's version to the next
  // `git commit -a`.
  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], path, "could not read the worktree's branch", dirs)).trim();
  for (const glob of globs) {
    if (isAbsolute(glob) || glob.split(/[\\/]/).includes("..")) continue;
    for (const file of await filesMatching(path, glob, [], "copy", dirs)) {
      problems.push(`agent.worktree.copy "${glob}" matches ${file}, which ${branch} tracks; only untracked or ignored files are copied`);
    }
  }
  if (problems.length) throw new Error(problems.join("; "));
  for (const glob of globs) {
    const files = [
      ...(await filesMatching(root, glob, ["--others", "--exclude-standard"])),
      ...(await filesMatching(root, glob, ["--others", "--ignored", "--exclude-standard"])),
    ];
    for (const file of files) {
      const from = await containedPath(root, file);
      if (!from.ok) continue;
      // ponytail: folders made before the check below are left if it refuses; they are empty.
      await mkdir(join(path, dirname(file)), { recursive: true });
      const into = await containedPath(path, dirname(file));
      if (!into.ok) throw new Error(`agent.worktree.copy will not copy ${file}: its folder in the worktree ${into.reason}`);
      const to = join(into.path, basename(file));
      // A link already at the path would be written through.
      await rm(to, { force: true });
      await copyFile(from.path, to);
    }
  }
}

/**
 * What setup's last run was for: its commands, and each lockfile the globs
 * match as the worktree holds it now — tracked, or added and not yet
 * committed — by its path, so one added or removed counts as a change too.
 */
async function setupHash(path: string, { setup, lockfiles }: WorktreeSetup, dirs: GitDirs): Promise<string> {
  const hash = createHash("sha256").update(JSON.stringify(setup));
  const files = new Set<string>();
  for (const glob of lockfiles) {
    for (const file of await filesMatching(path, glob, ["--cached", "--others", "--exclude-standard"], "lockfiles", dirs)) files.add(file);
  }
  for (const file of [...files].sort()) {
    hash.update(`\0${file}\0`);
    hash.update(await readFile(join(path, file)).catch(() => "\0absent"));
  }
  return hash.digest("hex");
}

/**
 * One setup command, in the worktree, through the shell — it is the
 * operator's own line, trusted like `landrace.yaml` — with the agent's
 * minimal environment, never the engine's: an install script must not see the
 * forge token. Its whole process group is killed at the timeout or an abort.
 * Null when it passed, or why not with the tail of its output.
 */
function runSetup(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<string | null> {
  return new Promise((done) => {
    let tail = "";
    let stopped: string | null = null;
    const env = Object.fromEntries(INHERITED_ENV_KEYS.flatMap((key) => {
      const value = process.env[key];
      return value === undefined ? [] : [[key, value]];
    }));
    const child = spawn(command, { cwd, env, shell: true, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const keep = (chunk: Buffer): void => {
      tail = (tail + chunk.toString()).slice(-SETUP_TAIL);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const stop = (why: string): void => {
      stopped = why;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => stop(`timed out after ${timeoutMs}ms`), timeoutMs);
    const onAbort = (): void => stop("was stopped: the run was aborted");
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (failure: string | null): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const said = tail.trim();
      done(failure === null ? null : `${failure}${said ? `:\n${said}` : ", and printed nothing"}`);
    };
    child.on("error", (e) => finish(`could not start: ${messageOf(e)}`));
    child.on("close", (code, sig) => {
      if (stopped !== null) finish(stopped);
      else if (code === 0) finish(null);
      else finish(code === null ? `was killed by ${String(sig)}` : `exited ${code}`);
    });
  });
}

/**
 * A write step's worktree made ready for its agent: `copy`, then `setup` when
 * its commands or its lockfiles have changed since it last passed here.
 *
 * What it last passed for is recorded in the worktree's own git folder, so a
 * rebuilt worktree has none and runs setup again, and a record that is
 * missing or unreadable runs it too: reuse is an optimisation, never a source
 * of truth. A failure throws the command's tail, before the agent is paid for.
 */
export async function prepareWorktree({ item, path, root, setup, log, signal }: WorktreePreparation): Promise<void> {
  // Setup runs the operator's commands outside the sandbox, and any git they start reads the
  // worktree's `.git` file and its admin folder's `commondir`, not the directories pinned here.
  await worktreeIntact(path, root);
  const dirs = await gitDirsOf(path, root);
  await copyInto(path, root, setup.copy, dirs);
  if (setup.setup.length === 0) return;
  // The admin folder the engine found, not `--git-path`, which reads the worktree's own `.git` file.
  const record = join(dirs.GIT_DIR, "landrace-setup");
  if ((await readFile(record, "utf8").catch(() => null)) === (await setupHash(path, setup, dirs))) return;
  await rm(record, { force: true });
  for (const command of setup.setup) {
    log("worktree.setup.started", { item, command });
    const started = Date.now();
    const failure = await runSetup(command, path, setup.timeoutMs, signal);
    if (failure !== null) {
      log("worktree.setup.failed", { item, command, reason: failure });
      throw new Error(`#${item}'s worktree setup "${command}" ${failure}`);
    }
    log("worktree.setup.finished", { item, command, ms: Date.now() - started });
  }
  // Hashed after, so a setup that rewrites a lockfile is not run again for its own change.
  await writeFile(record, await setupHash(path, setup, dirs));
}
