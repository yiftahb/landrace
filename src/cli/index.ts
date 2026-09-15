import { Command } from "commander";
import { runValidate } from "./validate.js";
import { runNext } from "./next.js";

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

await program.parseAsync();
