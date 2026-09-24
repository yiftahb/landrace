import { LABELS, neutraliseMarkers, recordBodyProblem, ticketIdProblem } from "#conventions.js";
import type { ChildBinding, NewChild, Node, Operator, RuntimeContext } from "#namespace.js";

/** Ten is already more urgency levels than any tracker we have met distinguishes. */
const MAX_PRIORITY = 9;

/**
 * Create one child of a running step, filed where the runner said, never where
 * the agent said.
 *
 * This is the whole of what the agent's create_child tool does, kept out of
 * the MCP layer so the harness and the tool run the same code. It is not an
 * effect: the tick never plans it, which is why "ticket creation is never an
 * effect" still holds — the agent does this, as work, while its step runs.
 *
 * The child is labelled eligible so the next tick picks it up, exactly as
 * landrace_create_ticket does by default; its own workflow instance starts
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
  const parentProblem = ticketIdProblem(binding.parent);
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

  return operator.createTicket(
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
