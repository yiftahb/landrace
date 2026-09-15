import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import { defineExecutor, type Executor } from "../hooks/types.js";
import type { Logger } from "../runner/events.js";
import { containedPath } from "../workflow/load.js";

/**
 * A value that begins with "-" lands in a flag slot no matter which argv
 * index it occupies — `--model -x` makes the CLI read "-x" as the next flag,
 * not as the model name. Passing a value as its own array element (instead
 * of interpolating it into a shell string) rules out one class of attack and
 * not the other, so every value that reaches argv is checked against the
 * shape it is actually allowed to have, not merely isolated.
 */
const ARG_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * The CLI's own six modes (`acceptEdits, auto, bypassPermissions, manual,
 * dontAsk, plan`) — not a project-specific subset. `bypassPermissions` stays
 * in the allowlist even though it disables every permission prompt: this is
 * operator config, not attacker input, and unattended orchestration has no
 * human standing by to answer a prompt in the first place. It is dangerous
 * enough to be worth a startup warning rather than silent acceptance — see
 * the check in createClaudeExecutor below.
 */
const PERMISSION_MODES = new Set(["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"]);

function assertArgShape(kind: string, value: string): void {
  if (!ARG_SHAPE.test(value)) {
    throw new Error(`refused ${kind} ${JSON.stringify(value)}: does not match the allowed shape for a claude CLI argument`);
  }
}

function assertPermissionMode(mode: string): void {
  if (!PERMISSION_MODES.has(mode)) {
    throw new Error(
      `refused permissionMode ${JSON.stringify(mode)}: must be one of ${[...PERMISSION_MODES].join(", ")}`,
    );
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
  restricted?: boolean;
  permissionMode?: string;
  timeoutMs?: number;
  bin?: string;
  log?: Logger;
} = {}): Executor {
  const {
    model,
    restricted = true,
    permissionMode = "plan",
    timeoutMs = 10 * 60_000,
    bin = "claude",
    log,
  } = opts;

  if (permissionMode === "bypassPermissions") {
    // Not attacker-reachable (it is construction-time operator config), but
    // dangerous enough that silent acceptance would be the wrong default —
    // this disables the one guard that would otherwise catch a misconfigured
    // workflow before it touches a real repository.
    console.warn(
      'claude executor: permissionMode "bypassPermissions" disables every permission prompt for every run this executor makes',
    );
  }

  return defineExecutor({
    id: "claude",
    async run(prompt, { round, resume, cwd, signal }) {
      if (signal.aborted) {
        // Nothing checked this before `spawn` in the first cut, so a run
        // cancelled before it started launched the (paid) agent anyway.
        throw new Error("agent aborted");
      }

      assertPermissionMode(permissionMode);
      if (model !== undefined) assertArgShape("model", model);
      if (resume !== undefined) assertArgShape("resume", resume);
      const resolvedCwd = cwd !== undefined ? await assertCwd(cwd) : undefined;

      // json output carries session_id; without it a conversation cannot continue.
      const args = ["-p", "--output-format", "json", "--permission-mode", permissionMode];
      if (restricted) args.push("--restricted");
      if (model !== undefined) args.push("--model", model);
      if (resume !== undefined) args.push("--resume", resume);

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
          return reject(new Error(`could not start "${bin}": ${(e as Error).message}`));
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
        const timer = setTimeout(() => {
          killGroup(child);
          finish(() => reject(new Error(`agent exceeded ${timeoutMs}ms`)));
        }, timeoutMs);
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
            log?.("step.completed", { round, ms: Date.now() - started });
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
