import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import { CAPABILITIES, mayCreateTickets, mayWriteRepo, unknownCapabilities } from "#conventions.js";
import { defineExecutor } from "#hooks/contracts.js";
import type { Executor, Logger, StepTools } from "#namespace.js";
import { containedPath } from "#workflow/load.js";
import { messageOf } from "#runner/errors.js";
import { DEFAULT_STEP_TIMEOUT_MS } from "#runner/budget.js";

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

/**
 * An absolute path is not automatically a safe one: `/tmp/x/../../etc`
 * is absolute and still resolves somewhere the caller never wrote down.
 * `containedPath` (src/workflow/load.ts) already carries the two checks that
 * matter — no ".." segment, and the realpath-resolved result has to still be
 * where it appears to be — so this reuses it against root "/" rather than
 * re-deriving the same shape rules a second time just because this path
 * happens to already be absolute.
 */
async function assertCwd(cwd: string): Promise<string> {
  if (!isAbsolute(cwd)) {
    throw new Error(`refused cwd ${JSON.stringify(cwd)}: must be an absolute path`);
  }
  const result = await containedPath("/", cwd.slice(1));
  if (!result.ok) {
    throw new Error(`refused cwd ${JSON.stringify(cwd)}: ${result.reason}`);
  }
  return result.path;
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
  log?: Logger;
  /**
   * Plugin ids (`name@marketplace`) enabled for every declared run.
   * `--restricted` ignores the operator's own settings, and with them every
   * plugin enabled there, so a read-only step would otherwise have none.
   */
  plugins?: StepTools["plugins"];
  /**
   * The MCP servers a declared run may use, by name, as the repository root's
   * `.mcp.json` defines them — resolved and vetted once at startup by
   * `resolveStepServers` (config/mcp.ts), which is where a name that argv
   * could not carry whole, or that collides with the child server's, is
   * refused. Never read from the worktree the agent runs in.
   */
  mcpServers?: StepTools["mcpServers"];
  /** Per server, the only tools a run may call on it; a server absent here allows every tool it has. */
  mcpTools?: StepTools["mcpTools"];
} = {}): Executor {
  const {
    model,
    timeoutMs = DEFAULT_STEP_TIMEOUT_MS,
    bin = "claude",
    log,
    plugins = [],
    mcpServers = {},
    mcpTools = {},
  } = opts;

  return defineExecutor({
    id: "claude",
    async run(prompt, { round, resume, cwd, capabilities, model: stepModel, timeoutMs: stepTimeoutMs, child: binding, signal }) {
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
        // `resolveStepServers` (config/mcp.ts) already refuses this at
        // startup for the shipped executor; this is the backstop for an
        // executor built directly, as every test here does.
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
    },
  });
}
