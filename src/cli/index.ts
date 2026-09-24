import { Command } from "commander";
import { messageOf } from "#runner/errors.js";
import { reexec, shouldReexec, STRIP_TYPES } from "#cli/reexec.js";
import { runValidate } from "#cli/validate.js";
import { runNext } from "#cli/next.js";
import { runChildMcp, runMcp } from "#cli/mcp.js";
import { DEFAULT_UI_PORT, parsePort, runStart } from "#cli/start.js";
import { runStatus } from "#cli/status.js";

const program = new Command();
program.name("landrace").description("Local-first SDLC orchestrator");

/**
 * Run a command that imports hook modules, and report rather than crash.
 *
 * The one failure worth acting on instead of printing is a node too old to
 * read a `.ts` file: `engines` says `>=22`, node strips types unflagged only
 * from 22.18, and an operator on 22.13 would otherwise be told to add a flag
 * to a command they did not write. So this re-runs itself once, with the flag
 * and one line saying why — and never twice, so a failure that survives the
 * flag is reported as itself (see shouldReexec).
 *
 * Safe where it happens: hooks are imported after the config and workflow are
 * read and before the first request goes out, so the process being replaced
 * here has done nothing but read files. Later — a hook that imports another
 * module lazily, mid-tick — the retry starts the loop again, and re-entering a
 * state replans its effects and reconcile drops the ones already applied.
 */
async function loadingHooks(what: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (e) {
    if (shouldReexec(e, { execArgv: process.execArgv, env: process.env })) {
      console.error(
        `landrace: this node (${process.version}) cannot read the TypeScript hook modules, ` +
        `so it is re-running itself with ${STRIP_TYPES}. Node 22.18 and newer need no flag.`,
      );
      process.exitCode = await reexec({
        execPath: process.execPath,
        execArgv: process.execArgv,
        argv: process.argv.slice(1),
        env: process.env,
      });
      return;
    }
    // A CLI reports; it does not exit through a stack trace. `messageOf`, not
    // `(e as Error).message`: a hook is a plain interface and nothing stops one
    // rejecting with a shape that throws on a property read.
    console.error(`landrace ${what}: ${messageOf(e)}`);
    process.exitCode = 1;
  }
}

program
  .command("validate")
  .argument("[dir]", "workflow directory", ".landrace")
  // Wrapped like `start`, because validate imports the hook modules now: path
  // coverage is a question about the workflow *and* its integrations, and on a
  // node that cannot read a .ts file the answer is to re-run with the flag,
  // not to report the workflow as broken.
  .action(async (dir: string) => {
    await loadingHooks("validate", async () => {
      const { ok, problems } = await runValidate(dir);
      if (ok) {
        console.log(`${dir}: valid`);
        return;
      }
      for (const p of problems) console.error(`  ${p.rule}: ${p.message}`);
      console.error(`\n${problems.length} problem(s)`);
      process.exitCode = 1;
    });
  });

program
  .command("next")
  .requiredOption("-w, --workflow <dir>", "workflow directory")
  .requiredOption("-s, --snapshot <file>", "snapshot json")
  .action(async (opts: { workflow: string; snapshot: string }) => {
    // Reported, not thrown: a snapshot missing what a stage's plan reads (a
    // node, a graph) came out as an unhandled rejection's stack trace.
    await loadingHooks("next", async () => {
      const { decision, effects } = await runNext(opts.workflow, opts.snapshot);
      console.log(JSON.stringify({ decision, effects }, null, 2));
    });
  });

program
  .command("start")
  .description("watch the tracker and advance every eligible ticket")
  .option("-w, --workflow <dir>", "workflow directory", ".landrace")
  .option("--once", "run a single tick and exit")
  .option("--debug", "print every event, the agent's included, and the snapshot behind each decision")
  .option("--ui-port <port>", "port for the triage page", String(DEFAULT_UI_PORT))
  .option("--no-ui", "do not serve the triage page")
  .action(async (opts: { workflow: string; once?: boolean; debug?: boolean; ui: boolean; uiPort: string }) => {
    await loadingHooks("start", () =>
      runStart(opts.workflow, {
        ...(opts.once === undefined ? {} : { once: opts.once }),
        ...(opts.debug === undefined ? {} : { debug: opts.debug }),
        ui: opts.ui,
        uiPort: parsePort(opts.uiPort),
      }),
    );
  });

program
  .command("status")
  .description("one line per candidate ticket, including why one was skipped")
  .option("-w, --workflow <dir>", "workflow directory", ".landrace")
  .action(async (opts: { workflow: string }) => {
    await loadingHooks("status", async () => {
      for (const line of await runStatus(opts.workflow)) console.log(line);
    });
  });

program
  .command("mcp")
  .description("run the MCP server over stdio")
  .option("-w, --workflow <dir>", "workflow directory", ".landrace")
  .option("--child <parent>", "serve only landrace_create_child, bound to this parent ticket")
  .option("--stage <stage>", "with --child: the stage creating the children")
  .option("--round <round>", "with --child: the round creating the children")
  .action(async (opts: { workflow: string; child?: string; stage?: string; round?: string }) => {
    // The MCP client that spawned us shows stderr, so what loadingHooks prints
    // there is the only diagnostic a user gets.
    await loadingHooks("mcp", () => {
      if (opts.child !== undefined) {
        if (opts.stage === undefined || opts.round === undefined) {
          throw new Error("--child needs --stage and --round");
        }
        return runChildMcp(opts.workflow, { parent: opts.child, stage: opts.stage, round: Number(opts.round) });
      }
      return runMcp(opts.workflow);
    });
  });

await program.parseAsync();
