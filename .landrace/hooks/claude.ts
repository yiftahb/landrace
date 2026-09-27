/*
 * This project's coding agent: Claude Code's `claude -p`, driven for the
 * engine through the `Executor` contract. Everything Claude-specific lives
 * here — the command line per capability, plugin ids, `.mcp.json` servers —
 * so the engine never learns which agent runs. A project on another agent
 * writes its own file against the same contract.
 *
 * `landrace/hooks` resolves here by Node's package self-reference, as it does
 * for hooks/github.ts: run `pnpm build` before the CLI runs out of this
 * repository.
 */
import { execFile, spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import {
  CAPABILITIES,
  CHILD_SERVER_NAME,
  defineExecutor,
  mayCreateTickets,
  mayWriteRepo,
  unknownCapabilities,
  type Executor,
  type ExecutorFactory,
} from "landrace/hooks";

/** One server as `.mcp.json` defines it, passed on whole: only what the checks read is named. */
interface McpServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}
/** One `agent.mcp` entry: a server's bare name, or its name and the only tools a step may call on it. */
type McpEntry = string | { name: string; tools: string[] };
interface Problem { rule: string; message: string }
interface ResolvedMcp { servers: Record<string, McpServer>; tools: Record<string, string[]>; problems: Problem[] }
/** This hook's settings, read out of the `agent:` block the engine passes on unread. */
export interface ClaudeSettings { model?: string; plugins: string[]; mcp: McpEntry[] }
type HookLog = (event: string, data?: Record<string, unknown>) => void;

/** A thrown value's message, whatever was thrown. */
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** The shortest value worth redacting: shorter matches everywhere. The engine's logger skips these too. */
const MIN_SECRET_LENGTH = 8;
/** A backstop only: the engine gives every run a limit. */
const FALLBACK_TIMEOUT_MS = 10 * 60_000;
const exec = promisify(execFile);

/**
 * A value that begins with "-" lands in a flag slot no matter which argv
 * index it occupies — `--model -x` makes the CLI read "-x" as the next flag,
 * not as the model name. Passing a value as its own array element (instead
 * of interpolating it into a shell string) rules out one class of attack and
 * not the other, so every value that reaches argv is checked against the
 * shape it is actually allowed to have, not merely isolated.
 */
export const ARG_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The CLI's tools that edit a file or run a command: what a read-only step is denied by name. */
const WRITE_TOOLS = ["Bash", "Edit", "MultiEdit", "NotebookEdit", "Write"] as const;

function assertArgShape(kind: string, value: string): void {
  if (!ARG_SHAPE.test(value)) {
    throw new Error(`refused ${kind} ${JSON.stringify(value)}: does not match the allowed shape for a claude CLI argument`);
  }
}

async function assertCwd(cwd: string): Promise<string> {
  const refuse = (why: string): never => { throw new Error(`refused cwd ${JSON.stringify(cwd)}: ${why}`); };
  if (!isAbsolute(cwd)) refuse("must be an absolute path");
  if (cwd.includes("\\")) refuse("contains a backslash");
  if (cwd.includes("%")) refuse("is percent-encoded");
  const dotted = cwd.split("/").find((seg) => /^\.{2,}$/.test(seg));
  if (dotted !== undefined) refuse(`contains a "${dotted}" segment`);
  try {
    return await realpath(cwd);
  } catch (e) {
    return refuse((e as NodeJS.ErrnoException).code === "ENOENT" ? "does not exist" : `cannot be resolved: ${messageOf(e)}`);
  }
}

/** The repository root a step's `.mcp.json` lookup and its cwd are both relative to. */
async function repositoryRoot(dir: string): Promise<string> {
  try {
    const { stdout } = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: dir });
    return stdout.trim();
  } catch {
    throw new Error(`${dir} is not inside a git repository`);
  }
}

/**
 * The env vars a subprocess needs to run at all (locate its own binary,
 * find $HOME for its own credential store, resolve a temp dir) — never the
 * parent's full environment. `spawn` inherits `process.env` wholesale by
 * default, and this project's own secrets arrive as resolved values handed
 * to hooks (see HookContext), not as environment variables — so the one way
 * a credential could reach the agent's subprocess is exactly this default,
 * which is why it is never used here. USER/LOGNAME/SHELL were missing from
 * the first cut: the real CLI's credential lookup needs USER, and the
 * agent's own Bash tool needs SHELL — without them every real invocation
 * failed closed as "Not logged in", which is safe but useless.
 */
const INHERITED_ENV_KEYS = [
  "PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP",
  "USER", "LOGNAME", "SHELL",
  "SystemRoot", "SystemDrive",
];

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** 8MB is ample for a real result; a flooding child gets killed, not indulged. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * `child.kill()` signals only the direct process. A real `claude` spawns
 * bash and MCP servers as its own children, so a plain kill leaves them
 * ticking after a timeout — this kills the whole group instead, which is
 * why the child is spawned with `detached: true` (making it its own group
 * leader) below. Guarded because the child may already have exited by the
 * time a second kill path (timeout racing an EPIPE, say) reaches this.
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

/**
 * The agent contract is four arguments wide on purpose: prompt in,
 * {text, sessionId} out. Coarse observability instead of session telemetry is
 * the price of being able to swap the agent for a different one.
 */
export function createClaudeExecutor(opts: {
  model?: string;
  timeoutMs?: number;
  bin?: string;
  log?: HookLog;
  /**
   * Plugin ids (`name@marketplace`) enabled for every declared run.
   * `--restricted` ignores the operator's own settings, and with them every
   * plugin enabled there, so a read-only step would otherwise have none.
   */
  plugins?: readonly string[];
  /**
   * The MCP servers a declared run may use, by name, as the repository root's
   * `.mcp.json` defines them — resolved and vetted once at startup by
   * `resolveStepServers` below, which is where a name that argv could not
   * carry whole, or that collides with the child server's, is refused. Never
   * read from the worktree the agent runs in.
   */
  mcpServers?: Readonly<Record<string, McpServer>>;
  /** Per server, the only tools a run may call on it; a server absent here allows every tool it has. */
  mcpTools?: Readonly<Record<string, readonly string[]>>;
} = {}): Executor {
  const {
    model,
    timeoutMs = FALLBACK_TIMEOUT_MS,
    bin = "claude",
    log,
    plugins = [],
    mcpServers = {},
    mcpTools = {},
  } = opts;

  const run: Executor["run"] = async (prompt, { round, resume, cwd, capabilities, model: stepModel, timeoutMs: stepTimeoutMs, child: binding, signal }) => {
    if (signal.aborted) {
      // Nothing checked this before `spawn` in the first cut, so a run
      // cancelled before it started launched the (paid) agent anyway.
      throw new Error("agent aborted");
    }

    // Fail closed on a word this executor cannot turn into a flag. Dropping
    // an unrecognised capability is how a step comes to declare a
    // restriction that the agent it runs does not actually have — the worst
    // of the three outcomes, because the file says otherwise.
    const refused = unknownCapabilities(capabilities);
    if (refused.length) {
      throw new Error(
        `refused capabilities ${refused.map((c) => JSON.stringify(c)).join(", ")}: ` +
        `this executor can enforce only ${CAPABILITIES.join(", ")}`,
      );
    }

    // A step's declaration decides, and nothing widens it: there is no
    // operator-wide permission setting for a run to fall back on. A run that
    // declares nothing at all is the screener's, and gets less than any step.
    const declared = capabilities !== undefined;
    const mayWrite = mayWriteRepo(capabilities);
    // A permission, not an obligation: a turn that declares the word but was
    // handed no binding simply gets no tool.
    const bound = binding !== undefined && mayCreateTickets(capabilities) ? binding : undefined;
    // Not plan mode, which is what a read-only step and the screener ran in
    // until a live check against the real CLI (2.1.282) showed what it
    // cost: plan mode refuses every MCP call — create_child and every
    // allowlisted server alike — and ignored `--model`, running sonnet for
    // a step (or a screener) that asked for haiku. So anything that may not
    // write runs in the CLI's default mode, `manual`.
    const mode = mayWrite ? "acceptEdits" : "manual";
    // `--restricted` removes the tools that run commands or code (Bash and
    // the rest) and WebFetch, and ignores the operator's user, project and
    // local settings. It does not remove Edit or Write: the deny list does
    // that, for a read-only step, and `--tools ""` removes every built-in
    // tool for the screener. The same live check refused a write attempted
    // under the read-only step's flags. A step that may write keeps all of
    // them, and the operator's settings with them.
    const restricted = !mayWrite;
    const denyWrites = declared && !mayWrite;

    // The step's own declaration, or the operator's default when it made
    // none — checked here rather than at construction alone, because a
    // per-run value comes out of a repo file a contributor's PR can edit.
    const chosenModel = stepModel ?? model;

    if (chosenModel !== undefined) assertArgShape("model", chosenModel);
    if (resume !== undefined) assertArgShape("resume", resume);
    const resolvedCwd = cwd !== undefined ? await assertCwd(cwd) : undefined;

    const server = bound?.server;
    if (bound && server === undefined) {
      throw new Error("cannot give this step create_child: the engine handed no server to start for it");
    }

    // json output carries session_id; without it a conversation cannot continue.
    const args = ["-p", "--output-format", "json", "--permission-mode", mode];
    if (restricted) args.push("--restricted");
    // A run that declares nothing is the screener's, and it reads
    // attacker-reachable text for a living: no built-in tool at all, not
    // even Read. Variadic, and the empty list must not swallow what follows
    // — a flag always does, since `--mcp-config` is pushed below whatever
    // else is.
    if (!declared) args.push("--tools", "");
    // Variadic like `--allowedTools`: the next flag ends it.
    if (denyWrites) args.push("--disallowedTools", ...WRITE_TOOLS);
    if (chosenModel !== undefined) args.push("--model", chosenModel);
    if (resume !== undefined) args.push("--resume", resume);
    // Plugins and servers are for steps and turns, never the screener: a
    // plugin that speaks up at session start would be speaking to the one
    // agent whose only job is to judge a prompt.
    if (declared && plugins.length) {
      // One argv element holding the JSON: `--restricted` ignores the
      // operator's own settings file, so this is the only way a plugin
      // enabled there reaches a read-only step at all.
      args.push("--settings", JSON.stringify({ enabledPlugins: Object.fromEntries(plugins.map((id) => [id, true])) }));
    }
    const servers: Record<string, unknown> = declared ? { ...mcpServers } : {};
    if (server) {
      // An allowlisted server under the engine's own name would either be
      // silently replaced below — losing whichever of the two the operator
      // actually meant to run — or, the other way round, let an operator's
      // own server answer to the name a step trusts for create_child.
      // `resolveStepServers` (below) already refuses this at startup for
      // the shipped executor; this is the backstop for an executor built
      // directly, as every test here does.
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
    const allowed = [
      ...Object.keys(servers)
        .filter((name) => name !== server?.name)
        .flatMap((name) => mcpTools[name]?.map((tool) => `mcp__${name}__${tool}`) ?? [`mcp__${name}`]),
      ...(server ? server.tools.map((tool) => `mcp__${server.name}__${tool}`) : []),
    ];
    // Inline JSON rather than a config file: there is no path for the
    // agent's worktree to shadow and nothing to clean up after a crash.
    // Strict always, for every run and with nothing to allow as much as with
    // something: a `.mcp.json` committed to the repository the worktree is
    // cut from, or the operator's own user-level servers, would otherwise
    // load beside the agent — landrace's own operator server among them,
    // which can move a step's own ticket. The child server reads the
    // workflow's own .env and holds no secret; an allowlisted server's `env`
    // goes as `.mcp.json` wrote it, and is visible in `ps` for as long as
    // the step runs.
    //
    // `--mcp-config` is variadic, so a flag follows it; so is
    // `--allowedTools`, so it goes last with nothing after it.
    args.push("--mcp-config", JSON.stringify({ mcpServers: servers }), "--strict-mcp-config");
    if (allowed.length) args.push("--allowedTools", ...allowed);

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
        child = spawn(bin, args, {
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
          detached: true,
          env: childEnv(),
          ...(resolvedCwd !== undefined ? { cwd: resolvedCwd } : {}),
        });
      } catch (e) {
        // Some malformed-but-existing binaries (wrong magic bytes, no
        // executable bit) make spawn() throw synchronously instead of
        // emitting the usual async 'error' event below — same failure,
        // same message, so the operator sees a named binary either way.
        return reject(new Error(`could not start "${bin}": ${messageOf(e)}`));
      }

      let out = "";
      let err = "";
      let settled = false;
      const started = Date.now();

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

      const capture = (
        chunk: Buffer,
        get: () => string,
        set: (v: string) => void,
        label: string,
      ): boolean => {
        if (get().length + chunk.length > MAX_OUTPUT_BYTES) {
          // Reject before concatenating: a runaway child's flood is capped
          // at the boundary, not after building a string large enough to
          // throw `RangeError: Invalid string length` from inside this
          // handler — which, like the EPIPE above, would crash the process
          // rather than reject the promise, and the 4-minute timeout never
          // gets a chance to fire because this throws long before then.
          killGroup(child);
          finish(() => reject(new Error(`agent produced more than ${MAX_OUTPUT_BYTES} bytes of ${label}`)));
          return true;
        }
        set(get() + chunk.toString());
        return false;
      };

      child.stdout.on("data", (d: Buffer) => {
        if (capture(d, () => out, (v) => (out = v), "output")) return;
        log?.("agent.event", { round, raw: d.toString() });
      });
      child.stderr.on("data", (d: Buffer) => {
        capture(d, () => err, (v) => (err = v), "stderr");
      });

      child.on("error", (e) =>
        finish(() => reject(new Error(`could not start "${bin}": ${e.message}`))),
      );

      child.on("close", (code) =>
        finish(() => {
          if (code !== 0) {
            return reject(new Error(`agent exited ${code}: ${err.trim().slice(0, 400)}`));
          }
          let parsed: { is_error?: boolean; result?: unknown; session_id?: unknown };
          try {
            parsed = JSON.parse(out) as typeof parsed;
          } catch {
            return reject(new Error(`agent did not return json: ${out.slice(0, 200)}`));
          }
          if (parsed.is_error) {
            return reject(new Error(`agent reported an error: ${String(parsed.result ?? "")}`));
          }
          // Read validity before completeness: a session_id that resolves
          // to a number today would pass the argv guard whole on the next
          // round's --resume, having never been the string the type says
          // it is.
          if (parsed.session_id !== undefined && typeof parsed.session_id !== "string") {
            return reject(
              new Error(`agent returned a malformed session_id: expected a string, got ${typeof parsed.session_id}`),
            );
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
          log?.("step.completed", { round, ms: Date.now() - started, model: chosenModel ?? null });
          // Untrusted from here on: this text was produced by the agent,
          // not by us, and the caller will parse it for control markers —
          // it inherits no trust from having passed through this executor.
          resolve({ text: String(parsed.result ?? "").trim(), sessionId: parsed.session_id ?? null });
        }),
      );

      child.stdin.end(prompt);
    });
  };

  // Unbranded: only the exported `claude` factory below is the hook the
  // loader classifies. This is a plain constructor a test can call directly.
  return { id: "claude", run };
}

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
 * step agent the tools that move tickets.
 */
// In order: where a program name can start (the line, a space, a path
// separator, a quote or a shell operator); `landrace` with an npx-style
// version or ref, or the `cli` entry, built or source, with or without an
// extension; its closing quote, any `--` markers and `mcp`, quoted or not; and
// the end of that word (a space, the end, a quote or a shell operator).
const RUNS_OPERATOR =
  /(?:^|[\s/\\'"`;&|(])(?:landrace(?:[@#][^\s'"`;&|)]*)?|cli(?:[/\\]index)?(?:\.[cm]?[jt]s)?)['"`]?\s+(?:--\s+)*['"`]?mcp['"`]?(?=$|[\s;&|)'"`])/i;

const runsOperator = (server: McpServer): boolean =>
  RUNS_OPERATOR.test([server.command ?? "", ...(server.args ?? [])].join(" "));

/** Said once, because both ways of naming the operator server are refused for the same reason. */
const operatorProblem = (name: string, how: string): Problem => ({
  rule: "mcp",
  message:
    `agent.mcp names "${name}", ${how} landrace's own operator server: its tools create, update and reply on ` +
    "tickets — a step holding them could move its own ticket — so operator tools must never reach a step agent",
});

const shapeProblem = (what: string): Problem => ({
  rule: "mcp",
  message:
    `agent.mcp names ${what}, which the agent's command line cannot carry as one name: ` +
    "use letters, digits, '.', '_' and '-', starting with a letter or digit",
});

/** Where `.mcp.json` departs from the one shape this file reads, or null. Hand-checked: a copied hook has no zod. */
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
 * `.mcp.json` — once, at startup, never per step.
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
export async function resolveStepServers(dir: string, entries: readonly McpEntry[]): Promise<ResolvedMcp> {
  if (entries.length === 0) return { servers: {}, tools: {}, problems: [] };

  // Refused on the entries alone, before anything is read: these need no file
  // to be wrong, and a missing file must not hide them. A name reaches the
  // agent's argv as `mcp__<name>[__<tool>]` in `--allowedTools`, which the CLI
  // splits on spaces and commas — a server or tool called "x Bash" would allow
  // Bash — and `CHILD_SERVER_NAME` ("landrace") is both agsync's name for the
  // operator server and the name the engine gives a step's create_child
  // server: one spelling, so a step can never be handed a second server
  // under the one name its own create_child tool is trusted to answer to.
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
  const file = join(root, ".mcp.json");

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
  const defined = (raw as { mcpServers: Record<string, McpServer> }).mcpServers;

  const servers: Record<string, McpServer> = {};
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
 * The values an allowlisted server's definition carries — every `env` and
 * `headers` value — for the log's redaction set.
 *
 * Both travel in the agent's argv, and an agent's CLI that fails to start a
 * server can echo them into its stderr, which reaches the log whole in an
 * `agent exited …` message. Which of them is a credential is not ours to know,
 * so all of them are redacted, except a value shorter than the logger will
 * redact by: "1" would take every digit out of every line.
 */
export function mcpRedactionValues(servers: Readonly<Record<string, McpServer>>): string[] {
  const values = new Set<string>();
  for (const server of Object.values(servers)) {
    const headers = server["headers"];
    const carried = [
      ...Object.values(server.env ?? {}),
      ...(headers && typeof headers === "object" ? Object.values(headers as Record<string, unknown>) : []),
    ];
    for (const value of carried) {
      if (typeof value === "string" && value.trim().length >= MIN_SECRET_LENGTH) values.add(value.trim());
    }
  }
  return [...values];
}

/** The keys of `agent:` this hook reads, beside the engine's own two. */
const SETTING_KEYS = new Set(["adapter", "isolation", "model", "plugins", "mcp"]);

/**
 * This hook's settings out of the `agent:` block, or every reason they
 * cannot be used — in one error, so an operator fixes them in one pass.
 */
export function readClaudeSettings(agent: Record<string, unknown>): ClaudeSettings {
  const problems: string[] = [];
  for (const key of Object.keys(agent)) {
    if (!SETTING_KEYS.has(key)) problems.push(`agent.${key} is not a setting the claude executor reads`);
  }
  const { model, plugins = [], mcp = [] } = agent;
  if (model !== undefined && (typeof model !== "string" || model === "")) problems.push("agent.model must be a model name");
  const pluginsOk = Array.isArray(plugins) && plugins.every((p) => typeof p === "string" && p !== "");
  if (!pluginsOk) problems.push('agent.plugins must be a list of plugin ids, like "name@marketplace"');
  const entryOk = (e: unknown): boolean =>
    (typeof e === "string" && e !== "") ||
    (typeof e === "object" && e !== null && !Array.isArray(e) &&
      Object.keys(e).every((k) => k === "name" || k === "tools") &&
      typeof (e as { name?: unknown }).name === "string" && (e as { name: string }).name !== "" &&
      Array.isArray((e as { tools?: unknown }).tools) &&
      (e as { tools: unknown[] }).tools.every((t) => typeof t === "string" && t !== ""));
  const mcpOk = Array.isArray(mcp) && mcp.every(entryOk);
  if (!mcpOk) problems.push("agent.mcp must be a list of server names, or { name, tools } with only those two keys");
  if (problems.length) throw new Error(problems.join("\n"));
  return {
    ...(typeof model === "string" ? { model } : {}),
    plugins: plugins as string[],
    mcp: mcp as McpEntry[],
  };
}

/**
 * The executor the engine builds at startup, from its own context: this
 * hook's settings, the repository the workflow is in, and the log whose
 * redaction set an allowlisted server's env and headers join — they travel in
 * the agent's argv and can come back in its stderr.
 */
export const claude: ExecutorFactory = defineExecutor({
  id: "claude",
  async create(ctx) {
    const settings = readClaudeSettings(ctx.config.agent as Record<string, unknown>);
    const { servers, tools, problems } = await resolveStepServers(ctx.dir, settings.mcp);
    if (problems.length) throw new Error(problems.map((p) => `${p.rule}: ${p.message}`).join("\n"));
    ctx.redact(mcpRedactionValues(servers));
    const executor: Executor = createClaudeExecutor({
      ...(settings.model === undefined ? {} : { model: settings.model }),
      log: ctx.log,
      plugins: settings.plugins,
      mcpServers: servers,
      mcpTools: tools,
    });
    return { run: executor.run };
  },
});
