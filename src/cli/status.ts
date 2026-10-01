import { buildWorkspaceRuntime } from "#cli/start.js";
import { statusLines, workspaceStatusRows } from "#runner/status.js";
import { listingFailures, listWorkspace } from "#runner/tick.js";

export async function runStatus(dir: string): Promise<string[]> {
  // Events to stderr: stdout is the report, and a hook that logs while
  // enumerating would otherwise interleave json with the table.
  const rt = await buildWorkspaceRuntime(dir, {
    sink: (event) => process.stderr.write(`${JSON.stringify(event)}\n`),
    // It runs no step, so it does not ask what a step would be handed.
    readOnly: true,
  });
  // The same listing a tick makes, so the table claims what the loop would.
  const listing = await listWorkspace(rt);
  // A table missing one source's items would read as a workspace with none:
  // a source that could not list is the command's failure, said by name.
  const failures = listingFailures(listing);
  if (failures.length) throw new Error(rt.log.scrub(failures.join("; ")));
  return statusLines(workspaceStatusRows(rt.workflows, listing));
}
