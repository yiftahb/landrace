import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { UpdateCommand, UpdateDeps, VersionDeps } from "#namespace.js";

// Stamped by tsup from package.json at build time. A run from source — the
// tests, `node src/cli/index.ts` in a clone — has no build, and reads the
// package.json it is run beside instead.
declare const __LANDRACE_VERSION__: string | undefined;

const REGISTRY = "https://registry.npmjs.org/landrace/latest";
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** This copy's version, or "unknown" where neither a build nor a package.json says. */
export function ownVersion(): string {
  if (typeof __LANDRACE_VERSION__ === "string") return __LANDRACE_VERSION__;
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const file = join(dir, "package.json");
    if (existsSync(file)) {
      const pkg = JSON.parse(readFileSync(file, "utf8")) as { name?: unknown; version?: unknown };
      if (pkg.name === "landrace" && typeof pkg.version === "string") return pkg.version;
    }
    if (dirname(dir) === dir) return "unknown";
  }
}

/**
 * Whether `latest` is a later release than `current`. Anything that is not a
 * plain semver is never newer: a notice nagging about a version it misread is
 * worse than none. A build ahead of npm, as in a clone, is not behind it.
 */
export function isNewer(latest: string, current: string): boolean {
  const a = SEMVER.exec(latest);
  const b = SEMVER.exec(current);
  if (!a || !b) return false;
  for (const i of [1, 2, 3]) {
    const d = Number(a[i]) - Number(b[i]);
    if (d !== 0) return d > 0;
  }
  // Same x.y.z: a release is newer than its own prerelease, and nothing else is.
  return a[4] === undefined && b[4] !== undefined;
}

/** The check is off when asked (`LANDRACE_NO_UPDATE_CHECK`, any value but "0") and in CI. */
export function updateCheckOff(env: Record<string, string | undefined>): boolean {
  const asked = env.LANDRACE_NO_UPDATE_CHECK;
  return (asked !== undefined && asked !== "" && asked !== "0") || (env.CI !== undefined && env.CI !== "");
}

/** The version npm calls latest, or null for anything short of a clean answer within `timeoutMs`. */
export async function latestVersion(
  fetchImpl: (url: string, init: RequestInit) => Promise<Response> = fetch,
  timeoutMs = 2_000,
): Promise<string | null> {
  try {
    const res = await fetchImpl(REGISTRY, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown } | null;
    const version = body !== null && typeof body === "object" && !Array.isArray(body) ? body.version : undefined;
    return typeof version === "string" && SEMVER.test(version) ? version : null;
  } catch {
    return null;
  }
}

/** One line saying a newer version is out, or null — never a reason to fail the command it rides on. */
export async function updateNotice(
  env: Record<string, string | undefined>,
  current: string,
  latest: () => Promise<string | null> = latestVersion,
): Promise<string | null> {
  if (updateCheckOff(env)) return null;
  const found = await latest();
  return found !== null && isNewer(found, current)
    ? `landrace ${found} is available (this is ${current}): run \`landrace update\``
    : null;
}

const LOCKFILES: ReadonlyArray<[file: string, command: string]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

/** Whether `running`, a file of the copy that is running, is inside the folder's own `node_modules/landrace`, after realpath. */
function isOwnCopy(cwd: string, running: string): boolean {
  try {
    const own = relative(realpathSync(join(cwd, "node_modules", "landrace")), realpathSync(running));
    return !own.startsWith("..") && !isAbsolute(own);
  } catch {
    return false;
  }
}

/**
 * How to update the copy of landrace that is running, `running` being one of
 * its files. A hook's `landrace/*` imports resolve to that copy, wherever it
 * is installed, so it is the one to update: the project's dependency, with the
 * package manager its lockfile names, only when the copy running is the
 * project's own (pnpm links it from its store, hence the realpath) and its
 * package.json lists it; the global install otherwise — the usual case, even
 * where a project lists landrace too, for its editor. Two lockfiles is a
 * question for a person, not an order to pick from.
 */
export function updateCommand(cwd: string, running: string): UpdateCommand {
  const global: UpdateCommand = { command: "npm", args: ["install", "-g", "landrace@latest"], where: "global", cwd };
  if (!isOwnCopy(cwd, running)) return global;
  const file = join(cwd, "package.json");
  const pkg = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> })
    : {};
  const asDev = pkg.devDependencies?.landrace !== undefined;
  const asRuntime = pkg.dependencies?.landrace !== undefined;
  if (!asDev && !asRuntime) return global;

  const locks = LOCKFILES.filter(([lock]) => existsSync(join(cwd, lock)));
  if (locks.length > 1) {
    throw new Error(`both ${locks.map(([lock]) => lock).join(" and ")} are here: update landrace with your package manager yourself`);
  }
  const command = locks[0]?.[1] ?? "npm";
  const args = command === "npm"
    ? ["install", ...(asDev ? ["--save-dev"] : []), "landrace@latest"]
    : ["add", ...(asDev ? ["-D"] : []), "landrace@latest"];
  return { command, args, where: "project", cwd };
}

/** Runs the update with the terminal attached, as the person would have. */
export function runCommand(plan: UpdateCommand): number {
  // A shell on Windows only, where npm and pnpm are .cmd files; the arguments are fixed strings.
  return spawnSync(plan.command, plan.args, { cwd: plan.cwd, stdio: "inherit", shell: process.platform === "win32" }).status ?? 1;
}

export async function runVersion(deps: VersionDeps): Promise<void> {
  deps.log(`landrace ${deps.current}`);
  if (updateCheckOff(deps.env)) return;
  const found = await deps.latest();
  if (found === null) deps.log("Could not get the latest version from npm, so this could not be compared with it.");
  else if (isNewer(found, deps.current)) deps.log(`landrace ${found} is available: run \`landrace update\``);
  else deps.log("This is the latest version.");
}

export async function runUpdate(deps: UpdateDeps): Promise<void> {
  const found = await deps.latest();
  if (found === null) throw new Error("could not get the latest version from npm: it was unreachable, or had no answer for landrace");
  if (!isNewer(found, deps.current)) {
    deps.log(`landrace ${deps.current} is the latest version.`);
    return;
  }
  const plan = deps.plan();
  const line = [plan.command, ...plan.args].join(" ");
  deps.log(`Updating landrace ${deps.current} → ${found} (${plan.where === "project" ? `this project, in ${plan.cwd}` : "the global install"}): ${line}`);
  if (deps.run(plan) !== 0) throw new Error(`the update did not finish: run \`${line}\` yourself`);
  deps.log(`Updated to landrace ${found}.`);
}
