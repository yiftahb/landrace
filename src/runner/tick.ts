import { checkEligible, missingPaths } from "#core/index.js";
import type {
  ConvergeResult,
  Eligibility,
  HookContext,
  Node,
  Snapshot,
  TickOptions,
  TickRow,
  Workflow,
} from "#namespace.js";
import { compareIds, compareWork, isOpenTicket, ticketIdProblem } from "#conventions.js";
import { converge } from "#runner/converge.js";
import { messageOf } from "#runner/errors.js";
import { withLock } from "#runner/lock.js";
import { oneLine } from "#runner/status.js";

/** Matches `tick.concurrency`'s own default, so the two cannot drift. */
const DEFAULT_CONCURRENCY = 3;

/**
 * What a listed node can answer about itself, without a network round trip.
 *
 * Position, eligibility and whose turn it is are all labels, and a ticket node
 * carries its labels in `state` precisely so this question costs nothing:
 * building a snapshot to find out a ticket is not ours would mean reading
 * every issue in the repository on every tick.
 *
 * Whose ticket it is rides along for the same reason and under the same name
 * the snapshot gives it. It is not a label, but it is asked at the same
 * moment, and a rule the node cannot answer abstains — which is what made
 * an instance filtered to one developer read the whole repository anyway.
 */
const nodeSnapshot = (node: Node): Snapshot => ({ node });

/**
 * Whether the tick should work a ticket, decided from the workflow's own
 * eligibility rule rather than from a label name hard-coded here — the
 * workflow owns what "eligible" means, and `landrace status` prints its `else`
 * verbatim as the reason a ticket was skipped.
 *
 * Abstains rather than guesses. A rule reading anything a listed node cannot
 * carry — a derived counter, a step's output — is unanswerable from labels
 * alone, and the two ways of guessing are both bad: "ineligible" silently
 * parks every ticket in the repository, and a wrong "eligible" is only a
 * wasted snapshot, which converge then decides on properly. So an
 * unanswerable rule set means work it and let `decide` say.
 *
 * `checkEligible` does the actual evaluating, rather than a second copy of it
 * here: two implementations of one rule is how a validator and an engine come
 * to disagree about where a ticket is.
 */
export function eligibilityOf(workflow: Workflow, node: Node): Eligibility {
  const snapshot = nodeSnapshot(node);
  const unanswerable = (workflow.eligible ?? []).some((rule) => missingPaths(rule.when, snapshot).length > 0);
  return unanswerable ? { eligible: true } : checkEligible(workflow, snapshot);
}

/** A lock held elsewhere is a skip, not a failure: the ticket will still be there next tick. */
const isLocked = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { code?: unknown }).code === "ELOCKED";

const outcomeOf = (result: ConvergeResult): string =>
  `${result.settled} after ${result.passes} pass(es)${result.why ? `: ${oneLine(result.why)}` : ""}`;

/**
 * Run `fn` over `items`, never more than `limit` at a time.
 *
 * A shared queue rather than fixed-size batches: a batch finishes at the pace
 * of its slowest member, which is the starvation this whole design exists to
 * avoid, one level down.
 */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const worker = async (): Promise<void> => {
    for (;;) {
      const next = queue.shift();
      if (next === undefined) return;
      await fn(next);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, worker));
}

/**
 * One pass over every ticket the source can see, most urgent first.
 *
 * Tickets are independent, so one ticket running a long agent must not hold up
 * the rest: mutual exclusion is per ticket, and ticks themselves are allowed
 * to overlap. A global "is a tick running" guard would let a single ten-minute
 * step starve every other ticket in the repository.
 *
 * A busy ticket is skipped, not queued. It will still be there next tick, and
 * forcing in would mean two invocations resuming the same agent session.
 */
export async function tick(opts: TickOptions): Promise<TickRow[]> {
  const { deps } = opts;
  const started = Date.now();
  deps.log("tick.started", {});

  // Deliberately not caught here: with no graph there are no rows to report
  // a failure against, so the caller decides whether one bad poll stops the
  // loop (it does not — see runStart) or fails a command.
  const graph = await opts.source.list(deps.ctx);

  // A display must never be able to stop the work it is displaying.
  try {
    opts.onList?.(graph);
  } catch (e) {
    deps.log("display.failed", { reason: messageOf(e) });
  }

  // Open tickets only: a pull request in the list is context for a ticket,
  // and a closed ticket is there for its parent to count — neither is work. Sorted before the pool takes from it, because with a
  // concurrency limit the order is who waits — ordering work is not choosing
  // a transition, and the id tie-break keeps it total.
  const work = graph.nodes.filter(isOpenTicket).sort(compareWork);
  const rows: TickRow[] = [];

  await pool(work, opts.concurrency ?? DEFAULT_CONCURRENCY, async (node) => {
    const ticket = node.id;
    try {
      const problem = ticketIdProblem(ticket);
      if (problem) {
        // A source is a hook, and a hook's output is outside input: this id is
        // about to become a lock file name and a worktree directory.
        deps.log("ticket.skipped", { ticket, reason: problem });
        rows.push({ ticket, outcome: `error: ${oneLine(problem)}` });
        return;
      }

      const eligibility = eligibilityOf(deps.workflow, node);
      if (!eligibility.eligible) {
        // Skipped, not absent: a ticket nobody is working is exactly what an
        // operator running `landrace status` is trying to find out about.
        deps.log("ticket.skipped", { ticket, reason: eligibility.reason });
        rows.push({ ticket, outcome: `skipped: ${oneLine(eligibility.reason)}` });
        return;
      }

      const result = await withLock(
        ticket,
        "tick",
        () => {
          deps.log("lock.acquired", { ticket, kind: "tick" });
          return converge(ticket, {
            ...deps,
            source: opts.source,
            ctx: { ...deps.ctx, ticket } satisfies Omit<HookContext, "snapshot">,
          });
        },
        opts.lock,
      );
      rows.push({ ticket, outcome: outcomeOf(result) });
    } catch (e) {
      if (isLocked(e)) {
        deps.log("lock.denied", { ticket, kind: "tick" });
        rows.push({ ticket, outcome: oneLine(messageOf(e)) });
        return;
      }
      // One ticket's failure is one ticket's row. `messageOf`, not
      // `(e as Error).message`: a hook is a plain interface and nothing stops
      // one rejecting with a shape that throws on a property read, which would
      // take the whole tick down from inside the handler meant to report it.
      deps.log("ticket.skipped", { ticket, reason: messageOf(e) });
      rows.push({ ticket, outcome: `error: ${oneLine(messageOf(e))}` });
    }
  });

  // Sorted rather than left in completion order: the same repository in the
  // same state should print the same thing twice running, and completion order
  // is whichever agent happened to answer first.
  rows.sort((a, b) => compareIds(a.ticket, b.ticket));

  deps.log("tick.finished", { tickets: rows.length, duration: Date.now() - started });
  return rows;
}
