/*
 * What every coding agent integration needs and none of them is: starting a
 * process without a shell or the engine's environment, checking each value
 * before it reaches argv, refusing a capability it cannot enforce, reading
 * `.mcp.json`, confining a write step, killing a whole process group, and
 * stopping when the engine says stop. Published as `landrace/kit`.
 *
 * An integration extends `BaseExecutor` and says only what is its agent's:
 * the command line for a run already decided and checked here (`argv`), what
 * its output means (`readEvent`), the command a person runs to pair
 * (`handoffArgv`), and what it can do (`efforts`, `pairings`). It is an
 * executor hook as it stands — `export const agent = new MyAgent();` — and
 * a project changes one piece by overriding one method.
 */
import { execFile, spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { CAPABILITIES, CHILD_SERVER_NAME, INHERITED_ENV_KEYS, mayCreateItems, mayWriteRepo, retiredCapabilityPointers, unknownCapabilities } from "#conventions.js";
import { defineExecutor } from "#hooks/contracts.js";
import type {
  AgentSettings,
  AllowedTools,
  EventReading,
  Executor,
  ExecutorContext,
  ExecutorFactory,
  HandoffArg,
  HandoffPlan,
  KitSettings,
  McpEntry,
  McpServerConfig,
  PairingKind,
  Problem,
  ResolvedMcp,
  RunPlan,
  SandboxSettings,
  StepKey,
  Tier,
} from "#namespace.js";

export type {
  AgentSettings, EventReading, HandoffPlan, HookLog, KitSettings, McpEntry, McpServerConfig, PairingKind, ResolvedMcp, RunPlan, SandboxSettings, StepKey, Tier,
} from "#namespace.js";

/** A thrown value's message, whatever was thrown. */
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** The shortest value worth redacting: shorter matches everywhere. The engine's logger skips these too. */
const MIN_SECRET_LENGTH = 8;
/** A backstop only: the engine gives every run a limit. */
const FALLBACK_TIMEOUT_MS = 10 * 60_000;
const exec = promisify(execFile);

/**
 * A value that begins with "-" lands in a flag slot no matter which argv
 * index it occupies — `--model -x` makes a CLI read "-x" as the next flag,
 * not as the model name. Passing a value as its own array element (instead
 * of interpolating it into a shell string) rules out one class of attack and
 * not the other, so every value that reaches argv is checked against the
 * shape it is actually allowed to have, not merely isolated.
 */
export const ARG_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertArgShape(kind: string, value: string): void {
  if (!ARG_SHAPE.test(value)) {
    throw new Error(`refused ${kind} ${JSON.stringify(value)}: does not match the allowed shape for a command-line argument`);
  }
}

/**
 * An absolute path is not automatically a safe one: `/tmp/x/../../etc` is
 * absolute and still resolves somewhere the caller never wrote down.
 *
 * Checked against the path with its leading "/" removed, mirroring what the
 * engine's own `containedPath("/", cwd.slice(1))` (src/workflow/load.ts)
 * actually did: root "/" can never be escaped by anything lexical, so every
 * shape `containedPath` refused here came from its `shapeProblem` step alone
 * — empty, absolute (a second leading "/", e.g. "//tmp"), a scheme or drive
 * like first segment ("/c:/x"), a backslash, percent-encoding, or a ".."
 * segment — plus a plain "does not exist" from the realpath underneath it.
 */
async function assertCwd(cwd: string): Promise<string> {
  const refuse = (why: string): never => { throw new Error(`refused cwd ${JSON.stringify(cwd)}: ${why}`); };
  if (!isAbsolute(cwd)) refuse("must be an absolute path");
  const relative = cwd.slice(1);
  if (relative.trim() === "") refuse("is empty");
  if (isAbsolute(relative) || relative.startsWith("/")) refuse("is absolute");
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(relative)) refuse("is a URL or a drive path, not a relative path");
  if (relative.includes("\\")) refuse("contains a backslash");
  if (relative.includes("%")) refuse("is percent-encoded");
  const dotted = relative.split("/").find((seg) => /^\.{2,}$/.test(seg));
  if (dotted !== undefined) refuse(`contains a "${dotted}" segment`);
  try {
    return await realpath(resolve(cwd));
  } catch (e) {
    return refuse((e as NodeJS.ErrnoException).code === "ENOENT" ? "does not exist" : `cannot be resolved: ${messageOf(e)}`);
  }
}

/**
 * The repository root a step's `.mcp.json` lookup is relative to. git's own
 * stderr rides along rather than a generic guess: a checkout git refuses for
 * "dubious ownership", or a missing git binary entirely, would otherwise both
 * be misreported as "not inside a git repository" — a fix that isn't there to
 * make, since neither one is that.
 */
async function repositoryRoot(dir: string): Promise<string> {
  try {
    const { stdout } = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: dir });
    return stdout.trim();
  } catch (e) {
    const stderr = String((e as { stderr?: unknown }).stderr ?? "").trim();
    throw new Error(`${dir} is not inside a git repository: ${stderr || messageOf(e)}`);
  }
}

/** The agent's environment, never the engine's: `INHERITED_ENV_KEYS` and `extra`, from this process. */
function childEnv(extra: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [...INHERITED_ENV_KEYS, ...extra]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** 8MB is ample for a real result; a flooding child gets killed, not indulged. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * `child.kill()` signals only the direct process. A real agent spawns shells
 * and MCP servers as its own children, so a plain kill leaves them ticking
 * after a timeout — this kills the whole group instead, which is why the child
 * is spawned with `detached: true` (making it its own group leader) below.
 * Guarded because the child may already have exited by the time a second kill
 * path (timeout racing an EPIPE, say) reaches this.
 */
function killGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone; nothing left to signal.
  }
}

/** A path as the item panel shows it: relative to where the agent runs, when it is under it. */
export const shortPath = (path: string, cwd: string): string => (path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path);

/**
 * `landrace mcp` in the spellings a real configuration uses: the bin,
 * `npx landrace@<version>` or `landrace#<ref>`, the built `cli` entry with or
 * without its extension, the source entry, any of them quoted, with `--`
 * before the subcommand, or inside a shell's `-c` followed by `;`, `&` or `|`
 * — and in any case. Matched on the whole command line, so wrapping it in `sh`
 * hides nothing.
 *
 * Defence in depth over configuration the operator already trusts, not a
 * guarantee against every spelling: a wrapper script under another name gets
 * past it, and nothing could stop that short of running the server to ask.
 * Broad on purpose where it can be: refusing a server that merely resembles
 * it costs the operator a rename, and letting the real one through hands a
 * step agent the tools that move items.
 */
// In order: where a program name can start (the line, a space, a path
// separator, a quote or a shell operator); `landrace` with an npx-style
// version or ref, or the `cli` entry, built or source, with or without an
// extension; its closing quote, any `--` markers and `mcp`, quoted or not; and
// the end of that word (a space, the end, a quote or a shell operator).
const RUNS_OPERATOR =
  /(?:^|[\s/\\'"`;&|(])(?:landrace(?:[@#][^\s'"`;&|)]*)?|cli(?:[/\\]index)?(?:\.[cm]?[jt]s)?)['"`]?\s+(?:--\s+)*['"`]?mcp['"`]?(?=$|[\s;&|)'"`])/i;

const runsOperator = (server: McpServerConfig): boolean =>
  RUNS_OPERATOR.test([server.command ?? "", ...(server.args ?? [])].join(" "));

/** Said once, because both ways of naming the operator server are refused for the same reason. */
const operatorProblem = (name: string, how: string): Problem => ({
  rule: "mcp",
  message:
    `agent.mcp names "${name}", ${how} landrace's own operator server: its tools create, update and reply on ` +
    "items — a step holding them could move its own item — so operator tools must never reach a step agent",
});

const shapeProblem = (what: string): Problem => ({
  rule: "mcp",
  message:
    `agent.mcp names ${what}, which the agent's command line cannot carry as one name: ` +
    "use letters, digits, '.', '_' and '-', starting with a letter or digit",
});

/** Where `.mcp.json` departs from the one shape this file reads, or null. */
function mcpConfigProblem(raw: unknown): string | null {
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isRecord(raw) || !isRecord(raw["mcpServers"])) return "mcpServers: expected an object of servers";
  for (const [name, server] of Object.entries(raw["mcpServers"])) {
    if (!isRecord(server)) return `mcpServers.${name}: expected an object`;
    if (server["command"] !== undefined && typeof server["command"] !== "string") return `mcpServers.${name}.command: expected a string`;
    if (server["args"] !== undefined && !(Array.isArray(server["args"]) && server["args"].every((a) => typeof a === "string"))) {
      return `mcpServers.${name}.args: expected a list of strings`;
    }
    if (server["env"] !== undefined && !(isRecord(server["env"]) && Object.values(server["env"]).every((v) => typeof v === "string"))) {
      return `mcpServers.${name}.env: expected an object of strings`;
    }
  }
  return null;
}

/**
 * The servers `agent.mcp` allows, looked up by name in the repository root's
 * `.mcp.json` (or the file `fileOf` names there) — once, at startup, never per
 * step.
 *
 * The root and not the worktree a step runs in: the file is generated by
 * agsync and gitignored, so a worktree cut from HEAD never has it, and one
 * that did would be the repository's committed copy rather than the operator's.
 *
 * Every problem is a sentence about names and paths and nothing else. A
 * server's `env` or `args` may carry a credential, so neither is ever quoted —
 * and neither is the file's own text, which node's JSON.parse would otherwise
 * echo around a syntax error.
 */
export async function resolveStepServers(
  dir: string,
  entries: readonly McpEntry[],
  fileOf: (root: string) => string = (root) => join(root, ".mcp.json"),
): Promise<ResolvedMcp> {
  if (entries.length === 0) return { servers: {}, tools: {}, problems: [] };

  // Refused on the entries alone, before anything is read: these need no file
  // to be wrong, and a missing file must not hide them. A name reaches an
  // agent's argv inside a tool name or a config key, which a CLI splits on
  // spaces, commas or dots — a server or tool called "x Bash" could allow a
  // tool nobody listed — and `CHILD_SERVER_NAME` ("landrace") is both
  // agsync's name for the operator server and the name the engine gives a
  // step's create_child server: one spelling, so a step can never be handed a
  // second server under the one name its own create_child tool is trusted to
  // answer to.
  const nameOf = (entry: McpEntry): string => (typeof entry === "string" ? entry : entry.name);
  const names = entries.map(nameOf);
  // Two entries for one server could disagree about its tools, and choosing
  // one of them would be "first match wins".
  const repeated = new Set(names.filter((name, i) => names.indexOf(name) !== i));
  const problems: Problem[] = [...repeated].map((name) => ({
    rule: "mcp",
    message: `agent.mcp names "${name}" more than once; name it once, with every tool a step may use on it`,
  }));
  const rest: string[] = [];
  const tools: Record<string, string[]> = {};
  for (const entry of entries) {
    const name = nameOf(entry);
    const listed = typeof entry === "string" ? undefined : entry.tools;
    const badTools = (listed ?? []).filter((tool) => !ARG_SHAPE.test(tool));
    if (repeated.has(name)) continue;
    if (!ARG_SHAPE.test(name)) problems.push(shapeProblem(`a server named ${JSON.stringify(name)}`));
    else if (name === CHILD_SERVER_NAME) problems.push(operatorProblem(name, "which is"));
    else if (listed !== undefined && listed.length === 0) {
      problems.push({
        rule: "mcp",
        message:
          `agent.mcp names "${name}" with no tools, which would load the server and allow nothing on it; ` +
          "name it bare to allow every tool, or list the ones a step may use",
      });
    } else if (badTools.length) {
      problems.push(...badTools.map((tool) => shapeProblem(`a tool named ${JSON.stringify(tool)} on "${name}"`)));
    } else {
      rest.push(name);
      if (listed !== undefined) tools[name] = [...new Set(listed)];
    }
  }
  if (rest.length === 0) return { servers: {}, tools: {}, problems };

  const fail = (message: string): ResolvedMcp => ({ servers: {}, tools: {}, problems: [...problems, { rule: "mcp", message }] });

  let root: string;
  try {
    root = await repositoryRoot(dir);
  } catch (e) {
    return fail(`agent.mcp names servers to look up in the repository root's .mcp.json, and there is no repository: ${messageOf(e)}`);
  }
  const file = fileOf(root);

  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return fail(
      code === "ENOENT"
        ? `agent.mcp names ${rest.map((n) => `"${n}"`).join(", ")}, but ${file} does not exist; \`agsync sync\` generates it`
        : `agent.mcp names servers, and ${file} could not be read (${code ?? "unknown error"})`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail(`${file} is not valid JSON; \`agsync sync\` regenerates it`);
  }
  const shapeError = mcpConfigProblem(raw);
  if (shapeError) return fail(`${file} is not an MCP config landrace can read: ${shapeError}`);
  const defined = (raw as { mcpServers: Record<string, McpServerConfig> }).mcpServers;

  const servers: Record<string, McpServerConfig> = {};
  for (const name of rest) {
    const server = Object.hasOwn(defined, name) ? defined[name] : undefined;
    if (server === undefined) {
      const known = Object.keys(defined);
      problems.push({
        rule: "mcp",
        message:
          `agent.mcp names "${name}", which ${file} does not define` +
          (known.length ? ` — it defines ${known.join(", ")}` : " — it defines no servers"),
      });
    } else if (runsOperator(server)) {
      problems.push(operatorProblem(name, "whose command runs"));
    } else {
      servers[name] = server;
    }
  }
  return problems.length ? { servers: {}, tools: {}, problems } : { servers, tools, problems };
}

/**
 * An Authorization header's shape: one scheme token, then one credential with
 * no space in it (`Bearer <token>`, `Basic <base64>`). A value of several
 * words is prose, and its tail is no secret on its own.
 */
const AUTH_SCHEME = /^[A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]*\s+(\S+)$/;

/**
 * The values an allowlisted server's definition carries — every `env` and
 * `headers` value — for the log's redaction set.
 *
 * Both travel in the agent's argv, and an agent's CLI that fails to start a
 * server can echo them into its stderr, which reaches the log whole in an
 * `agent exited …` message. Which of them is a credential is not ours to know,
 * so all of them are redacted, except a value shorter than the logger will
 * redact by: "1" would take every digit out of every line.
 *
 * A header shaped `<scheme> <credential>` registers its credential alone as
 * well: a CLI reporting a failed server prints the token, or the header
 * re-spaced, as often as it quotes the value whole — and whole was the only
 * form redacted, so the token itself went through intact.
 */
export function mcpRedactionValues(servers: Readonly<Record<string, McpServerConfig>>): string[] {
  const values = new Set<string>();
  const add = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    if (trimmed.length >= MIN_SECRET_LENGTH) values.add(trimmed);
    return trimmed;
  };
  for (const server of Object.values(servers)) {
    for (const value of Object.values(server.env ?? {})) add(value);
    const headers = server["headers"];
    if (!headers || typeof headers !== "object") continue;
    for (const value of Object.values(headers as Record<string, unknown>)) {
      const whole = add(value);
      const credential = whole === undefined ? undefined : AUTH_SCHEME.exec(whole)?.[1];
      if (credential !== undefined) add(credential);
    }
  }
  return [...values];
}

/**
 * A step's `mcp` over what `agent.mcp` allows (`known`): the servers the step
 * loads and the tools on each, or why it cannot. It narrows and never
 * widens: a server or a tool outside `known` is refused, never added.
 */
function narrowMcp(entries: readonly McpEntry[], known: Readonly<AllowedTools>): { allowed: AllowedTools; problems: string[] } {
  const names = entries.map((e) => (typeof e === "string" ? e : e.name));
  // Two entries for one server could disagree about its tools.
  const repeated = new Set(names.filter((name, i) => names.indexOf(name) !== i));
  const problems = [...repeated].map((name) => `names MCP server "${name}" more than once`);
  const allowed: AllowedTools = {};
  for (const entry of entries) {
    const name = typeof entry === "string" ? entry : entry.name;
    const listed = typeof entry === "string" ? undefined : entry.tools;
    const has = Object.hasOwn(known, name) ? known[name] : undefined;
    if (repeated.has(name)) continue;
    if (has === undefined) {
      problems.push(`asks for MCP server "${name}", which agent.mcp does not name`);
    } else if (listed?.length === 0) {
      problems.push(`names MCP server "${name}" with no tools; leave it out to give the step none of it`);
    } else {
      // A server agent.mcp names bare allows every tool, so the step's names
      // meet no list there; they still reach argv, where "x Bash" would allow
      // a tool nobody listed.
      const badShape = (listed ?? []).filter((tool) => !ARG_SHAPE.test(tool));
      problems.push(...badShape.map((tool) =>
        `asks for tool ${JSON.stringify(tool)} on MCP server "${name}", which does not match the allowed shape for a command-line argument`));
      const outside = has === null ? [] : (listed ?? []).filter((tool) => ARG_SHAPE.test(tool) && !has.includes(tool));
      problems.push(...outside.map((tool) => `asks for tool "${tool}" on MCP server "${name}", which agent.mcp does not allow on it`));
      allowed[name] = listed === undefined ? has : [...new Set(listed)];
    }
  }
  return { allowed, problems };
}

/** The keys of `agent:` the kit reads for every integration, the engine's own three among them. */
const KIT_KEYS = ["adapter", "isolation", "worktree", "model", "effort", "mcp", "sandbox"];
/** The keys of `agent.sandbox`. */
const SANDBOX_KEYS = new Set(["hosts", "deny"]);

/**
 * What a write step's commands may not read when `agent.sandbox.deny` names
 * nothing: the forge CLI's token, ssh keys, cloud keys, a package registry's
 * token. A step with a shell is otherwise one `cat` away from each.
 */
export const DEFAULT_DENY: readonly string[] =["~/.config/gh", "~/.ssh", "~/.aws", "~/.npmrc"];

/**
 * A host a sandbox matches by name, optionally with its own leading `*.`.
 * `https://example.com` or `example.com:443` is a host it never matches, and a
 * step that cannot push finds that out an hour into a build.
 */
const HOST_SHAPE = /^(\*\.)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*$/;

/**
 * A path under HOME: the one form a sandbox's deny list and a read rule read
 * alike. A rule may read `/x` relative to its settings file, so an absolute
 * path could deny nothing, silently. Not `~/` itself or a trailing "/", and no
 * parentheses, which would end a rule early.
 *
 * No leading or trailing whitespace, and no control character (a newline or
 * tab, anywhere in the path, not only at an edge) — YAML lets either past a
 * hand-edited file unnoticed, and a path that gains one names something that
 * does not exist and denies nothing, which a *written* deny list then does in
 * place of the defaults it replaced. An inner space is still fine: it is how
 * a real macOS path reads (`~/Library/Application Support/x`).
 */
// eslint-disable-next-line no-control-regex -- excluding control chars is the point, not a leftover
const DENY_SHAPE = /^~\/[^\s()\x00-\x1F\x7F](?:[^()\x00-\x1F\x7F]*[^\s()/\x00-\x1F\x7F])?$/;

/** Why `value` is not a list of strings shaped like `shape`: that it is no list, or one line per entry, by index. */
function listProblems(name: string, value: unknown, shape: RegExp, what: string): string[] {
  if (!Array.isArray(value)) return [`${name} must be a list`];
  return value.flatMap((v: unknown, i) =>
    typeof v === "string" && shape.test(v) ? [] : [`${name}[${i}] is ${JSON.stringify(v)}; it must be ${what}`]);
}

/**
 * A coding agent behind the engine's `Executor` contract, as a factory the
 * loader classifies by its brand: `create(ctx)` reads `agent:` and resolves
 * `.mcp.json` once at startup, and `build(settings)` is the executor, whose
 * `run` and `handoff` are the templates below. `E` is the integration's own
 * settings, read by `readExtras` beside the kit's.
 */
export abstract class BaseExecutor<E extends object = Record<never, never>> implements ExecutorFactory {
  /** What `agent.adapter` names, and what the executor registers under. */
  abstract readonly id: string;
  /** The effort levels the agent takes. Any other is refused, at startup where a step names it, never dropped. */
  abstract readonly efforts: readonly string[];
  /** The ways a person can pair with the agent; none, and no pairing is offered. */
  abstract readonly pairings: readonly PairingKind[];
  /** Environment variables the agent needs beyond the kit's own few, passed through by name. Never a credential. */
  readonly envKeys: readonly string[] = [];
  /**
   * The step front-matter keys the integration enforces, in `RunPlan`. A step
   * naming any other is refused, at startup and on its run: one the agent
   * ignored would read as a limit the step does not have.
   */
  readonly stepKeys: readonly StepKey[] = [];

  constructor(readonly bin: string) {
    defineExecutor(this);
  }

  /** The command line after the binary, for a run the kit has already decided and checked. */
  protected abstract argv(plan: RunPlan<E>): string[];

  /**
   * Whatever the run needs in place before the agent starts, or a refusal.
   * Awaited before spawn, and the run's abort is checked again after it.
   */
  protected prepare?(plan: RunPlan<E>): Promise<void>;

  /** What one line of the agent's output, parsed, says. `cwd` is where the agent runs, for showing paths. */
  protected abstract readEvent(event: object, cwd: string): EventReading;

  /** The command a person runs to pair, for a pairing the kit has already checked this integration can do. */
  protected abstract handoffArgv(plan: HandoffPlan): Promise<HandoffArg[]>;

  /**
   * The integration's own `agent:` keys, read — with a default for each one
   * absent — or every reason they cannot be. The keys of `extras` are the
   * keys it reads; any other key the kit does not read is refused. Absent,
   * the integration reads none of its own.
   */
  protected readExtras?(agent: Record<string, unknown>): { extras: E; problems: string[] };

  /**
   * Why a well-formed `agent.sandbox` is one this agent cannot enforce: a
   * setting the operator wrote and the agent would not keep is refused at
   * startup, never run without. Absent, the agent enforces all of it.
   */
  protected sandboxProblems?(sandbox: SandboxSettings): string[];

  /**
   * Why skills a step lists are not ones the repository at `root` defines,
   * one sentence each, read after the step's path. Asked at startup, once per
   * step that lists any. Absent, nothing is checked.
   */
  protected skillProblems?(root: string, listed: readonly string[]): Promise<string[]>;

  private extrasOf(agent: Record<string, unknown>): { extras: E; problems: string[] } {
    return this.readExtras?.(agent) ?? { extras: {} as E, problems: [] };
  }

  /** Where `agent.mcp`'s servers are defined, under the repository root. */
  protected mcpFile(root: string): string {
    return join(root, ".mcp.json");
  }

  /**
   * `agent:` as this integration reads it, or every reason it cannot be used —
   * in one error, one line each, so an operator fixes them in one pass.
   */
  readSettings(agent: Record<string, unknown>): AgentSettings<E> {
    const { settings, problems } = this.read(agent);
    if (problems.length) throw new Error(problems.join("\n"));
    return settings;
  }

  private read(agent: Record<string, unknown>): { settings: AgentSettings<E>; problems: string[] } {
    const { extras, problems: extraProblems } = this.extrasOf(agent);
    const known = new Set([...KIT_KEYS, ...Object.keys(extras)]);
    const problems: string[] = [];
    for (const key of Object.keys(agent)) {
      if (!known.has(key)) problems.push(`agent.${key} is not a setting the ${this.id} executor reads`);
    }
    const { model, effort, mcp = [], sandbox = {} } = agent;
    if (model !== undefined && (typeof model !== "string" || model === "")) problems.push("agent.model must be a model name");
    if (effort !== undefined && !this.efforts.includes(effort as string)) problems.push(this.effortProblem("agent.effort is", effort));
    problems.push(...extraProblems);
    const entryOk = (e: unknown): boolean =>
      (typeof e === "string" && e !== "") ||
      (typeof e === "object" && e !== null && !Array.isArray(e) &&
        Object.keys(e).every((k) => k === "name" || k === "tools") &&
        typeof (e as { name?: unknown }).name === "string" && (e as { name: string }).name !== "" &&
        Array.isArray((e as { tools?: unknown }).tools) &&
        (e as { tools: unknown[] }).tools.every((t) => typeof t === "string" && t !== ""));
    // Named by index — a single "some entry is wrong" line sends an operator
    // counting server names by hand to find which one.
    if (!Array.isArray(mcp)) {
      problems.push("agent.mcp must be a list of server names, or { name, tools } with only those two keys");
    } else {
      mcp.forEach((e, i) => {
        if (!entryOk(e)) problems.push(`agent.mcp[${i}] must be a server name, or { name, tools } with only those two keys`);
      });
    }
    // Each key defaults on its own, and a list that is written replaces its
    // default: what the step is denied is what the file says.
    let hosts: unknown = [];
    let deny: unknown = DEFAULT_DENY;
    if (typeof sandbox !== "object" || sandbox === null || Array.isArray(sandbox)) {
      problems.push("agent.sandbox must be { hosts, deny }, with only those two keys");
    } else {
      const shaped: string[] = [];
      for (const key of Object.keys(sandbox)) {
        if (!SANDBOX_KEYS.has(key)) shaped.push(`agent.sandbox.${key} is not a setting the ${this.id} executor reads`);
      }
      const block = sandbox as { hosts?: unknown; deny?: unknown };
      // Not `??`: a bare "hosts:" in YAML parses as null, not absent, and every
      // other key here refuses null rather than reading it as its default.
      hosts = block.hosts === undefined ? [] : block.hosts;
      deny = block.deny === undefined ? DEFAULT_DENY : block.deny;
      shaped.push(
        ...listProblems("agent.sandbox.hosts", hosts, HOST_SHAPE, "a host name like example.com or *.npmjs.org, with no scheme, port or path"),
        ...listProblems("agent.sandbox.deny", deny, DENY_SHAPE, "a path under your home like ~/.ssh: starting with ~/, not ending in /, with no parentheses"),
      );
      // Only a sandbox that reads as meant can be asked whether it is kept.
      if (shaped.length === 0) shaped.push(...(this.sandboxProblems?.({ hosts: hosts as string[], deny: deny as string[] }) ?? []));
      problems.push(...shaped);
    }

    return {
      problems,
      settings: {
        ...(typeof model === "string" ? { model } : {}),
        ...(typeof effort === "string" ? { effort } : {}),
        ...extras,
        mcp: mcp as McpEntry[],
        // Read even when refused, so the problems above are the only thing thrown.
        sandbox: { hosts: Array.isArray(hosts) ? [...hosts] : [], deny: Array.isArray(deny) ? [...deny] : [] },
      } as AgentSettings<E>,
    };
  }

  private effortProblem(what: string, value: unknown): string {
    return `${what} ${JSON.stringify(value)}: the ${this.id} executor takes only ${this.efforts.join(", ")}`;
  }

  /**
   * The executor the engine builds at startup, from its own context: this
   * integration's settings, the repository the workflow is in, the steps it
   * will run, and the log whose redaction set an allowlisted server's env and
   * headers join — they travel in the agent's argv and can come back in its
   * stderr.
   */
  async create(ctx: ExecutorContext): Promise<Pick<Executor, "run" | "handoff">> {
    // `agent:` belongs to the step agent. When that is another executor, this
    // one was built only to screen (`security.adapter`), and the block — and
    // the steps' efforts — are in the other agent's vocabulary: reading them
    // here would refuse that agent's own keys at startup, or screen on its
    // model name. The screener's model arrives on each run from
    // `security.model`, and it gets no server whatever the block says.
    if (ctx.config.agent.adapter !== this.id) {
      const screener = this.build({
        servers: {}, tools: {}, sandbox: { hosts: [], deny: [...DEFAULT_DENY] }, log: ctx.log, ...this.extrasOf({}).extras,
      });
      return { run: screener.run };
    }

    const { settings, problems } = this.read(ctx.config.agent as Record<string, unknown>);
    // What `agent.mcp` allows, from its entries as written: a step's own is
    // checked against it here whether or not `.mcp.json` resolves.
    const known: AllowedTools = Object.fromEntries((Array.isArray(settings.mcp) ? settings.mcp as unknown[] : []).flatMap((e): Array<[string, readonly string[] | null]> =>
      typeof e === "string" ? [[e, null]]
      : typeof e === "object" && e !== null && Array.isArray((e as { tools?: unknown }).tools) ? [[(e as { name: string }).name, (e as { tools: string[] }).tools]]
      : []));
    const skilled: Array<[string, readonly string[]]> = [];
    for (const [path, step] of ctx.steps ?? []) {
      if (step.effort !== undefined && !this.efforts.includes(step.effort)) {
        problems.push(`${path} asks for effort ${JSON.stringify(step.effort)}, which the ${this.id} executor does not take: ${this.efforts.join(", ")}`);
      }
      for (const key of ["skills", "plugins"] as const) {
        if (step[key] !== undefined && !this.stepKeys.includes(key)) problems.push(`${path} lists ${key}:, which the ${this.id} executor cannot enforce`);
      }
      if (step.mcp !== undefined) problems.push(...narrowMcp(step.mcp, known).problems.map((p) => `${path} ${p}`));
      if (step.skills?.length && this.stepKeys.includes("skills")) skilled.push([path, step.skills]);
    }
    if (skilled.length && this.skillProblems) {
      try {
        const root = await repositoryRoot(ctx.dir);
        for (const [path, skills] of skilled) problems.push(...(await this.skillProblems(root, skills)).map((p) => `${path} ${p}`));
      } catch (e) {
        problems.push(`the steps' skills could not be checked: ${messageOf(e)}`);
      }
    }
    if (problems.length) throw new Error(problems.join("\n"));

    const { mcp, ...rest } = settings;
    const resolved = await resolveStepServers(ctx.dir, mcp, (root) => this.mcpFile(root));
    if (resolved.problems.length) throw new Error(resolved.problems.map((p) => `${p.rule}: ${p.message}`).join("\n"));
    ctx.redact(mcpRedactionValues(resolved.servers));
    const executor = this.build({ ...(rest as unknown as KitSettings & E), servers: resolved.servers, tools: resolved.tools, log: ctx.log });
    // Pairing only here, where `agent:` is this integration's: a screener
    // built from another agent's block is never the one a person pairs with.
    return { run: executor.run, ...(executor.handoff ? { handoff: executor.handoff } : {}) };
  }

  /**
   * The executor, from settings already read: a prompt and the run's options
   * in, `{ text, sessionId }` out. Unbranded: the integration itself is the
   * hook the loader classifies, and this is what a test can call directly.
   */
  build(settings: KitSettings & E): Executor {
    const {
      model, effort, servers: mcpServers, tools: mcpTools, sandbox, log, timeoutMs = FALLBACK_TIMEOUT_MS,
    } = settings;
    const extras = settings as unknown as E;

    const run: Executor["run"] = async (prompt, {
      round, resume, fork, cwd, capabilities, model: stepModel, effort: stepEffort, mcp: stepMcp, skills, plugins,
      timeoutMs: stepTimeoutMs, child: binding, onActivity, signal,
    }) => {
      if (signal.aborted) {
        // Nothing checked this before `spawn` in the first cut, so a run
        // cancelled before it started launched the (paid) agent anyway.
        throw new Error("agent aborted");
      }
      // Never resumed in place instead: the session asked to be forked is a
      // person's, and a turn added to it is one they did not take.
      if (fork && resume === undefined) throw new Error("cannot fork a session: none was named to resume");
      if (fork && !this.pairings.includes("fork")) {
        throw new Error(`cannot fork a session: the ${this.id} executor cannot, and resuming it in place would add a turn to it`);
      }

      // Fail closed on a word this executor cannot turn into a flag. Dropping
      // an unrecognised capability is how a step comes to declare a
      // restriction that the agent it runs does not actually have — the worst
      // of the three outcomes, because the file says otherwise.
      const refused = unknownCapabilities(capabilities);
      if (refused.length) {
        throw new Error(
          `refused capabilities ${refused.map((c) => JSON.stringify(c)).join(", ")}: ` +
          `this executor can enforce only ${CAPABILITIES.join(", ")}${retiredCapabilityPointers(refused)}`,
        );
      }

      // A step's declaration decides, and nothing widens it: there is no
      // operator-wide permission setting for a run to fall back on. A run that
      // declares nothing at all is the screener's, and gets less than any step.
      const declared = capabilities !== undefined;
      const tier: Tier = !declared ? "screen" : mayWriteRepo(capabilities) ? "write" : "read";
      // A permission, not an obligation: a turn that declares the word but was
      // handed no binding simply gets no tool.
      const bound = binding !== undefined && mayCreateItems(capabilities) ? binding : undefined;

      // The step's own declaration, or the operator's default when it made
      // none — checked here rather than at construction alone, because a
      // per-run value comes out of a repo file a contributor's PR can edit.
      const chosenModel = stepModel ?? model;
      // Effort the same way, for steps and turns only: the screener is built
      // from the same `agent:` block, and `agent.effort` is not its setting.
      const chosenEffort = declared ? stepEffort ?? effort : undefined;

      if (chosenModel !== undefined) assertArgShape("model", chosenModel);
      if (chosenEffort !== undefined && !this.efforts.includes(chosenEffort)) throw new Error(this.effortProblem("refused effort", chosenEffort));
      if (resume !== undefined) assertArgShape("resume", resume);
      const resolvedCwd = cwd !== undefined ? await assertCwd(cwd) : undefined;

      // The step's own, refused rather than dropped where this agent cannot
      // keep them, and the screener's never.
      for (const [key, value] of [["skills", skills], ["plugins", plugins]] as const) {
        if (declared && value !== undefined && !this.stepKeys.includes(key)) {
          throw new Error(`refused ${key}: the ${this.id} executor cannot enforce a step's own ${key}`);
        }
      }
      const known: AllowedTools = Object.fromEntries(Object.keys(mcpServers).map((name) => [name, mcpTools[name] ?? null]));
      let stepAllowed: AllowedTools = declared ? known : {};
      if (declared && stepMcp !== undefined) {
        const narrowed = narrowMcp(stepMcp, known);
        if (narrowed.problems.length) throw new Error(`refused the step's mcp: ${narrowed.problems.join("; ")}`);
        stepAllowed = narrowed.allowed;
      }

      const server = bound?.server;
      if (bound && server === undefined) {
        throw new Error("cannot give this step create_child: the engine handed no server to start for it");
      }
      const servers: Record<string, McpServerConfig> = Object.fromEntries(Object.keys(stepAllowed).map((name) => [name, mcpServers[name] as McpServerConfig]));
      if (server) {
        // An allowlisted server under the engine's own name would either be
        // silently replaced below — losing whichever of the two the operator
        // actually meant to run — or, the other way round, let an operator's
        // own server answer to the name a step trusts for create_child.
        // `resolveStepServers` already refuses this at startup; this is the
        // backstop for an executor built directly.
        if (Object.hasOwn(servers, server.name)) {
          throw new Error(`cannot give this step create_child: an allowlisted server is already named "${server.name}"`);
        }
        // The engine's server, as the engine described it: the binding is
        // already argv to a process the agent's CLI starts, not text in its
        // prompt, so nothing the agent says can file a child anywhere else.
        servers[server.name] = { command: server.command, args: server.args };
      }
      // A server whose entry listed tools allows exactly those; one named bare
      // allows every tool it has — which, for a server that can index or
      // delete, is a lot more than reading.
      const allowed: AllowedTools = Object.fromEntries(Object.keys(servers).map((name) =>
        [name, name === server?.name ? server.tools : stepAllowed[name] ?? null]));

      const plan: RunPlan<E> = {
        tier, fork: fork === true, servers, allowed, sandbox, extras,
        ...(declared && skills !== undefined ? { skills } : {}),
        ...(declared && plugins !== undefined ? { plugins } : {}),
        ...(chosenModel === undefined ? {} : { model: chosenModel }),
        ...(chosenEffort === undefined ? {} : { effort: chosenEffort }),
        ...(resume === undefined ? {} : { resume }),
        ...(resolvedCwd === undefined ? {} : { cwd: resolvedCwd }),
      };
      await this.prepare?.(plan);
      // Again past the last await: an abort that landed during them fired with
      // no listener yet, and the agent would have run on to its timeout (#33).
      if (signal.aborted) throw new Error("agent aborted");
      const args = this.argv(plan);

      return new Promise((resolve, reject) => {
        let child: ChildProcessWithoutNullStreams;
        try {
          // No shell, ever: an issue title or comment is attacker-controlled
          // text and must never be interpolated into a command line. The
          // prompt itself goes in on stdin below, never as an argv element —
          // argv is world-readable via `ps`, stdin is not. `detached: true`
          // makes this child the leader of its own process group so a
          // timeout or abort can kill the group, not just this one pid (see
          // killGroup above).
          child = spawn(this.bin, args, {
            stdio: ["pipe", "pipe", "pipe"],
            shell: false,
            detached: true,
            env: childEnv(this.envKeys),
            ...(resolvedCwd !== undefined ? { cwd: resolvedCwd } : {}),
          });
        } catch (e) {
          // Some malformed-but-existing binaries (wrong magic bytes, no
          // executable bit) make spawn() throw synchronously instead of
          // emitting the usual async 'error' event below — same failure,
          // same message, so the operator sees a named binary either way.
          return reject(new Error(`could not start "${this.bin}": ${messageOf(e)}`));
        }

        // stdout is read a line at a time and never kept whole: an agent
        // prints every tool's result too, and a long build's would otherwise
        // sit in memory until it ended. What is kept is the line still being
        // written, the first bytes for an error, and what the lines said.
        let pending = "";
        let head = "";
        let session: unknown = undefined;
        let text = "";
        let done = false;
        let failure: string | undefined;
        let err = "";
        let settled = false;
        const started = Date.now();
        const where = resolvedCwd ?? process.cwd();

        const onLine = (line: string): void => {
          if (!line.trim()) return;
          let event: unknown;
          try {
            event = JSON.parse(line);
          } catch {
            log?.("agent.event", { round, raw: line });
            return;
          }
          if (event === null || typeof event !== "object") return;
          const reading = this.readEvent(event, where);
          // Parsed, so a secret in it is a string the log's redactor sees
          // whole — not split across two chunks, nor escaped inside a JSON
          // line. A tool's result is never logged: it is the files the agent
          // read and the output of what it ran, and agent.event reaches
          // telemetry even without --debug.
          if (!reading.quiet) log?.("agent.event", { round, event });
          if ("session" in reading) session = reading.session;
          if (reading.text !== undefined) text = reading.text;
          if (reading.done) done = true;
          if (reading.error !== undefined) failure = reading.error;
          if (!onActivity) return;
          for (const a of reading.activity ?? []) onActivity({ kind: a.kind, text: a.text, at: Date.now() });
        };

        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          fn();
        };
        // The step's own limit when it named one, as with its model.
        const limit = stepTimeoutMs ?? timeoutMs;
        const timer = setTimeout(() => {
          killGroup(child);
          finish(() => reject(new Error(`agent exceeded ${limit}ms`)));
        }, limit);
        const onAbort = () => {
          killGroup(child);
          finish(() => reject(new Error("agent aborted")));
        };
        signal.addEventListener("abort", onAbort, { once: true });

        // A prompt over ~64KB (an issue body plus a diff is the normal case,
        // not an edge case) is still being written when a timeout or abort
        // kills the child mid-write. The child's end of the pipe closes
        // under it, the pending write raises EPIPE here, and an unhandled
        // 'error' event on a stream throws — taking the whole orchestrator
        // process down with it, not just this one promise. `finish` is a
        // no-op once settled, so when this races the timeout/abort rejection
        // above it just prevents the crash; when nothing else has settled
        // yet, it is the actual, informative rejection reason.
        child.stdin.on("error", (e) => {
          finish(() => reject(new Error(`agent closed its input before the prompt finished writing: ${e.message}`)));
        });

        // Decoded as a stream, so a character split across two chunks is not
        // two broken halves.
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          if (head.length < 200) head += chunk.slice(0, 200 - head.length);
          const lines = (pending + chunk).split("\n");
          pending = lines.pop() ?? "";
          // The cap is on the one line still being written: a runaway that
          // never ends a line is killed here rather than grown without bound.
          if (pending.length > MAX_OUTPUT_BYTES) {
            killGroup(child);
            finish(() => reject(new Error(`agent produced more than ${MAX_OUTPUT_BYTES} bytes of output`)));
            return;
          }
          // A throw from a data handler would take the whole process down,
          // not this run: what reports activity must never be able to.
          for (const line of lines) {
            try {
              onLine(line);
            } catch {
              // Display only.
            }
          }
        });
        child.stderr.on("data", (d: Buffer) => {
          // Rejected before concatenating: a runaway child's flood is capped
          // at the boundary, not after building a string large enough to
          // throw `RangeError: Invalid string length` from inside this
          // handler — which, like the EPIPE above, would crash the process
          // rather than reject the promise.
          if (err.length + d.length > MAX_OUTPUT_BYTES) {
            killGroup(child);
            finish(() => reject(new Error(`agent produced more than ${MAX_OUTPUT_BYTES} bytes of stderr`)));
            return;
          }
          err += d.toString();
        });

        child.on("error", (e) =>
          finish(() => reject(new Error(`could not start "${this.bin}": ${e.message}`))),
        );

        child.on("close", (code) =>
          finish(() => {
            // The last line, with or without a newline after it.
            try {
              onLine(pending);
            } catch {
              // Display only; what the lines said is read below either way.
            }
            // The agent's own account of a failure first: it says more than
            // the exit code it leaves beside it.
            if (failure !== undefined) return reject(new Error(failure));
            if (code !== 0) {
              return reject(new Error(`agent exited ${code}: ${err.trim().slice(0, 400)}`));
            }
            if (!done) {
              return reject(new Error(`agent did not return json with a result: ${head}`));
            }
            // Read validity before completeness: a session id that resolves
            // to a number today would pass the argv guard whole on the next
            // round's resume, having never been the string the type says it
            // is.
            if (session !== undefined && typeof session !== "string") {
              return reject(new Error(`agent returned a malformed session_id: expected a string, got ${typeof session}`));
            }
            // With the model that was actually on the command line. The
            // engine records what the step *asked* for and has no way of
            // checking it — nothing observable survives a subprocess to say
            // which model it used. This layer built the argv, so this is the
            // one place the answer is known at all, and saying it here is
            // what lets an operator read a step's request against what it
            // got. `null`, not an omission, for a run neither the step nor
            // the operator named a model for: the CLI's own default decided,
            // which is a fact rather than a missing one.
            log?.("step.completed", { round, ms: Date.now() - started, model: chosenModel ?? null, effort: chosenEffort ?? null });
            // Untrusted from here on: this text was produced by the agent,
            // not by us, and the caller will parse it for control markers —
            // it inherits no trust from having passed through this executor.
            resolve({ text: text.trim(), sessionId: (session as string | undefined) ?? null });
          }),
        );

        child.stdin.end(prompt);
      });
    };

    /*
     * The command a person runs to pair: checked here, written out by the
     * integration. Absent when the integration declares no way to pair.
     */
    const handoff: NonNullable<Executor["handoff"]> = async ({ cwd, session, promptFile, resume, server }) => {
      assertArgShape("session", session);
      if (resume !== undefined) assertArgShape("resume", resume);
      const kind = resume === undefined ? "take" : "continue";
      if (!this.pairings.includes(kind)) {
        throw new Error(kind === "take"
          ? `cannot pair from scratch: the ${this.id} executor can only carry on the agent's own session on this stage, ` +
            "and the agent has not run it yet. Release the pairing; once the agent has run the step, pairing continues its session"
          : `cannot continue the agent's session: the ${this.id} executor pairs only from scratch. ` +
            "Release the pairing, and pair once the agent has no session on this stage");
      }
      const where = await assertCwd(cwd);
      // The seed may go into the command as a positional, where a leading "-"
      // would be read as a flag instead.
      if ((await readFile(promptFile, "utf8")).startsWith("-")) {
        throw new Error("refused a prompt that starts with \"-\": the command line would read it as a flag");
      }
      const argv = await this.handoffArgv({
        kind, cwd: where, session, promptFile,
        ...(resume === undefined ? {} : { resume }),
        ...(server === undefined ? {} : { server }),
      });
      return { argv, cwd: where };
    };

    const pairs = this.pairings.includes("take") || this.pairings.includes("continue");
    return { id: this.id, run, ...(pairs ? { handoff } : {}) };
  }
}
