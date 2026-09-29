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
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
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
/** What a write step's commands may reach: the only hosts on the network, and the paths under HOME they may not read. */
export interface SandboxSettings { hosts: string[]; deny: string[] }
/** This hook's settings, read out of the `agent:` block the engine passes on unread. */
export interface ClaudeSettings { model?: string; effort?: string; plugins: string[]; mcp: McpEntry[]; sandbox: SandboxSettings }
type HookLog = (event: string, data?: Record<string, unknown>) => void;

/**
 * This executor's id: what it registers under and what `agent.adapter` names
 * when `agent:` is its block to read — one constant, so the two cannot drift.
 */
const ID = "claude";
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

/** The levels `claude --effort` takes. Any other value is refused, never dropped: a step that asked for one must get it. */
const EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];
const effortProblem = (what: string, value: unknown): string =>
  `${what} ${JSON.stringify(value)}: the claude executor takes only ${EFFORTS.join(", ")}`;

/** The CLI's tools that edit a file or run a command: what a read-only step is denied by name. */
const WRITE_TOOLS = ["Bash", "Edit", "MultiEdit", "NotebookEdit", "Write"] as const;

function assertArgShape(kind: string, value: string): void {
  if (!ARG_SHAPE.test(value)) {
    throw new Error(`refused ${kind} ${JSON.stringify(value)}: does not match the allowed shape for a claude CLI argument`);
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
 * Reproduced directly rather than importing the engine's file, which is a
 * copied hook's whole reason for existing.
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
 * The repository root a step's `.mcp.json` lookup and its cwd are both
 * relative to. git's own stderr rides along rather than a generic guess: a
 * checkout git refuses for "dubious ownership", or a missing git binary
 * entirely, would otherwise both be misreported as "not inside a git
 * repository" — a fix that isn't there to make, since neither one is that.
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

/** One tool call as the ticket panel shows it: its name and that argument, relative to where the agent runs. */
function toolLine(name: string, input: unknown, cwd: string): string {
  const args = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const key = TOOL_ARGS.find((k) => typeof args[k] === "string" && args[k] !== "");
  if (key === undefined) return name;
  const arg = args[key] as string;
  return `${name} ${arg.startsWith(`${cwd}/`) ? arg.slice(cwd.length + 1) : arg}`;
}

/**
 * `claude -p` behind the engine's `Executor` contract: a prompt and the run's
 * options in, `{ text, sessionId }` out. Coarse observability instead of
 * session telemetry is the price of being able to swap the agent for another
 * hook.
 */
export function createClaudeExecutor(opts: {
  model?: string;
  /** The operator's effort for every step and turn; the screener never gets one. One of EFFORTS. */
  effort?: string;
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
  /**
   * What a run that may write reaches, as `sandboxSettings` below turns it
   * into Claude Code's own settings. Absent, `readClaudeSettings`' defaults:
   * no network, and DEFAULT_DENY.
   *
   * Not re-validated here: `readClaudeSettings` is the one path that shapes
   * an operator's YAML into this, and the factory below is the only caller
   * the engine ever reaches this constructor through.
   */
  sandbox?: SandboxSettings;
  /** Whose `~/.claude` a pairing's sessions are looked up in. The operator's own, but for a test. */
  home?: string;
} = {}): Executor {
  const {
    model,
    effort,
    timeoutMs = FALLBACK_TIMEOUT_MS,
    bin = "claude",
    log,
    plugins = [],
    mcpServers = {},
    mcpTools = {},
    sandbox = { hosts: [], deny: [...DEFAULT_DENY] },
    home = homedir(),
  } = opts;

  const run: Executor["run"] = async (prompt, { round, resume, fork, cwd, capabilities, model: stepModel, effort: stepEffort, timeoutMs: stepTimeoutMs, child: binding, onActivity, signal }) => {
    if (signal.aborted) {
      // Nothing checked this before `spawn` in the first cut, so a run
      // cancelled before it started launched the (paid) agent anyway.
      throw new Error("agent aborted");
    }
    // Never resumed in place instead: the session asked to be forked is a
    // person's, and a turn added to it is one they did not take.
    if (fork && resume === undefined) throw new Error("cannot fork a session: none was named to resume");

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
    // them, and the operator's settings with them — every command it runs
    // confined by the sandbox (see `sandboxSettings`).
    const restricted = !mayWrite;
    const denyWrites = declared && !mayWrite;

    // The step's own declaration, or the operator's default when it made
    // none — checked here rather than at construction alone, because a
    // per-run value comes out of a repo file a contributor's PR can edit.
    const chosenModel = stepModel ?? model;
    // Effort the same way, for steps and turns only: the screener is built
    // from the same `agent:` block, and `agent.effort` is not its setting.
    const chosenEffort = declared ? stepEffort ?? effort : undefined;

    if (chosenModel !== undefined) assertArgShape("model", chosenModel);
    if (chosenEffort !== undefined && !EFFORTS.includes(chosenEffort)) throw new Error(effortProblem("refused effort", chosenEffort));
    if (resume !== undefined) assertArgShape("resume", resume);
    const resolvedCwd = cwd !== undefined ? await assertCwd(cwd) : undefined;
    // The CLI finds a session only under the directory it ran in, and the
    // one resumed may have run elsewhere: a pairing's hand-in forks in the
    // pairing's checkout, and a later turn resumes it from the ticket's.
    // Not found, the `--resume` below fails as it always did.
    if (resume !== undefined && resolvedCwd !== undefined) await bringSession(home, resume, projectDir(home, resolvedCwd));

    const server = bound?.server;
    if (bound && server === undefined) {
      throw new Error("cannot give this step create_child: the engine handed no server to start for it");
    }

    // stream-json ends on the result event, which carries session_id —
    // without it a conversation cannot continue — and prints every tool call
    // and message before it as a line of its own, which is what the ticket
    // panel shows. Under -p the CLI refuses stream-json without --verbose.
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", mode];
    if (restricted) args.push("--restricted");
    // A write run is not `--restricted`, so without this its own worktree's
    // `.claude/settings.json`/`.claude/settings.local.json` would load beside
    // the operator's — live on 2.1.283, a committed settings file's
    // SessionStart hook ran under plain `acceptEdits`, outside the sandbox
    // entirely (full HOME, network, the forge token), the moment a later
    // write step touched that branch. This keeps a write run to the
    // operator's own user settings only, same as the plugins and sandbox above.
    if (mayWrite) args.push("--setting-sources", "user");
    // A run that declares nothing is the screener's, and it reads
    // attacker-reachable text for a living: no built-in tool at all, not
    // even Read. Variadic, and the empty list must not swallow what follows
    // — a flag always does, since `--mcp-config` is pushed below whatever
    // else is.
    if (!declared) args.push("--tools", "");
    // Variadic like `--allowedTools`: the next flag ends it.
    if (denyWrites) args.push("--disallowedTools", ...WRITE_TOOLS);
    if (chosenModel !== undefined) args.push("--model", chosenModel);
    if (chosenEffort !== undefined) args.push("--effort", chosenEffort);
    if (resume !== undefined) args.push("--resume", resume);
    if (fork) args.push("--fork-session");
    // One `--settings` element holding the JSON, or none. Plugins are for
    // steps and turns, never the screener: a plugin that speaks up at session
    // start would be speaking to the one agent whose only job is to judge a
    // prompt — and `--restricted` ignores the operator's own settings file,
    // so this is the only way a plugin enabled there reaches a read-only step
    // at all. The sandbox is for a run that may write: the only one with Bash.
    const settings = {
      ...(declared && plugins.length ? { enabledPlugins: Object.fromEntries(plugins.map((id) => [id, true])) } : {}),
      ...(mayWrite ? sandboxSettings(sandbox) : {}),
    };
    if (Object.keys(settings).length) args.push("--settings", JSON.stringify(settings));
    const servers: Record<string, unknown> = declared ? { ...mcpServers } : {};
    if (server) {
      // An allowlisted server under the engine's own name would either be
      // silently replaced below — losing whichever of the two the operator
      // actually meant to run — or, the other way round, let an operator's
      // own server answer to the name a step trusts for create_child.
      // `resolveStepServers` (below) already refuses this at startup for
      // the shipped executor; this is the backstop for an executor built
      // directly, as `tests/hooks/claude.test.ts` does throughout.
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

      // stdout is read a line at a time and never kept whole: stream-json
      // prints every tool's result too, and a long build's would otherwise
      // sit in memory until it ended. What is kept is the line still being
      // written, the first bytes for an error, and the result event.
      let pending = "";
      let head = "";
      let result: { is_error?: boolean; result?: unknown; session_id?: unknown } | null = null;
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
        const e = event as { type?: unknown; message?: { content?: unknown } };
        // Parsed, so a secret in it is a string the log's redactor sees
        // whole — not split across two chunks, nor escaped inside a JSON
        // line. A tool's result is never logged: it is the files the agent
        // read and the output of what it ran, and agent.event reaches
        // telemetry even without --debug.
        if (e.type !== "user") log?.("agent.event", { round, event });
        if (e.type === "result") {
          result = e as typeof result;
          return;
        }
        const content = e.message?.content;
        if (e.type !== "assistant" || !onActivity || !Array.isArray(content)) return;
        for (const part of content as Array<Record<string, unknown> | null>) {
          if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
            onActivity({ kind: "message", text: part.text, at: Date.now() });
          } else if (part?.type === "tool_use" && typeof part.name === "string") {
            onActivity({ kind: "tool", text: toolLine(part.name, part.input, where), at: Date.now() });
          }
        }
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
          // rather than reject the promise, and the timeout never gets a
          // chance to fire because this throws long before then.
          killGroup(child);
          finish(() => reject(new Error(`agent produced more than ${MAX_OUTPUT_BYTES} bytes of ${label}`)));
          return true;
        }
        set(get() + chunk.toString());
        return false;
      };

      // Decoded as a stream, so a character split across two chunks is not
      // two broken halves.
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (text: string) => {
        if (head.length < 200) head += text.slice(0, 200 - head.length);
        const lines = (pending + text).split("\n");
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
          // The result is the last line, with or without a newline after it.
          try {
            onLine(pending);
          } catch {
            // Display only; the result is read below either way.
          }
          const parsed = result;
          if (parsed === null) {
            return reject(new Error(`agent did not return json with a result: ${head}`));
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
          log?.("step.completed", { round, ms: Date.now() - started, model: chosenModel ?? null, effort: chosenEffort ?? null });
          // Untrusted from here on: this text was produced by the agent,
          // not by us, and the caller will parse it for control markers —
          // it inherits no trust from having passed through this executor.
          resolve({ text: String(parsed.result ?? "").trim(), sessionId: parsed.session_id ?? null });
        }),
      );

      child.stdin.end(prompt);
    });
  };

  /*
   * The interactive `claude` a person runs for a pairing: in the pairing's
   * checkout, under the session id the engine derived, seeded with the step.
   * Their own settings, plugins and servers load as they always do — this is
   * their session, and every tool call in it is theirs to approve — beside
   * the engine's own server, their way back to Landrace.
   *
   * The CLI keeps a session under the directory it ran in. So a command run a
   * second time — after the terminal was closed — resumes the session it
   * started rather than starting another, and the agent's own session, which
   * ran in the ticket's worktree, is brought over before it is forked here.
   */
  const handoff: NonNullable<Executor["handoff"]> = async ({ cwd, session, prompt, resume, server }) => {
    assertArgShape("session", session);
    if (resume !== undefined) assertArgShape("resume", resume);
    // The seed goes first, as a positional, where a leading "-" would be read
    // as a flag instead.
    if (prompt.startsWith("-")) throw new Error("refused a prompt that starts with \"-\": the command line would read it as a flag");
    const where = await assertCwd(cwd);
    const here = projectDir(home, where);

    const argv = [bin];
    if (existsSync(join(here, `${session}.jsonl`))) {
      argv.push("--resume", session);
    } else {
      argv.push(prompt);
      if (resume !== undefined && (await bringSession(home, resume, here))) argv.push("--resume", resume, "--fork-session");
      argv.push("--session-id", session);
    }
    if (server) {
      argv.push("--mcp-config", JSON.stringify({ mcpServers: { [server.name]: { command: server.command, args: server.args } } }));
      if (server.tools.length) argv.push("--allowedTools", ...server.tools.map((tool) => `mcp__${server.name}__${tool}`));
    }
    return { argv, cwd: where };
  };

  // Unbranded: only the exported `claude` factory below is the hook the
  // loader classifies. This is a plain constructor a test can call directly.
  return { id: ID, run, handoff };
}

/** Where the CLI keeps a directory's sessions: its path, every character but a letter or digit made "-". */
const projectDir = (home: string, cwd: string): string =>
  join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));

/**
 * The agent's session, made resumable from `here`: already there, or copied
 * from the one directory it is found under. False when it is under none, or
 * under several — which of two to continue is not this hook's to guess — and
 * a pairing then starts fresh, seeded with the step.
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
export function mcpRedactionValues(servers: Readonly<Record<string, McpServer>>): string[] {
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

/** The keys of `agent:` this hook reads, beside the engine's own two. */
const SETTING_KEYS = new Set(["adapter", "isolation", "model", "effort", "plugins", "mcp", "sandbox"]);
/** The keys of `agent.sandbox`. */
const SANDBOX_KEYS = new Set(["hosts", "deny"]);

/**
 * What a write step's commands may not read when `agent.sandbox.deny` names
 * nothing: the forge CLI's token, ssh keys, cloud keys, a package registry's
 * token. A step with Bash is otherwise one `cat` away from each.
 */
const DEFAULT_DENY: readonly string[] = ["~/.config/gh", "~/.ssh", "~/.aws", "~/.npmrc"];

/**
 * A host the sandbox matches by name, optionally with its own leading `*.`.
 * `https://github.com` or `github.com:443` is a host it never matches, and a
 * step that cannot push finds that out an hour into a build.
 */
const HOST_SHAPE = /^(\*\.)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*$/;

/**
 * A path under HOME: the one form the sandbox and a `Read(...)` rule read
 * alike. A rule reads `/x` relative to its settings file, so an absolute path
 * would deny nothing, silently. Not `~/` itself or a trailing "/", and no
 * parentheses, which would end the rule early.
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
 * This hook's settings out of the `agent:` block, or every reason they
 * cannot be used — in one error, so an operator fixes them in one pass.
 */
export function readClaudeSettings(agent: Record<string, unknown>): ClaudeSettings {
  const problems: string[] = [];
  for (const key of Object.keys(agent)) {
    if (!SETTING_KEYS.has(key)) problems.push(`agent.${key} is not a setting the claude executor reads`);
  }
  const { model, effort, plugins = [], mcp = [], sandbox = {} } = agent;
  if (model !== undefined && (typeof model !== "string" || model === "")) problems.push("agent.model must be a model name");
  if (effort !== undefined && !EFFORTS.includes(effort as string)) problems.push(effortProblem("agent.effort is", effort));
  const pluginsOk = Array.isArray(plugins) && plugins.every((p) => typeof p === "string" && p !== "");
  if (!pluginsOk) problems.push('agent.plugins must be a list of plugin ids, like "name@marketplace"');
  const entryOk = (e: unknown): boolean =>
    (typeof e === "string" && e !== "") ||
    (typeof e === "object" && e !== null && !Array.isArray(e) &&
      Object.keys(e).every((k) => k === "name" || k === "tools") &&
      typeof (e as { name?: unknown }).name === "string" && (e as { name: string }).name !== "" &&
      Array.isArray((e as { tools?: unknown }).tools) &&
      (e as { tools: unknown[] }).tools.every((t) => typeof t === "string" && t !== ""));
  // Named by index, the way the zod path this replaces did (`agent.mcp.1: …`,
  // via `issue.path.join(".")`) — a single "some entry is wrong" line sends an
  // operator counting server names by hand to find which one.
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
    for (const key of Object.keys(sandbox)) {
      if (!SANDBOX_KEYS.has(key)) problems.push(`agent.sandbox.${key} is not a setting the claude executor reads`);
    }
    const block = sandbox as { hosts?: unknown; deny?: unknown };
    // Not `??`: a bare "hosts:" in YAML parses as null, not absent, and every
    // other key here refuses null rather than reading it as its default.
    hosts = block.hosts === undefined ? [] : block.hosts;
    deny = block.deny === undefined ? DEFAULT_DENY : block.deny;
    problems.push(
      ...listProblems("agent.sandbox.hosts", hosts, HOST_SHAPE, "a host name like github.com or *.npmjs.org, with no scheme, port or path"),
      ...listProblems("agent.sandbox.deny", deny, DENY_SHAPE, "a path under your home like ~/.ssh: starting with ~/, not ending in /, with no parentheses"),
    );
  }

  if (problems.length) throw new Error(problems.join("\n"));
  return {
    ...(typeof model === "string" ? { model } : {}),
    ...(typeof effort === "string" ? { effort } : {}),
    plugins: plugins as string[],
    mcp: mcp as McpEntry[],
    sandbox: { hosts: [...(hosts as string[])], deny: [...(deny as string[])] },
  };
}

/**
 * The executor the engine builds at startup, from its own context: this
 * hook's settings, the repository the workflow is in, and the log whose
 * redaction set an allowlisted server's env and headers join — they travel in
 * the agent's argv and can come back in its stderr.
 */
export const claude: ExecutorFactory = defineExecutor({
  id: ID,
  async create(ctx) {
    // `agent:` belongs to the step agent. When that is another executor, this
    // one was built only to screen (`security.adapter: claude`), and the block
    // is in the other agent's vocabulary: reading it here refused that agent's
    // own keys at startup, or screened on its model name. The screener's model
    // arrives on each run from `security.model`, and it gets no plugin and no
    // server whatever the block says.
    if (ctx.config.agent.adapter !== ID) return { run: createClaudeExecutor({ log: ctx.log }).run };

    const settings = readClaudeSettings(ctx.config.agent as Record<string, unknown>);
    const { servers, tools, problems } = await resolveStepServers(ctx.dir, settings.mcp);
    if (problems.length) throw new Error(problems.map((p) => `${p.rule}: ${p.message}`).join("\n"));
    ctx.redact(mcpRedactionValues(servers));
    const executor: Executor = createClaudeExecutor({
      ...(settings.model === undefined ? {} : { model: settings.model }),
      ...(settings.effort === undefined ? {} : { effort: settings.effort }),
      log: ctx.log,
      plugins: settings.plugins,
      mcpServers: servers,
      mcpTools: tools,
      sandbox: settings.sandbox,
    });
    // Handoff only here, where `agent:` is this hook's: a screener built
    // from another agent's block is never the one a person pairs with.
    return { run: executor.run, ...(executor.handoff ? { handoff: executor.handoff } : {}) };
  },
});
