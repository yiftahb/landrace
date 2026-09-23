import { statusLines, statusRows } from "#runner/status.js";
import { buildRuntime } from "#cli/start.js";

export async function runStatus(dir: string): Promise<string[]> {
  // Events to stderr: stdout is the report, and a hook that logs while
  // enumerating would otherwise interleave json with the table.
  const rt = await buildRuntime(dir, { sink: (event) => process.stderr.write(`${JSON.stringify(event)}\n`) });
  return statusLines(statusRows(rt.deps.workflow, await rt.source.list(rt.deps.ctx)));
}
