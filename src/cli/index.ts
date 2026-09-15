import { Command } from "commander";
import { runValidate } from "./validate.js";
import { runNext } from "./next.js";
import { runMcp } from "./mcp.js";

const program = new Command();
program.name("landrace").description("Local-first SDLC orchestrator");

program
  .command("validate")
  .argument("[dir]", "workflow directory", ".landrace")
  .action(async (dir: string) => {
    const { ok, problems } = await runValidate(dir);
    if (ok) {
      console.log(`${dir}: valid`);
      return;
    }
    for (const p of problems) console.error(`  ${p.rule}: ${p.message}`);
    console.error(`\n${problems.length} problem(s)`);
    process.exitCode = 1;
  });

program
  .command("next")
  .requiredOption("-w, --workflow <dir>", "workflow directory")
  .requiredOption("-s, --snapshot <file>", "snapshot json")
  .action(async (opts: { workflow: string; snapshot: string }) => {
    const { decision, effects } = await runNext(opts.workflow, opts.snapshot);
    console.log(JSON.stringify({ decision, effects }, null, 2));
  });

program
  .command("mcp")
  .description("run the MCP server over stdio")
  .option("-w, --workflow <dir>", "workflow directory", ".landrace")
  .action(async (opts: { workflow: string }) => {
    try {
      await runMcp(opts.workflow);
    } catch (e) {
      // A CLI reports; it does not exit through a stack trace. The MCP client
      // that spawned us shows stderr, so this is the only diagnostic a user gets.
      console.error(`landrace mcp: ${(e as Error).message}`);
      process.exitCode = 1;
    }
  });

await program.parseAsync();
