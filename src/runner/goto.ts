import { GOTO_KIND, MALFORMED_KIND, RECORD_EFFECT, REFUSED_KIND } from "#conventions.js";
import { gotoDeclined, gotoNotListed, locate } from "#core/index.js";
import type { Entry, GotoDeps, GotoResult, Node } from "#namespace.js";
import { buildSnapshot, positionProblem } from "#runner/snapshot.js";

/** The stage whose round was last rejected — what a Retry re-runs — or null. */
const lastFailed = (entries: Entry[]): string | null =>
  [...entries]
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .reverse()
    .find((e) => e.byAgent && (e.kind === MALFORMED_KIND || e.kind === REFUSED_KIND))?.stage ?? null;

/**
 * A person sending a ticket back to a step: the board's Retry and "Go to
 * step…", and `landrace_goto`. `target` null is a Retry — the stage whose
 * round was last rejected.
 *
 * Read afresh, never from a listing a tick made: the ticket can have moved
 * since. Refused, with a sentence, wherever the engine would not take the
 * goto — a stage that does not list the target, or lists it with a cap that
 * does not hold — so the engine's own halt is only a backstop.
 *
 * Refused at a stage that runs a step only while that step's latest round is
 * still owed (`entered > output`), never merely because the stage runs one:
 * a judge sits settled once its verdict has landed, with no agent left at
 * work there, and a goto has to be able to reach it — both because that is
 * where a person overrides a verdict they disagree with, and because a crash
 * between a target's entry comment and its status label can strand the
 * ticket at the judge with the goto it wrote already consumed; "Go to
 * step…" is how that ticket is recovered without editing labels by hand.
 *
 * No lock, like `postReply`: this reads, checks and writes one record, and
 * the engine re-derives from whatever it finds, so a race costs one goto
 * taken a tick later, never a corrupted run.
 */
export async function sendTo(deps: GotoDeps, ticket: string, target: string | null): Promise<GotoResult> {
  const snapshot = await buildSnapshot({ ticket, source: deps.source, hooks: deps.pre, ctx: { ...deps.ctx, ticket } });
  const node = snapshot.node as Node | undefined;
  if (!node || node.closed !== null) return { refused: `#${ticket} is closed, so there is nothing to send back` };
  const unplaceable = positionProblem(snapshot);
  if (unplaceable) return { refused: `#${ticket} cannot be placed: ${unplaceable}` };
  const where = locate(deps.workflow, snapshot);
  if (where.kind !== "at") return { refused: `#${ticket} cannot be placed at any stage of this workflow` };
  const from = where.stage;

  // assess() reads this exact fallback for "no entry record at all" — any
  // output at all completes such a stage — so a goto is held to the same
  // notion of "still owed" the tick itself uses to decide whether to invoke.
  const rounds = snapshot.run?.rounds[from.id] ?? { entered: 1, output: 0 };
  if (from.step && rounds.entered > rounds.output) {
    return { refused: `#${ticket} is at "${from.id}", whose step is still to run; wait for its answer` };
  }

  const to = target ?? lastFailed(snapshot.entries ?? []);
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
