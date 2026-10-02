import { CLEAR_KIND, GOTO_KIND, LABELS, RECORD_EFFECT } from "#conventions.js";
import { assess, checkEligible, compile, gotoDeclined, gotoNotListed, locate } from "#core/index.js";
import type { GotoDeps, GotoResult, Node, Snapshot, Stage, Workflow } from "#namespace.js";
import { withLock } from "#runner/lock.js";
import { buildSnapshot, positionProblem } from "#runner/snapshot.js";

/** Long enough to lose a race to a tick reading an item that waits, short enough that a click is answered. */
const WAIT_FOR_TICK_MS = 3_000;

/**
 * A person sending an item back to a step: the board's Retry and "Go to
 * step…", and `landrace_goto`. `target` null is a Retry — `run.failedStage`,
 * the failure that put the item where it is. Never an older one it has
 * since been sent around: that one is still in `failedStages`, and a Retry
 * reading the list paid for a round nobody asked for.
 *
 * Read afresh, never from a listing a tick made: the item can have moved
 * since. Refused, with a sentence, wherever the engine would not take the
 * goto — a stage that does not list the target, or lists it with a cap that
 * does not hold — so the engine's own halt is only a backstop; and wherever
 * `decide` would never reach the goto at all: an item the workflow's
 * `eligible` rules skip, a stage whose own `requires` is unsatisfied, or one
 * whose round is still pending.
 *
 * "Still pending" is asked of `assess()` — the exact function `decide` calls
 * — never re-derived here by hand. A stage whose latest round was *rejected*
 * also has `entered > output` (a rejection produces no output), and a
 * hand-rolled "still owed" check refused a goto there just as it refused one
 * mid-invocation; `assess` tells the two apart (`"failed"` first, checked
 * before completeness), so asking it directly is what keeps a goto and a
 * tick from ever disagreeing about whether a stage's agent might still be at
 * work. That distinction is not cosmetic: a judge sits "failed" rather than
 * "pending" once its verdict is rejected or its round is settled, with no
 * agent left at work either way, and a goto has to be able to reach it —
 * both because that is where a person overrides a verdict, and because a
 * crash between a target's entry comment and its status label can strand
 * the item there with the goto it wrote already consumed.
 *
 * Locating the item can also find a stage a goto must not be written
 * against: `locate` may match one only by a custom `identity` while a label
 * names another stage, and the run — a goto record with it — is read from
 * the label then, so a goto recorded there would be silently dropped on the
 * very next read rather than ever taken.
 *
 * Under the item's lock, the one a tick converges under, like
 * `landrace_resolve`: this reads, decides and writes, and that is what the
 * lock exists to make atomic. Without it a tick could move the item between
 * the read and the write, and the goto — recorded against a stage the item
 * has already left — would read as consumed, after the page had said "sent".
 * A tick holds the lock for as long as a step runs, so this waits only a
 * moment and then says so, rather than leaving a click hanging.
 */
export async function sendTo(
  deps: GotoDeps, item: string, target: string | null, opts: { clear?: boolean } = {},
): Promise<GotoResult> {
  try {
    return await withLock(item, "goto", () => sendAt(deps, item, target, opts.clear === true), { waitMs: WAIT_FOR_TICK_MS, ...deps.lock });
  } catch (e) {
    if ((e as { code?: unknown } | null)?.code === "ELOCKED") return { refused: `#${item} is busy; try again in a moment` };
    throw e;
  }
}

/**
 * The stage a person may send this item on from, or why there is none —
 * everything `sendTo` asks before it looks at the target. Shared with a
 * pairing, which enters a stage by the same rule a goto does: a pairing
 * started on a goto target, and a hand-in finished again after a refusal.
 */
export function gotoOrigin(workflow: Workflow, snapshot: Snapshot, item: string): { from: Stage } | { refused: string } {
  const node = snapshot.node as Node | undefined;
  if (!node) return { refused: `#${item} was not found` };
  if (node.closed !== null) return { refused: `#${item} is closed, so there is nothing to send back` };
  // decide() turns an ineligible item away before it reads anything else,
  // so a goto written on one would sit unread for as long as it stays so.
  const eligibility = checkEligible(workflow, snapshot);
  if (!eligibility.eligible) return { refused: `#${item} is not worked by this workflow: ${eligibility.reason}` };
  const unplaceable = positionProblem(snapshot);
  if (unplaceable) return { refused: `#${item} cannot be placed: ${unplaceable}` };

  const where = locate(workflow, snapshot);
  if (where.kind === "ambiguous") {
    return { refused: `#${item} matches more than one stage of this workflow: ${where.ids.join(", ")}` };
  }
  if (where.kind === "none") return { refused: `#${item} cannot be placed at any stage of this workflow` };
  const from = where.stage;

  // `deriveRun` reads a goto record back only against `run.stage`: the
  // stage label's stage, or, where the item has no label, the stage an
  // identity places it at. A label naming a different stage than the one the
  // item is located at is a contradiction, and a goto written against the
  // located stage would be a write nothing ever reads.
  const readAs = snapshot.run?.stage ?? null;
  if (from.id !== readAs) {
    return {
      refused: `#${item} is at "${from.id}" only by a custom identity; its own stage label reads ` +
        `${readAs === null ? "no stage at all" : `"${readAs}"`}, and a goto recorded against "${from.id}" would never be read back`,
    };
  }

  if (from.requires && !compile(from.requires)(snapshot)) {
    return { refused: `#${item} is halted at "${from.id}": its precondition does not hold` };
  }
  return { from };
}

async function sendAt(deps: GotoDeps, item: string, target: string | null, clear: boolean): Promise<GotoResult> {
  const snapshot = await buildSnapshot({ item, source: deps.source, hooks: deps.pre, workflow: deps.workflow, ctx: { ...deps.ctx, item } });
  const origin = gotoOrigin(deps.workflow, snapshot, item);
  if ("refused" in origin) return origin;
  const { from } = origin;

  if (from.step && assess(snapshot, from) === "pending") {
    return { refused: `#${item} is at "${from.id}", whose step is still to run; wait for its answer` };
  }

  // A clearance waives the screener, which only a security stop calls for.
  // The label, not `run.lastRefused`: at the halt that reads the halt's own
  // stage, which nothing refused.
  const labels = (snapshot.node as Node).state.labels;
  if (clear && !(Array.isArray(labels) && labels.includes(LABELS.screened))) {
    return { refused: `#${item} was not stopped by a security check, so there is nothing to clear` };
  }

  const to = target ?? snapshot.run?.failedStage ?? null;
  if (to === null) return { refused: `nothing has failed on #${item}, so there is nothing to retry` };
  const refused = gotoNotListed(from, to) ?? gotoDeclined(from, snapshot, to);
  if (refused) return { refused: `#${item}: ${refused}` };

  if (clear) {
    // The round decide() will enter `to` at, so the clearance covers exactly
    // the run this goto starts and nothing after it.
    const round = (snapshot.run?.counters[to] ?? 0) + 1;
    await deps.dispatcher.apply(
      {
        type: RECORD_EFFECT, kind: CLEAR_KIND, stage: to, round, marker: `${CLEAR_KIND}:${to}:${round}`,
        body: `Security check cleared by a person: ${to}, round ${round}, runs without prompt screening.`,
      },
      { ...deps.ctx, item, snapshot },
    );
  }

  await deps.dispatcher.apply(
    {
      type: RECORD_EFFECT, kind: GOTO_KIND, stage: from.id, round: 0,
      marker: `${GOTO_KIND}:${from.id}:${to}`, goto: to,
      body: `Sending this item back to ${to}, as asked.`,
    },
    { ...deps.ctx, item, snapshot },
  );
  return { to };
}
