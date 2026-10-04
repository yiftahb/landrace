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
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { BaseExecutor, DEFAULT_DENY, shortPath } from "landrace/kit";
import type {
  AgentSettings, EventReading, HandoffPlan, HookLog, McpServerConfig, PairingKind, RunPlan, SandboxSettings,
} from "landrace/kit";
import type { Executor, HandoffArg } from "landrace/hooks";

export { ARG_SHAPE, mcpRedactionValues, resolveStepServers } from "landrace/kit";

/** This integration's own `agent:` key. */
export interface ClaudeExtras {
  /**
   * Plugin ids (`name@marketplace`) enabled for every declared run.
   * `--restricted` ignores the operator's own settings, and with them every
   * plugin enabled there, so a read-only step would otherwise have none.
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
function sandboxSettings({ hosts, deny }: SandboxSettings): Record<string, unknown> {
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: hosts, strictAllowlist: true },
      filesystem: { denyRead: deny },
    },
    permissions: { deny: deny.flatMap((path) => [`Read(${path})`, `Read(${path}/**)`]) },
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
 * realpath is `tree`. One that is not there does not; a link that leads
 * nowhere does, since what it will lead to cannot be told.
 */
async function leadsOut(tree: string, path: string): Promise<boolean> {
  const real = await realpath(path).catch(() => undefined);
  if (real === undefined) return lstat(path).then(() => true, () => false);
  return real !== tree && !real.startsWith(tree + sep);
}

/**
 * What `--add-dir` loads from a directory's own `.claude/settings.json` and
 * `.claude/settings.local.json` beside its `CLAUDE.md`, whatever
 * `--setting-sources` says: the plugins it enables and the marketplaces they
 * come from (2.1.289's own source). A step could commit either, and a
 * plugin's hooks run outside the sandbox. Refused, never loaded.
 */
async function refuseAddDirSettings(cwd: string): Promise<void> {
  for (const file of [".claude/settings.json", ".claude/settings.local.json"]) {
    const text = await readFile(join(cwd, file), "utf8").catch(() => undefined);
    if (text === undefined) continue;
    let keys: string[];
    try {
      const value: unknown = JSON.parse(text);
      keys = value !== null && typeof value === "object" ? Object.keys(value) : [];
    } catch {
      throw new Error(`refused to run claude where ${file} would load beside it: it is not JSON, so what it enables cannot be told. Fix or remove it on the branch`);
    }
    const loaded = keys.filter((k) => k === "enabledPlugins" || k === "extraKnownMarketplaces");
    if (loaded.length) {
      throw new Error(`refused to run claude where ${file} would load beside it: the --add-dir that loads the step's CLAUDE.md ` +
        `also loads its ${loaded.join(" and ")}, and a step could commit them. Name the plugins in agent.plugins and remove them from the branch`);
    }
  }
}

/**
 * The front-matter keys a project skill may hold: what it says, when it
 * applies, and tools it gives up. Any other is refused, by name, since the
 * CLI reads many that change what its step may do — a skill's hooks run as
 * the CLI's own hooks do, outside the sandbox (what `--setting-sources user`
 * exists to keep from a committed settings file); its allowed-tools approve
 * a tool the step never declared; and `model`, `context`, `agent`,
 * `mcpServers` and the rest bill, run or start what the step did not ask for.
 */
const SKILL_KEYS = new Set([
  "name", "description", "when_to_use", "argument-hint", "arguments", "version", "license", "metadata",
  "user-invocable", "disable-model-invocation", "disallowed-tools", "paths",
]);
const REFUSED_WHY = new Map([
  ["hooks", "which would run outside the sandbox"],
  ["allowed-tools", "which would let the agent use a tool its step did not declare"],
]);

/**
 * Why a SKILL.md cannot load, or undefined. The CLI reads its front matter as
 * YAML, where a key can be quoted, escaped, explicit or merged in; this reads
 * only the plain `key:` at the start of a line that a skill writes, and
 * refuses any other line at that level rather than guess what it spells. The
 * block runs to the first line that is `---`, or to the end: never shorter
 * than the CLI's own, which ends at the first `---` anywhere.
 */
function skillProblem(text: string): string | undefined {
  const body = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const open = /^\s*---\s*\n/.exec(body);
  if (open === null) return undefined;
  const rest = body.slice(open[0].length);
  const end = rest.search(/^---[ \t]*$/m);
  const block = end < 0 ? rest : rest.slice(0, end);
  // YAML 1.1 breaks a line at U+0085, U+2028 and U+2029 too, where splitting
  // on "\n" would read one line and miss the key after the break.
  // eslint-disable-next-line no-control-regex -- finding control characters is the point
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x85\u2028\u2029]/.test(block)) {
    return "has front matter holding a control character or a line break other than a newline, so whether it declares hooks or allowed-tools cannot be told";
  }
  let first = true;
  for (const [i, line] of block.split("\n").entries()) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    // Indented under a key: its value. Before any key, it would make every
    // key below it the indented one.
    if (!first && line.startsWith(" ")) continue;
    const key = /^([A-Za-z0-9_-]+)[ \t]*:(?:[ \t]|$)/.exec(line)?.[1];
    if (key === undefined) {
      return `has front matter whose line ${i + 1}, ${JSON.stringify(line)}, is not a plain key, so whether it declares hooks or allowed-tools cannot be told`;
    }
    if (!SKILL_KEYS.has(key)) return `declares ${key}, ${REFUSED_WHY.get(key) ?? "which may change what its step does"}`;
    first = false;
  }
  return undefined;
}

/**
 * Where a worktree's skills load from: outside it, so a step cannot shadow
 * the plugin, at a path derived from it, so a run after a crash rebuilds the
 * same one rather than leave another.
 */
const pluginDirOf = (cwd: string): string =>
  join(tmpdir(), "landrace-claude", createHash("sha256").update(cwd).digest("hex").slice(0, 16));

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
 */
async function buildPluginDir(cwd: string): Promise<void> {
  const root = join(cwd, ".claude", "skills");
  const tree = await realpath(cwd);
  const refuseOut = async (path: string): Promise<void> => {
    if (await leadsOut(tree, join(cwd, path))) {
      throw new Error(`refused to load the project's skills: ${path} leads outside the worktree. Remove it from the branch`);
    }
  };
  await refuseOut(".claude/skills");
  const dir = pluginDirOf(cwd);
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, ".claude-plugin"), { recursive: true });
  await writeFile(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "project" }));
  await mkdir(join(dir, "skills"));
  // As the CLI's plugin loader reads a skills folder: one SKILL.md per entry.
  for (const name of await readdir(root)) {
    const from = join(root, name);
    await refuseOut(`.claude/skills/${name}`);
    await refuseOut(`.claude/skills/${name}/SKILL.md`);
    const text = await readFile(join(from, "SKILL.md"), "utf8").catch(() => undefined);
    if (text === undefined) continue;
    const problem = skillProblem(text);
    if (problem !== undefined) {
      throw new Error(`refused to load the project's skills: .claude/skills/${name}/SKILL.md ${problem}. Remove it from the branch`);
    }
    const to = join(dir, "skills", name);
    await mkdir(to);
    await writeFile(join(to, "SKILL.md"), text);
    for (const entry of await readdir(from)) if (entry !== "SKILL.md") await symlink(join(from, entry), join(to, entry));
  }
}

export class Claude extends BaseExecutor<ClaudeExtras> {
  readonly id = "claude";
  /** The levels `claude --effort` takes. */
  readonly efforts = ["low", "medium", "high", "xhigh", "max"];
  readonly pairings: readonly PairingKind[] = ["take", "continue", "fork"];
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

  /**
   * The CLI finds a session only under the directory it ran in, and the one
   * resumed may have run elsewhere: a pairing's hand-in forks in the
   * pairing's checkout, and a later turn resumes it from the item's. Not
   * found, the `--resume` fails as it always did.
   *
   * A step's own directory is checked before it is added, and its skills made
   * into the plugin `argv` names: the screener gets neither.
   */
  protected async prepare({ tier, resume, cwd }: RunPlan<ClaudeExtras>): Promise<void> {
    if (resume !== undefined && cwd !== undefined) await bringSession(this.home, resume, projectDir(this.home, cwd));
    if (tier === "screen" || cwd === undefined) return;
    await refuseAddDirSettings(cwd);
    if (existsSync(join(cwd, ".claude", "skills"))) await buildPluginDir(cwd);
  }

  protected argv({ tier, model, effort, resume, fork, cwd, servers, allowed, sandbox, extras }: RunPlan<ClaudeExtras>): string[] {
    const declared = tier !== "screen";
    // A step's own instructions and skills: `--setting-sources user` and
    // `--restricted` each keep the CLI from reading the worktree's
    // `CLAUDE.md` and `.claude/skills` as the project's (live on 2.1.289).
    // So the worktree is added as a directory of its own, which loads its
    // root `CLAUDE.md` only with the setting below, and its skills come as a
    // plugin `prepare` made of them. `prepare` has refused the settings
    // `--add-dir` is known to load beside it, and any skill whose front
    // matter it cannot vouch for. Never the screener's.
    const instructions = declared && cwd !== undefined;
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
    // them, and the operator's settings with them — every command it runs
    // confined by the sandbox (see `sandboxSettings`).
    if (!mayWrite) args.push("--restricted");
    // A write run is not `--restricted`, so without this its own worktree's
    // `.claude/settings.json`/`.claude/settings.local.json` would load beside
    // the operator's — live on 2.1.283, a committed settings file's
    // SessionStart hook ran under plain `acceptEdits`, outside the sandbox
    // entirely (full HOME, network, the forge token), the moment a later
    // write step touched that branch. This keeps a write run to the
    // operator's own user settings only, same as the plugins and sandbox.
    if (mayWrite) args.push("--setting-sources", "user");
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
    // prompt — and `--restricted` ignores the operator's own settings file,
    // so this is the only way a plugin enabled there reaches a read-only step
    // at all. The sandbox is for a run that may write: the only one with Bash.
    const settings = {
      ...(declared && extras.plugins.length ? { enabledPlugins: Object.fromEntries(extras.plugins.map((id) => [id, true])) } : {}),
      ...(mayWrite ? sandboxSettings(sandbox) : {}),
      ...(instructions ? { env: { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" } } : {}),
    };
    if (Object.keys(settings).length) args.push("--settings", JSON.stringify(settings));
    // Variadic, both: `--mcp-config`, always pushed below, ends them.
    if (instructions) args.push("--add-dir", cwd);
    if (instructions && existsSync(join(cwd, ".claude", "skills"))) args.push("--plugin-dir", pluginDirOf(cwd));
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
