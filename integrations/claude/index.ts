/*
 * Claude Code's `claude -p`, as a landrace integration: the command line per
 * tier, the stream-json it prints, plugin ids, and the session files a
 * pairing carries between directories. Everything else — the process, the
 * checks, `.mcp.json`, the sandbox's settings — is the kit's.
 *
 * A project's hook is `export const claude = new Claude();`, or a subclass
 * that overrides one piece.
 */
import { createHash } from "node:crypto";
import { constants, existsSync, realpathSync } from "node:fs";
import { copyFile, mkdir, open, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, posix, sep } from "node:path";
import { BaseExecutor, DEFAULT_DENY, shortPath } from "landrace/kit";
import type {
  AgentSettings, EventReading, HandoffPlan, HookLog, McpServerConfig, PairingKind, RunPlan, SandboxSettings, StepKey,
} from "landrace/kit";
import type { Executor, HandoffArg } from "landrace/hooks";

export { ARG_SHAPE, mcpRedactionValues, resolveStepServers } from "landrace/kit";

/** This integration's own `agent:` key. */
export interface ClaudeExtras {
  /**
   * Plugin ids (`name@marketplace`) enabled for every declared run whose step
   * lists none of its own. No step reads the operator's own settings, and
   * with them every plugin enabled there, so it would otherwise have none.
   */
  plugins: readonly string[];
}

/** `agent:` as the Claude integration reads it. */
export type ClaudeSettings = AgentSettings<ClaudeExtras>;

/** The CLI's tools that edit a file or run a command: what a read-only step is denied by name. */
const WRITE_TOOLS = ["Bash", "Edit", "MultiEdit", "NotebookEdit", "Write"] as const;

/**
 * Claude Code's own settings for a run that may write, confining every
 * command it starts, in the keys a live run on 2.1.283 used.
 *
 * `autoAllowBashIfSandboxed` is what gives the step Bash at all: under `-p`,
 * a command the operator had not pre-approved was refused, which is how #19's
 * build edited files, committed nothing and reported done.
 * `failIfUnavailable`: no sandbox, no run, never a quiet fallback to none.
 * `allowUnsandboxedCommands: false`: no per-command way out of it.
 * The sandbox confines commands and not the Read tool, so each denied path is
 * a Read rule too — itself and everything under it, since which of the two it
 * is cannot be told without reading the operator's home.
 */
function sandboxSettings({ hosts, deny }: SandboxSettings, built: string | undefined): Record<string, unknown> {
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: hosts, strictAllowlist: true },
      filesystem: { denyRead: deny, ...(built === undefined ? {} : { denyWrite: [built] }) },
    },
    // `//` is an absolute path in a permission rule, where `/` is the settings' own root.
    permissions: {
      deny: [...deny.flatMap((path) => [`Read(${path})`, `Read(${path}/**)`]), ...(built === undefined ? [] : [`Edit(/${built}/**)`])],
    },
  };
}

/** Per tool, the argument worth a glance — the file it read, the command it ran — in the names the CLI's own tools use. */
const TOOL_ARGS = ["file_path", "notebook_path", "path", "command", "pattern", "url", "query", "description"];

/** One tool call as the item panel shows it: its name and that argument, relative to where the agent runs. */
function toolLine(name: string, input: unknown, cwd: string): string {
  const args = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const key = TOOL_ARGS.find((k) => typeof args[k] === "string" && args[k] !== "");
  return key === undefined ? name : `${name} ${shortPath(args[key] as string, cwd)}`;
}

/** Where the CLI keeps a directory's sessions: its path, every character but a letter or digit made "-". */
const projectDir = (home: string, cwd: string): string =>
  join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));

/**
 * The agent's session, made resumable from `here`: already there, or copied
 * from the one directory it is found under. False when it is under none, or
 * under several — which of two to continue is not this integration's to
 * guess — and a pairing then starts fresh, seeded with the step.
 *
 * ponytail: reads the CLI's own session layout, which is its to change; a
 * `--resume` that finds no session is where that shows up.
 */
async function bringSession(home: string, session: string, here: string): Promise<boolean> {
  const file = `${session}.jsonl`;
  if (existsSync(join(here, file))) return true;
  const projects = join(home, ".claude", "projects");
  const found = (await readdir(projects).catch(() => [] as string[]))
    .map((dir) => join(projects, dir, file))
    .filter((path) => existsSync(path));
  const [only, ...more] = found;
  if (only === undefined || more.length) return false;
  await mkdir(here, { recursive: true });
  await copyFile(only, join(here, file));
  return true;
}

/**
 * Whether `path`, every link in it followed, leads out of the worktree whose
 * realpath is `tree`. One that is not there does not, and nor does a link
 * that leads nowhere: Landrace copies what it reads before the agent starts,
 * so a target made later is never read, and there is nothing to copy.
 */
async function leadsOut(tree: string, path: string): Promise<boolean> {
  const real = await realpath(path).catch(() => undefined);
  return real !== undefined && real !== tree && !real.startsWith(tree + sep);
}

/**
 * The text of the worktree's `path`, or undefined when it cannot be opened.
 * Anything there but a regular file — a named pipe, a device — is refused,
 * naming it, after `refused`, or read as undefined without one: reading one
 * could wait forever, and `prepare` runs before the step's timeout and abort
 * exist. Opened without blocking and checked on the open file, so nothing
 * can be swapped in between.
 */
async function readRegular(cwd: string, path: string, refused?: string): Promise<string | undefined> {
  const file = await open(join(cwd, path), constants.O_RDONLY | constants.O_NONBLOCK).catch(() => undefined);
  if (file === undefined) return undefined;
  try {
    if (!(await file.stat()).isFile()) {
      if (refused === undefined) return undefined;
      throw new Error(`${refused}: ${path} is not a regular file. Make it one, or remove it, on the branch`);
    }
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

/**
 * Each `@path` a CLAUDE.md imports, as the CLI finds them (2.1.289's own
 * source): after a line's start or a space, `\ ` for a space, a `#` ending
 * it. The CLI skips code, comments and what cannot be a path; this reads them
 * all, never fewer.
 */
const importsOf = (text: string): string[] =>
  [...text.matchAll(/(?:^|\s)@((?:[^\s\\]|\\ )+)/g)]
    .map((m) => (m[1] as string).split("#")[0]!.replaceAll("\\ ", " "))
    .filter((path) => path !== "");

/**
 * The worktree's root `CLAUDE.md` for `--add-dir`, since neither tier's flags
 * load a project's instructions: a copy, outside the worktree, beside a copy
 * of each file it imports at the same place, so the CLI resolves an import
 * among the copies. The CLI rereads its instructions mid-run, after
 * compacting, and a copy holds what was checked, where the worktree's file is
 * whatever a step has made it since. Nothing of `.claude/` comes along, so
 * neither its settings nor anything else the CLI reads beside a `CLAUDE.md`
 * loads: an import there loads nothing.
 *
 * Landrace reads these outside the sandbox, and the CLI resolves an import
 * outside it too, so a file that leads outside the worktree, or an import of
 * `~/`, an absolute path or a path above the worktree, is refused, naming it,
 * before anything is read.
 */
async function buildInstructions(cwd: string, dir: string): Promise<void> {
  const tree = await realpath(cwd);
  await mkdir(dir, { recursive: true });
  const importer = new Map([["CLAUDE.md", ""]]);
  for (const [file, from] of importer) {
    if (await leadsOut(tree, join(cwd, file))) {
      throw new Error(`refused to load the step's instructions: ${from ? `${from} imports ${file}, which` : file} leads outside the worktree. ` +
        "Make it a file, or a link inside the worktree, on the branch");
    }
    const text = await readRegular(cwd, file);
    if (text === undefined) continue;
    await mkdir(join(dir, dirname(file)), { recursive: true });
    await writeFile(join(dir, file), text);
    for (const path of importsOf(text)) {
      const rel = posix.normalize(posix.join(posix.dirname(file), path));
      if (path.startsWith("/") || path.startsWith("~/") || rel === ".." || rel.startsWith("../")) {
        throw new Error(`refused to load the step's instructions: ${file} imports ${path}, which is outside the worktree. Remove the import from the branch`);
      }
      // In any case: macOS's filesystem would put `.CLAUDE/` in `.claude/`.
      if (!/^\.claude(\/|$)/i.test(rel) && !importer.has(rel)) importer.set(rel, file);
    }
  }
}

/**
 * The front-matter keys a project skill may hold: what it says, when it
 * applies, and tools it gives up. Kept, as written, in the copy that loads.
 */
const SKILL_KEYS = new Set([
  "name", "description", "when_to_use", "argument-hint", "arguments", "version", "license", "metadata",
  "user-invocable", "disable-model-invocation", "disallowed-tools", "paths",
]);

/**
 * The keys Claude Code acts on that change what a step may do, refused by
 * name: a skill's hooks run as the CLI's own hooks do, outside the sandbox
 * (what `--setting-sources ""` exists to keep from a committed settings
 * file); its allowed-tools approve a tool the step never declared; and
 * `model`, `context`, `agent` and `mcpServers` bill, run or start what the
 * step did not ask for. Any other key — a skill generator's bookkeeping, such
 * as agsync's `scope:` — is dropped from the copy, which is what loads, so
 * it can never act.
 */
const REFUSED_WHY = new Map([
  ["hooks", "which would run outside the sandbox"],
  ["allowed-tools", "which would let the agent use a tool its step did not declare"],
  ["model", "which would bill a model the step did not ask for"],
  ["context", "which would run the skill in a context the step did not ask for"],
  ["agent", "which would run the skill under an agent the step did not ask for"],
  ["mcpServers", "which would start servers the step did not ask for"],
]);

/**
 * A SKILL.md as it loads — each key outside `SKILL_KEYS` dropped with its
 * value, and which those were — or why it cannot load. The CLI reads its
 * front matter as YAML, where a key can be quoted, escaped, explicit or
 * merged in; this reads only the plain `key:` at the start of a line that a
 * skill writes, and refuses any other line at that level rather than guess
 * what it spells. The block runs to the first line that is `---`, or to the
 * end: never shorter than the CLI's own, which ends at the first `---`
 * anywhere. With nothing dropped, the text is the file's own.
 */
function skillCopy(text: string): { problem: string } | { text: string; dropped: string[] } {
  const body = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const open = /^\s*---\s*\n/.exec(body);
  if (open === null) return { text, dropped: [] };
  const rest = body.slice(open[0].length);
  const end = rest.search(/^---[ \t]*$/m);
  const block = end < 0 ? rest : rest.slice(0, end);
  // YAML 1.1 breaks a line at U+0085, U+2028 and U+2029 too, where splitting
  // on "\n" would read one line and miss the key after the break.
  // eslint-disable-next-line no-control-regex -- finding control characters is the point
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x85\u2028\u2029]/.test(block)) {
    return { problem: "has front matter holding a control character or a line break other than a newline, so whether it declares hooks or allowed-tools cannot be told" };
  }
  const kept: string[] = [];
  const dropped: string[] = [];
  let first = true;
  // Inside a dropped key: every line up to the next key is its value, and goes with it.
  let dropping = false;
  const lines = block.split("\n");
  // What follows the block's last newline is no line of it: the closing `---` begins there.
  const ended = block.endsWith("\n") ? lines.pop() : undefined;
  for (const [i, line] of lines.entries()) {
    // Indented under a key: its value. Before any key, it would make every
    // key below it the indented one.
    if (/^\s*(#.*)?$/.test(line) || (!first && line.startsWith(" "))) {
      if (!dropping) kept.push(line);
      continue;
    }
    const key = /^([A-Za-z0-9_-]+)[ \t]*:(?:[ \t]|$)/.exec(line)?.[1];
    if (key === undefined) {
      return { problem: `has front matter whose line ${i + 1}, ${JSON.stringify(line)}, is not a plain key, so whether it declares hooks or allowed-tools cannot be told` };
    }
    const why = REFUSED_WHY.get(key);
    if (why !== undefined) return { problem: `declares ${key}, ${why}` };
    first = false;
    dropping = !SKILL_KEYS.has(key);
    if (!dropping) kept.push(line);
    else if (!dropped.includes(key)) dropped.push(key);
  }
  if (dropped.length === 0) return { text, dropped };
  if (ended !== undefined) kept.push(ended);
  return { text: `${body.slice(0, open[0].length)}${kept.join("\n")}${rest.slice(block.length)}`, dropped };
}

/**
 * Where a worktree's instructions and skills load from, `instructions/` and
 * `plugin/`: outside it, so a step cannot shadow them, at a path derived from
 * it, so a run after a crash rebuilds the same one rather than leave another.
 * Resolved, so the path a write step is denied is the one the CLI sees.
 */
const builtOf = (cwd: string): string =>
  join(realpathSync(tmpdir()), "landrace-claude", createHash("sha256").update(cwd).digest("hex").slice(0, 16));

/**
 * The worktree's `.claude/skills` as a plugin of its own for `--plugin-dir`,
 * since neither tier's flags load a project's skills: its manifest and
 * `skills/`, and nothing else — no hooks, commands or servers. Each skill's
 * SKILL.md is the copy read and checked here, beside links to the rest of its
 * folder: the CLI reloads skills mid-run, and a link to the worktree's file
 * would load whatever a step wrote there since. The plugin loads them as
 * `project:<name>`.
 *
 * Landrace reads each SKILL.md outside the sandbox, so the skills folder, a
 * skill's folder or its SKILL.md leading out of the worktree is refused, by
 * name, before anything is read: a link to a key would hand the agent the key.
 *
 * Given `only`, the step's own `skills:`, a skill it does not name is never
 * read or copied, so never loads.
 */
async function buildPluginDir(cwd: string, dir: string, only: readonly string[] | undefined, log: HookLog | undefined): Promise<void> {
  const root = join(cwd, ".claude", "skills");
  const tree = await realpath(cwd);
  const refuseOut = async (path: string): Promise<void> => {
    if (await leadsOut(tree, join(cwd, path))) {
      throw new Error(`refused to load the project's skills: ${path} leads outside the worktree. Remove it from the branch`);
    }
  };
  await refuseOut(".claude/skills");
  await mkdir(join(dir, ".claude-plugin"), { recursive: true });
  await writeFile(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "project" }));
  await mkdir(join(dir, "skills"));
  // As the CLI's plugin loader reads a skills folder: one SKILL.md per entry.
  for (const name of await readdir(root)) {
    if (only !== undefined && !only.includes(name)) continue;
    const from = join(root, name);
    await refuseOut(`.claude/skills/${name}`);
    await refuseOut(`.claude/skills/${name}/SKILL.md`);
    const text = await readRegular(cwd, `.claude/skills/${name}/SKILL.md`, "refused to load the project's skills");
    if (text === undefined) continue;
    const copy = skillCopy(text);
    if ("problem" in copy) {
      throw new Error(`refused to load the project's skills: .claude/skills/${name}/SKILL.md ${copy.problem}. Remove it from the branch`);
    }
    for (const key of copy.dropped) log?.("claude.skill.key.dropped", { skill: name, key });
    const to = join(dir, "skills", name);
    await mkdir(to);
    await writeFile(join(to, "SKILL.md"), copy.text);
    for (const entry of await readdir(from)) if (entry !== "SKILL.md") await symlink(join(from, entry), join(to, entry));
  }
}

export class Claude extends BaseExecutor<ClaudeExtras> {
  readonly id = "claude";
  /** The levels `claude --effort` takes. */
  readonly efforts = ["low", "medium", "high", "xhigh", "max"];
  readonly pairings: readonly PairingKind[] = ["take", "continue", "fork"];
  /** A step's `skills:` is the plugin `prepare` makes; its `plugins:`, what `--settings` enables. */
  override readonly stepKeys: readonly StepKey[] = ["skills", "plugins"];
  /** Whose `~/.claude` a session is looked up in. The operator's own, but for a test. */
  private readonly home: string;

  constructor({ bin = "claude", home = homedir() }: { bin?: string | undefined; home?: string | undefined } = {}) {
    super(bin);
    this.home = home;
  }

  protected readExtras(agent: Record<string, unknown>): { extras: ClaudeExtras; problems: string[] } {
    const { plugins = [] } = agent;
    const ok = Array.isArray(plugins) && plugins.every((p) => typeof p === "string" && p !== "");
    return ok
      ? { extras: { plugins: plugins as string[] }, problems: [] }
      : { extras: { plugins: [] }, problems: ['agent.plugins must be a list of plugin ids, like "name@marketplace"'] };
  }

  /** A skill is a folder of `.claude/skills` holding a SKILL.md, as `buildPluginDir` reads it. */
  protected async skillProblems(root: string, listed: readonly string[]): Promise<string[]> {
    const skills = join(root, ".claude", "skills");
    // Among the folder's own entries, so a name like `../x` is never a path.
    const names = new Set(await readdir(skills).catch(() => [] as string[]));
    return listed
      .filter((name) => !names.has(name) || !existsSync(join(skills, name, "SKILL.md")))
      .map((name) => `lists skill ${JSON.stringify(name)}, which no .claude/skills/*/SKILL.md defines`);
  }

  /**
   * The CLI finds a session only under the directory it ran in, and the one
   * resumed may have run elsewhere: a pairing's hand-in forks in the
   * pairing's checkout, and a later turn resumes it from the item's. Not
   * found, the `--resume` fails as it always did.
   *
   * A step's own instructions and skills are checked and copied into the
   * directories `argv` names, rebuilt on every run: the screener gets neither.
   */
  protected async prepare({ tier, resume, cwd, skills, log }: RunPlan<ClaudeExtras>): Promise<void> {
    if (resume !== undefined && cwd !== undefined) await bringSession(this.home, resume, projectDir(this.home, cwd));
    if (tier === "screen" || cwd === undefined) return;
    const built = builtOf(cwd);
    await rm(built, { recursive: true, force: true });
    await buildInstructions(cwd, join(built, "instructions"));
    // A step that lists no skill gets no plugin at all.
    if (skills?.length !== 0 && existsSync(join(cwd, ".claude", "skills"))) await buildPluginDir(cwd, join(built, "plugin"), skills, log);
  }

  protected argv({ tier, model, effort, resume, fork, cwd, servers, allowed, sandbox, extras, plugins: own }: RunPlan<ClaudeExtras>): string[] {
    const declared = tier !== "screen";
    // A step's own instructions and skills: `--setting-sources ""` and
    // `--restricted` each keep the CLI from reading the worktree's
    // `CLAUDE.md` and `.claude/skills` as the project's (live on 2.1.289).
    // So they come from copies `prepare` checked and made outside the
    // worktree: its root `CLAUDE.md` and what that imports, in a directory
    // added as one of the run's own, which loads it only with the setting
    // below, and its skills as a plugin. A directory added is one a write
    // step may edit, so its sandbox and Edit rules deny it them, or the step
    // could write a CLAUDE.md the CLI rereads after compacting. Never the
    // screener's.
    const built = declared && cwd !== undefined ? builtOf(cwd) : undefined;
    const mayWrite = tier === "write";
    // Not plan mode, which is what a read-only step and the screener ran in
    // until a live check against the real CLI (2.1.282) showed what it
    // cost: plan mode refuses every MCP call — create_child and every
    // allowlisted server alike — and ignored `--model`, running sonnet for
    // a step (or a screener) that asked for haiku. So anything that may not
    // write runs in the CLI's default mode, `manual`.
    //
    // stream-json ends on the result event, which carries session_id —
    // without it a conversation cannot continue — and prints every tool call
    // and message before it as a line of its own, which is what the item
    // panel shows. Under -p the CLI refuses stream-json without --verbose.
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", mayWrite ? "acceptEdits" : "manual"];
    // `--restricted` removes the tools that run commands or code (Bash and
    // the rest) and WebFetch, and ignores the operator's user, project and
    // local settings. It does not remove Edit or Write: the deny list does
    // that, for a read-only step, and `--tools ""` removes every built-in
    // tool for the screener. The same live check refused a write attempted
    // under the read-only step's flags. A step that may write keeps all of
    // them — every command it runs confined by the sandbox (see
    // `sandboxSettings`).
    if (!mayWrite) args.push("--restricted");
    // A write run is not `--restricted`, so without this its own worktree's
    // `.claude/settings.json`/`.claude/settings.local.json` would load — live
    // on 2.1.283, a committed settings file's SessionStart hook ran under
    // plain `acceptEdits`, outside the sandbox entirely (full HOME, network,
    // the forge token), the moment a later write step touched that branch.
    // Nor the operator's own: `user` loaded every plugin they enabled for
    // themselves into the step (live on 2.1.289), and one that speaks at
    // session start put its persona or its compressed replies into the
    // step's work and its review-thread replies. With none, only the CLI's
    // built-in plugins load, and the run still works; what it needs comes
    // through `--settings` below, as a read-only step's does.
    if (mayWrite) args.push("--setting-sources", "");
    // A run that declares nothing is the screener's, and it reads
    // attacker-reachable text for a living: no built-in tool at all, not
    // even Read. Variadic, and the empty list must not swallow what follows
    // — a flag always does, since `--mcp-config` is pushed below whatever
    // else is.
    if (!declared) args.push("--tools", "");
    // Variadic like `--allowedTools`: the next flag ends it.
    if (declared && !mayWrite) args.push("--disallowedTools", ...WRITE_TOOLS);
    if (model !== undefined) args.push("--model", model);
    if (effort !== undefined) args.push("--effort", effort);
    if (resume !== undefined) args.push("--resume", resume);
    if (fork) args.push("--fork-session");
    // One `--settings` element holding the JSON, or none. Plugins are for
    // steps and turns, never the screener: a plugin that speaks up at session
    // start would be speaking to the one agent whose only job is to judge a
    // prompt — and no step reads the operator's own settings file, so this
    // is the only way a plugin enabled there reaches a step at all: the
    // step's own `plugins:`, else `agent.plugins`. The sandbox is for a run
    // that may write: the only one with Bash.
    const plugins = own ?? extras.plugins;
    const settings = {
      ...(declared && plugins.length ? { enabledPlugins: Object.fromEntries(plugins.map((id) => [id, true])) } : {}),
      ...(mayWrite ? sandboxSettings(sandbox, built) : {}),
      ...(built !== undefined ? { env: { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" } } : {}),
    };
    if (Object.keys(settings).length) args.push("--settings", JSON.stringify(settings));
    // Variadic, both: `--mcp-config`, always pushed below, ends them.
    if (built !== undefined) args.push("--add-dir", join(built, "instructions"));
    if (built !== undefined && existsSync(join(built, "plugin"))) args.push("--plugin-dir", join(built, "plugin"));
    // Inline JSON rather than a config file: there is no path for the
    // agent's worktree to shadow and nothing to clean up after a crash.
    // Strict always, for every run and with nothing to allow as much as with
    // something: a `.mcp.json` committed to the repository the worktree is
    // cut from, or the operator's own user-level servers, would otherwise
    // load beside the agent — landrace's own operator server among them,
    // which can move a step's own item. An allowlisted server's `env` goes
    // as `.mcp.json` wrote it, and is visible in `ps` for as long as the step
    // runs.
    //
    // `--mcp-config` is variadic, so a flag follows it; so is
    // `--allowedTools`, so it goes last with nothing after it.
    args.push("--mcp-config", JSON.stringify({ mcpServers: servers }), "--strict-mcp-config");
    const tools = Object.entries(allowed).flatMap(([name, listed]) =>
      listed === null ? [`mcp__${name}`] : listed.map((tool) => `mcp__${name}__${tool}`));
    if (tools.length) args.push("--allowedTools", ...tools);
    return args;
  }

  protected readEvent(event: object, cwd: string): EventReading {
    const e = event as { type?: unknown; message?: { content?: unknown } | null; is_error?: unknown; result?: unknown; session_id?: unknown };
    // A tool's result: the files the agent read and the output of what it ran.
    if (e.type === "user") return { quiet: true };
    if (e.type === "result") {
      return {
        done: true,
        session: e.session_id,
        text: String(e.result ?? ""),
        ...(e.is_error ? { error: `agent reported an error: ${String(e.result ?? "")}` } : {}),
      };
    }
    const content = e.message?.content;
    if (e.type !== "assistant" || !Array.isArray(content)) return {};
    const activity: NonNullable<EventReading["activity"]> = [];
    for (const part of content as Array<Record<string, unknown> | null>) {
      if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
        activity.push({ kind: "message", text: part.text });
      } else if (part?.type === "tool_use" && typeof part.name === "string") {
        activity.push({ kind: "tool", text: toolLine(part.name, part.input, cwd) });
      }
    }
    return { activity };
  }

  /*
   * The interactive `claude` a person runs for a pairing: in the pairing's
   * checkout, under the session id the engine derived, seeded with the step
   * from the file the engine wrote it to — read by the person's shell, so its
   * text is never part of what they paste. Their own settings, plugins and
   * servers load as they always do — this is their session, and every tool
   * call in it is theirs to approve — beside the engine's own server, their
   * way back to Landrace.
   *
   * The CLI keeps a session under the directory it ran in. So a command run a
   * second time — after the terminal was closed — resumes the session it
   * started rather than starting another, and the agent's own session, which
   * ran in the item's worktree, is brought over before it is forked here.
   */
  protected async handoffArgv({ cwd, session, promptFile, resume, server }: HandoffPlan): Promise<HandoffArg[]> {
    const here = projectDir(this.home, cwd);
    const argv: HandoffArg[] = [this.bin];
    if (existsSync(join(here, `${session}.jsonl`))) {
      argv.push("--resume", session);
    } else {
      argv.push({ file: promptFile });
      if (resume !== undefined && (await bringSession(this.home, resume, here))) argv.push("--resume", resume, "--fork-session");
      argv.push("--session-id", session);
    }
    if (server) {
      argv.push("--mcp-config", JSON.stringify({ mcpServers: { [server.name]: { command: server.command, args: server.args } } }));
      if (server.tools.length) argv.push("--allowedTools", ...server.tools.map((tool) => `mcp__${server.name}__${tool}`));
    }
    return argv;
  }
}

/**
 * The executor `new Claude()` builds, from settings named the way this
 * integration's tests have always named them. Unbranded, like `build`.
 */
export function createClaudeExecutor(opts: {
  model?: string;
  /** The operator's effort for every step and turn; the screener never gets one. */
  effort?: string;
  timeoutMs?: number;
  bin?: string;
  log?: HookLog;
  plugins?: readonly string[];
  /** The MCP servers a declared run may use, by name, as `.mcp.json` defines them. */
  mcpServers?: Readonly<Record<string, McpServerConfig>>;
  /** Per server, the only tools a run may call on it; a server absent here allows every tool it has. */
  mcpTools?: Readonly<Record<string, readonly string[]>>;
  /** What a run that may write reaches. Absent: no network, and the default deny list. */
  sandbox?: SandboxSettings;
  /** Whose `~/.claude` a pairing's sessions are looked up in. */
  home?: string;
} = {}): Executor {
  const { bin, home, plugins = [], mcpServers = {}, mcpTools = {}, sandbox = { hosts: [], deny: [...DEFAULT_DENY] }, ...rest } = opts;
  return new Claude({ bin, home }).build({ ...rest, plugins, servers: mcpServers, tools: mcpTools, sandbox });
}

/** `agent:` as this integration reads it, or every reason it cannot be used, in one error. */
export function readClaudeSettings(agent: Record<string, unknown>): ClaudeSettings {
  return new Claude().readSettings(agent);
}
