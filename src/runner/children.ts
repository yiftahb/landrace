import { CHILD_SERVER_NAME, CHILD_TOOL, isItemId, LABELS, neutraliseMarkers, recordBodyProblem, itemIdProblem } from "#conventions.js";
import type { ChildBinding, NewChild, Node, Operator, RunServer, RuntimeContext, ServerCommand } from "#namespace.js";

/** Ten is already more urgency levels than any tracker we have met distinguishes. */
const MAX_PRIORITY = 9;

/**
 * Create one child of a running step, filed where the runner said, never where
 * the agent said.
 *
 * This is the whole of what the agent's create_child tool does, kept out of
 * the MCP layer so the harness and the tool run the same code. It is not an
 * effect: the tick never plans it, which is why "item creation is never an
 * effect" still holds — the agent does this, as work, while its step runs.
 *
 * The child is labelled eligible so the next tick picks it up, exactly as
 * landrace_create_item does by default; its own workflow instance starts
 * from there, through whichever entry stage accepts a child.
 */
export async function createChild(
  operator: Operator | null,
  binding: ChildBinding,
  input: NewChild,
  ctx: RuntimeContext,
): Promise<Node> {
  if (!operator) {
    throw new Error("cannot create a child: no operator hook is configured. Add a module exporting defineOperator({ ... }) to the hooks list in workflow.yaml.");
  }
  const parentProblem = itemIdProblem(binding.parent);
  if (parentProblem) throw new Error(`cannot create a child: ${parentProblem}`);

  const title = input.title.trim();
  if (!title) throw new Error("cannot create a child: the title is empty");
  const body = input.body ?? "";
  const tooLong = recordBodyProblem(body);
  if (tooLong) throw new Error(`cannot create a child: the body ${tooLong}`);
  const { priority } = input;
  if (priority !== undefined && (!Number.isInteger(priority) || priority < 0 || priority > MAX_PRIORITY)) {
    throw new Error(`cannot create a child: priority must be an integer from 0 to ${MAX_PRIORITY}, got ${priority}`);
  }

  return operator.createItem(
    {
      title,
      // A marker the agent wrote into the body would read back as ours.
      body: neutraliseMarkers(body),
      labels: [LABELS.eligible],
      parent: binding.parent,
      origin: { parent: binding.parent, stage: binding.stage, round: binding.round },
      ...(priority === undefined ? {} : { priority }),
    },
    ctx,
  );
}

/** A value `landrace mcp --stage` reads as a stage id and never as a flag. */
const ARG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * The engine's item server for one binding. The binding goes on the
 * server's own command line, never into the agent's prompt: nothing the agent
 * says can file a child anywhere else. Each value is checked against the
 * shape the command line can carry as meant, because a value starting with
 * "-" is read as a flag whatever position it has.
 */
export function childServerFor(base: ServerCommand, binding: ChildBinding): RunServer {
  if (!isItemId(binding.parent)) throw new Error(`refused parent ${JSON.stringify(binding.parent)}: not an item id`);
  if (!ARG.test(binding.stage)) throw new Error(`refused stage ${JSON.stringify(binding.stage)}: not a shape the server's command line can carry`);
  if (!Number.isInteger(binding.round) || binding.round < 1) throw new Error(`refused round ${binding.round}`);
  return {
    name: CHILD_SERVER_NAME,
    command: base.command,
    args: [...base.args, "--child", binding.parent, "--stage", binding.stage, "--round", String(binding.round)],
    tools: [CHILD_TOOL],
  };
}
