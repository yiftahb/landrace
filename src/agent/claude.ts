import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { defineExecutor, type Executor } from "../hooks/types.js";
import type { Logger } from "../runner/events.js";

/**
 * A value that begins with "-" lands in a flag slot no matter which argv
 * index it occupies — `--model -x` makes the CLI read "-x" as the next flag,
 * not as the model name. Passing a value as its own array element (instead
 * of interpolating it into a shell string) rules out one class of attack and
 * not the other, so every value that reaches argv is checked against the
 * shape it is actually allowed to have, not merely isolated.
 */
const ARG_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PERMISSION_MODES = new Set(["default", "plan", "acceptEdits", "bypassPermissions"]);

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

function assertCwd(cwd: string): void {
  // Requiring an absolute path is also what rules out a leading "-":
  // an absolute path always starts with "/".
  if (!isAbsolute(cwd)) {
    throw new Error(`refused cwd ${JSON.stringify(cwd)}: must be an absolute path`);
  }
}

/**
 * The env vars a subprocess needs to run at all (locate its own binary,
 * find $HOME for its own credential store, resolve a temp dir) — never the
 * parent's full environment. `spawn` inherits `process.env` wholesale by
 * default, and this project's own secrets arrive as resolved values handed
 * to hooks (see HookContext), not as environment variables — so the one way
 * a credential could reach the agent's subprocess is exactly this default,
 * which is why it is never used here.
 */
const INHERITED_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP", "SystemRoot", "SystemDrive"];

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
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

  return defineExecutor({
    id: "claude",
    run(prompt, { round, resume, cwd, signal }) {
      return new Promise((resolve, reject) => {
        let args: string[];
        try {
          assertPermissionMode(permissionMode);
          if (model !== undefined) assertArgShape("model", model);
          if (resume !== undefined) assertArgShape("resume", resume);
          if (cwd !== undefined) assertCwd(cwd);

          // json output carries session_id; without it a conversation cannot continue.
          args = ["-p", "--output-format", "json", "--permission-mode", permissionMode];
          if (restricted) args.push("--restricted");
          if (model !== undefined) args.push("--model", model);
          if (resume !== undefined) args.push("--resume", resume);
        } catch (e) {
          return reject(e as Error);
        }

        // No shell, ever: an issue title or comment is attacker-controlled
        // text and must never be interpolated into a command line. The
        // prompt itself goes in on stdin below, never as an argv element —
        // argv is world-readable via `ps`, stdin is not.
        const child = spawn(bin, args, {
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
          env: childEnv(),
          ...(cwd !== undefined ? { cwd } : {}),
        });

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
          child.kill("SIGKILL");
          finish(() => reject(new Error(`agent exceeded ${timeoutMs}ms`)));
        }, timeoutMs);
        const onAbort = () => {
          child.kill("SIGKILL");
          finish(() => reject(new Error("agent aborted")));
        };
        signal.addEventListener("abort", onAbort, { once: true });

        child.stdout.on("data", (d: Buffer) => {
          out += d.toString();
          log?.("agent.event", { round, raw: d.toString() });
        });
        child.stderr.on("data", (d: Buffer) => (err += d.toString()));

        child.on("error", (e) =>
          finish(() => reject(new Error(`could not start "${bin}": ${e.message}`))),
        );

        child.on("close", (code) =>
          finish(() => {
            if (code !== 0) {
              return reject(new Error(`agent exited ${code}: ${err.trim().slice(0, 400)}`));
            }
            let parsed: { is_error?: boolean; result?: unknown; session_id?: string };
            try {
              parsed = JSON.parse(out) as typeof parsed;
            } catch {
              return reject(new Error(`agent did not return json: ${out.slice(0, 200)}`));
            }
            if (parsed.is_error) {
              return reject(new Error(`agent reported an error: ${String(parsed.result ?? "")}`));
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
