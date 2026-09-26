import { GOTO_KIND, RECORD_EFFECT } from "#conventions.js";
import { assess, compile, gotoDeclined, gotoNotListed, locate } from "#core/index.js";
import type { GotoDeps, GotoResult, Node } from "#namespace.js";
import { buildSnapshot, positionProblem } from "#runner/snapshot.js";

/**
 * A person sending a ticket back to a step: the board's Retry and "Go to
 * step…", and `landrace_goto`. `target` null is a Retry — `run.failedStage`,
 * the failure that put the ticket where it is. Never an older one it has
 * since been sent around: that one is still in `failedStages`, and a Retry
 * reading the list paid for a round nobody asked for.
 *
 * Read afresh, never from a listing a tick made: the ticket can have moved
 * since. Refused, with a sentence, wherever the engine would not take the
 * goto — a stage that does not list the target, or lists it with a cap that
 * does not hold — so the engine's own halt is only a backstop; and wherever
 * `decide` would never reach the goto at all: its own `requires` unsatisfied,
 * or its round still pending.
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
 * the ticket there with the goto it wrote already consumed.
 *
 * Locating the ticket can also find a stage a goto must not be written
 * against: `locate` may match one only by a custom `identity`, foreign to
 * the label `deriveRun` scopes the record to, and a goto recorded there
 * would be silently dropped on the very next read rather than ever taken.
 *
 * No lock, like `postReply`: this reads, checks and writes one record, and
 * the engine re-derives from whatever it finds, so a race costs one goto
 * taken a tick later, never a corrupted run.
 */
export async function sendTo(deps: GotoDeps, ticket: string, target: string | null): Promise<GotoResult> {
  const snapshot = await buildSnapshot({ ticket, source: deps.source, hooks: deps.pre, ctx: { ...deps.ctx, ticket } });
  const node = snapshot.node as Node | undefined;
  if (!node) return { refused: `#${ticket} was not found` };
  if (node.closed !== null) return { refused: `#${ticket} is closed, so there is nothing to send back` };
  const unplaceable = positionProblem(snapshot);
  if (unplaceable) return { refused: `#${ticket} cannot be placed: ${unplaceable}` };

  const where = locate(deps.workflow, snapshot);
  if (where.kind === "ambiguous") {
    return { refused: `#${ticket} matches more than one stage of this workflow: ${where.ids.join(", ")}` };
  }
  if (where.kind === "none") return { refused: `#${ticket} cannot be placed at any stage of this workflow` };
  const from = where.stage;

  // `deriveRun` reads a goto record back only while its own `stage` still
  // equals the ticket's *label* — never whatever locate() matched by a
  // custom identity. Writing one against a stage the label disagrees with
  // would be a write nothing ever reads.
  const label = snapshot.run?.stage ?? null;
  if (from.id !== label) {
    return {
      refused: `#${ticket} is at "${from.id}" only by a custom identity; its own stage label reads ` +
        `${label === null ? "no stage at all" : `"${label}"`}, and a goto recorded against "${from.id}" would never be read back`,
    };
  }

  if (from.requires && !compile(from.requires)(snapshot)) {
    return { refused: `#${ticket} is halted at "${from.id}": its precondition does not hold` };
  }

  if (from.step && assess(snapshot, from) === "pending") {
    return { refused: `#${ticket} is at "${from.id}", whose step is still to run; wait for its answer` };
  }

  const to = target ?? snapshot.run?.failedStage ?? null;
  if (to === null) return { refused: `nothing has failed on #${ticket}, so there is nothing to retry` };
  const refused = gotoNotListed(from, to) ?? gotoDeclined(from, snapshot, to);
  if (refused) return { refused: `#${ticket}: ${refused}` };

  await deps.dispatcher.apply(
    {
      type: RECORD_EFFECT, kind: GOTO_KIND, stage: from.id, round: 0,
      marker: `${GOTO_KIND}:${from.id}:${to}`, goto: to,
      body: `Sending this ticket back to ${to}, as asked.`,
    },
    { ...deps.ctx, ticket, snapshot },
  );
  return { to };
}
