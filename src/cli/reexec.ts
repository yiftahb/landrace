import { spawn } from "node:child_process";
import type { Reexec, Where } from "#namespace.js";

/**
 * Running this process again, once, with the flag that lets node read a
 * TypeScript hook module.
 *
 * Node strips types with no flag from 22.18. `engines` says `>=22`, and the
 * machines this ships to are on 22.13 — where importing `.landrace/hooks/*.ts`
 * fails with ERR_UNKNOWN_FILE_EXTENSION and the operator's only recourse is to
 * know that a node flag exists and that landrace needed it. Raising the engine
 * floor would be the correct statement and an unusable package, so this
 * re-runs itself instead, says so in one line, and never does it twice.
 */
export const STRIP_TYPES = "--experimental-strip-types";

/**
 * Set on the child. `execArgv` alone would very nearly do — a flag passed on
 * the command line shows up there — but the same flag in NODE_OPTIONS does
 * not, and neither would a future node that needs a different flag. This is
 * the thing that actually says "this process is already the retry", so a
 * failure that survives the flag is reported rather than forked over again.
 */
export const REEXEC_MARKER = "LANDRACE_STRIPPING_TYPES";

const isUnknownExtension = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === "ERR_UNKNOWN_FILE_EXTENSION";

/** Whether this failure is the one a retry with `STRIP_TYPES` would fix, and whether this is still the first try. */
export function shouldReexec(error: unknown, where: Where): boolean {
  if (!isUnknownExtension(error)) return false;
  if (where.env[REEXEC_MARKER]) return false;
  return !where.execArgv.includes(STRIP_TYPES);
}

/**
 * How a person or a supervisor asks landrace to stop. `start` turns these into
 * a graceful stop (see createInterrupt); this module makes sure they reach the
 * process that is actually doing the work after a re-exec.
 */
export const STOP_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

/**
 * Run the same command again with the flag, and answer with the child's exit
 * code so the caller can exit as the child did.
 *
 * `stdio: "inherit"` because both callers need the real streams: `landrace
 * mcp` speaks its protocol over stdin and stdout, and `landrace start` is
 * something a person is watching. The flag goes first, before the inherited
 * options, so it is still a node option when one of those is `-e` or `--`.
 */
export function reexec(target: Reexec): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(target.execPath, [STRIP_TYPES, ...target.execArgv, ...target.argv], {
      stdio: "inherit",
      env: { ...target.env, [REEXEC_MARKER]: "1" },
    });

    /*
     * Ctrl-C has to reach the process holding the locks, and reach it once.
     *
     * The child is in this process's group, so a terminal already delivers to
     * both — forwarding as well would turn the operator's first press into the
     * second one, which is the "exit now, leave the locks" branch. With no
     * terminal there is no group delivery to rely on: a supervisor signals the
     * pid it started, which is this one, so the signal is passed on.
     *
     * Either way a handler is installed, because the default action is to die,
     * and a parent that dies here leaves the loop running with nobody watching
     * it and hands the shell back as though it had stopped.
     */
    const forwarding = !process.stdin.isTTY;
    const pass = (signal: NodeJS.Signals) => (): void => {
      if (forwarding) child.kill(signal);
    };
    const installed = STOP_SIGNALS.map((signal) => [signal, pass(signal)] as const);
    for (const [signal, handler] of installed) process.on(signal, handler);
    const done = (): void => {
      for (const [signal, handler] of installed) process.off(signal, handler);
    };

    child.on("error", (e) => {
      done();
      reject(e);
    });
    child.on("close", (code, signal) => {
      done();
      resolve(code ?? exitCodeFor(signal));
    });
  });
}

const SIGNAL_NUMBERS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };

/** A child killed by a signal reports no exit code, so this reports what a shell would for the same death. */
const exitCodeFor = (signal: NodeJS.Signals | null): number => (signal ? 128 + (SIGNAL_NUMBERS[signal] ?? 0) : 1);
