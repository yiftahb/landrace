import { createHash } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";

import { screenPrompt } from "#agent/screen.js";
import { ensureWorktree, pathFor, removeWorktree, worktreeOf, worktreeState } from "#agent/worktree.js";
import {
  CHILD_SERVER_NAME,
  durationMs,
  MALFORMED_KIND,
  mayCreateTickets,
  mayWriteRepo,
  PAIR_BY,
  PAIR_KIND,
  pairSessionId,
  RECORD_EFFECT,
  REFUSED_KIND,
  RELEASE_KIND,
  shellLine,
} from "#conventions.js";
import { assess, gotoDeclined, gotoNotListed, gotoTargetsOf, planEffects, reconcile, stageBranch } from "#core/index.js";
import type {
  Effect, Entry, PairDeps, PairFinished, PairingView, PairOffer, PairStarted, Pairing, Snapshot, Stage, Step,
} from "#namespace.js";
import { buildBriefing } from "#runner/artifacts.js";
import { stepTimeoutMs } from "#runner/budget.js";
import { childServerFor } from "#runner/children.js";
import { malformedEffect } from "#runner/converge.js";
import { messageOf } from "#runner/errors.js";
import { scrubberOf } from "#runner/events.js";
import { gotoOrigin } from "#runner/goto.js";
import { withLock } from "#runner/lock.js";
import { buildSnapshot } from "#runner/snapshot.js";
import { renderPrompt, sandboxBefore, sandboxTrespass, settleOutput } from "#runner/step.js";
import { repoDigest } from "#sandbox.js";

/** Long enough to lose a race to a tick reading a ticket that waits, short enough that a click is answered. */
const WAIT_FOR_TICK_MS = 3_000;

/** A hand-in runs an agent turn, and the lock has to outlast it; `withLock` refreshes it meanwhile. */
const PAIR_DEADLINE_MS = 15 * 60_000;

/**
 * Where a pairing's session works: beside the ticket's own worktree, never in
 * it. The tick and a conversation cut and remove `<ticket>` as they run, and
 * the agent's session is found by the directory it ran in — so the person's
 * checkout has to be one nothing else touches, at a path that stays put from
 * the command they copied to the turn that closes it.
 */
const slotOf = (ticket: string): string => `${ticket}.pair`;

/**
 * Where the seeded prompt waits for the person's shell to read it: beside the
 * pairing's checkout, never in it — the person's session could commit it — nor
 * in the repository's git directory. A step's sandbox may write both, and a
 * seed swapped there after screening would be pasted into a session no
 * sandbox confines.
 */
const seedOf = async (root: string, ticket: string): Promise<string> => `${await pathFor(slotOf(ticket), root)}.prompt.md`;

/**
 * What the seeded prompt says before the step's own words: that a person
 * leads, and that the answer is asked for when they finish — so the session
 * does not close itself with one the moment it opens.
 */
const PAIRING_PREAMBLE =
  "You are pairing with a person on this step, in their own terminal. They lead: work it with them, answer " +
  "what they ask, and change course when they say so. When they are done they finish the pairing from " +
  "Landrace, and you will then be asked for the step's answer — so do not close the step with that answer " +
  "on your own.\n\nThe step, as Landrace would have run it:\n\n";

/** The closing turn: the step's answer, from the session the person worked in. */
const finishPrompt = (note: string | undefined): string =>
  "The person you have been pairing with is done with this step" +
  (note?.trim() ? `, and says:\n\n${note.trim()}\n\n` : ".\n\n") +
  "Give the step's answer now, exactly as the step asked for it at the start of this session: everything " +
  "it asked you to write, from the work as it stands now, ending with its fenced json block as the very " +
  "last thing, with nothing after it.";

const sha1 = (data: Uint8Array): Uint8Array => new Uint8Array(createHash("sha1").update(data).digest());

const ordered = (s: Snapshot): Entry[] =>
  [...(s.entries ?? [])].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

/** The round a stage would work next, counted as decide() counts it. */
const nextRound = (s: Snapshot, stage: string): number => (s.run?.counters[stage] ?? 0) + 1;

/** The latest session the agent left at a stage — a step's own, or a turn on it — for "Continue … together". */
const agentSession = (s: Snapshot, stage: string): string | null =>
  ordered(s).findLast((e) => e.stage === stage && e.session !== undefined)?.session ?? null;

function stepOf(deps: PairDeps, id: string): { stage: Stage; step: Step } {
  const stage = deps.workflow.stages.find((s) => s.id === id);
  const step = stage?.step === undefined ? undefined : deps.steps.get(stage.step);
  if (!stage || !step) throw new Error(`"${id}" is not a stage with a step this process has loaded`);
  return { stage, step };
}

/** A pairing's session, derived from where it is — never remembered, so a retried start hands out the same one. */
const sessionOf = (root: string, ticket: string, p: Pick<Pairing, "stage" | "round" | "n">): string =>
  pairSessionId(sha1, { repo: repoDigest(root), ticket, stage: p.stage, round: p.round, n: p.n });

function locked<T>(deps: PairDeps, ticket: string, what: string, fn: () => Promise<T>): Promise<T> {
  // The tick's own lock, taken the way a goto takes it: a pairing reads,
  // decides and writes, and a tick in between would act on what it is
  // about to change.
  return withLock(ticket, "pair", fn, {
    holder: `pair:${what}:${process.pid}`, waitMs: WAIT_FOR_TICK_MS, deadlineMs: PAIR_DEADLINE_MS, ...deps.lock,
  }).catch((e: unknown) => {
    if ((e as { code?: unknown } | null)?.code === "ELOCKED") throw new Error(`#${ticket} is busy; try again in a moment`);
    throw e;
  });
}

const snapshotOf = (deps: PairDeps, ticket: string): Promise<Snapshot> =>
  buildSnapshot({ ticket, source: deps.source, hooks: deps.pre, ctx: { ...deps.ctx, ticket } });

async function apply(deps: PairDeps, ticket: string, snapshot: Snapshot, effects: Effect[]): Promise<void> {
  for (const effect of effects) await deps.dispatcher.apply(effect, { ...deps.ctx, ticket, snapshot });
}

/**
 * Enter `to` from where the ticket is, at `round`: its on_enter planned as a
 * transition would plan it, with whatever already landed reconciled away — so
 * a start retried after a crash re-applies only what is missing.
 */
async function enter(deps: PairDeps, ticket: string, snapshot: Snapshot, from: Stage, to: Stage, round: number): Promise<void> {
  const planned = planEffects({ action: "transition", stage: from, to, round }, snapshot, ticket);
  await apply(deps, ticket, snapshot, reconcile(snapshot, planned, deps.dispatcher.satisfied));
}

async function screened(deps: PairDeps, prompt: Parameters<typeof screenPrompt>[0], what: string): Promise<void> {
  if (!deps.screen) return;
  const verdict = await screenPrompt(prompt, {
    executor: deps.screen.executor, model: deps.screen.model,
    timeoutMs: stepTimeoutMs(deps.workflow), signal: deps.ctx.signal, log: deps.ctx.log,
  });
  if (!verdict.ok) throw new Error(`screening blocked ${what}: ${verdict.reason}`);
}

/**
 * What a person may pair on now. The stage's own step while its round is
 * owed; otherwise each step the stage may send the ticket to by a goto, under
 * the same checks and caps a goto is held to. Nothing without an agent that
 * can hand a session over, or a sandbox for one, and nothing while a pairing
 * is already open.
 */
export function pairOffers(deps: PairDeps, snapshot: Snapshot, ticket: string): PairOffer[] {
  if (!deps.executor?.handoff || !deps.sandbox || !snapshot.run || snapshot.run.pairing) return [];
  const origin = gotoOrigin(deps.workflow, snapshot, ticket);
  if ("refused" in origin) return [];
  const { from } = origin;
  const offer = (stage: Stage): PairOffer =>
    ({ stage: stage.id, round: nextRound(snapshot, stage.id), continue: agentSession(snapshot, stage.id) !== null });
  const loaded = (stage: Stage | undefined): stage is Stage => stage?.step !== undefined && deps.steps.has(stage.step);

  if (from.step !== undefined && assess(snapshot, from) === "pending") return loaded(from) ? [offer(from)] : [];
  return gotoTargetsOf(from).flatMap((g) => {
    const to = deps.workflow.stages.find((s) => s.id === g.stage);
    if (!loaded(to) || gotoNotListed(from, to.id) !== null || gotoDeclined(from, snapshot, to.id) !== null) return [];
    return [offer(to)];
  });
}

/** The panel's Pairing section: the pairing open now, and what else may be paired on. */
export async function pairingView(deps: PairDeps, ticket: string): Promise<PairingView> {
  const snapshot = await snapshotOf(deps, ticket);
  return { open: snapshot.run?.pairing ?? null, offers: pairOffers(deps, snapshot, ticket) };
}

/**
 * Start pairing on `stageId`, or — for the pairing already open there — hand
 * its command back again.
 *
 * The pair record goes first, before the stage's on_enter: a crash between
 * the two leaves a ticket that is held, never one whose step runs alone, and
 * the retry re-applies the entry with whatever landed reconciled away. The
 * seeded prompt is screened before anything is written at all.
 */
export function startPair(deps: PairDeps, ticket: string, stageId: string): Promise<PairStarted> {
  return locked(deps, ticket, "start", async () => {
    const executor = deps.executor;
    const handoff = executor?.handoff;
    if (!executor || !handoff) {
      throw new Error("cannot pair: the agent executor cannot hand a session to a person");
    }
    const root = deps.sandbox?.root;
    if (root === undefined) throw new Error("cannot pair: a pairing needs a checkout of its own, and agent.isolation is not worktree");

    const snapshot = await snapshotOf(deps, ticket);
    const open = snapshot.run?.pairing ?? null;
    if (open !== null && open.stage !== stageId) {
      throw new Error(`#${ticket} is already pairing on "${open.stage}"; finish or release that pairing first`);
    }

    let pairing: Pick<Pairing, "stage" | "round" | "n">;
    if (open !== null) {
      pairing = open;
    } else {
      const offers = pairOffers(deps, snapshot, ticket);
      const offer = offers.find((o) => o.stage === stageId);
      if (!offer) {
        throw new Error(offers.length
          ? `#${ticket} cannot pair on "${stageId}" now; it may pair on ${offers.map((o) => `"${o.stage}"`).join(" or ")}`
          : `#${ticket} has no step to pair on now`);
      }
      const earlier = ordered(snapshot).filter((e) => e.kind === PAIR_KIND && e.stage === stageId && e.round === offer.round);
      pairing = { stage: stageId, round: offer.round, n: earlier.length + 1 };
    }
    const { stage, step } = stepOf(deps, pairing.stage);

    const briefing = await buildBriefing([...(deps.artifacts ?? []), deps.source], { ...deps.ctx, ticket, snapshot }, step.prompt);
    const prompt = PAIRING_PREAMBLE + renderPrompt(step.prompt, snapshot, briefing);
    await screened(deps, (quote) => PAIRING_PREAMBLE + renderPrompt(step.prompt, snapshot, briefing, quote), "this pairing");

    if (open === null) {
      await apply(deps, ticket, snapshot, [{
        type: RECORD_EFFECT, kind: PAIR_KIND, stage: stage.id, round: pairing.round,
        marker: `${PAIR_KIND}:${stage.id}:${pairing.round}:${pairing.n}`,
        body: `Pairing on ${stage.id}, round ${pairing.round}: a person is working this round with the agent in ` +
          "their own session. It runs alone again only once they release it.",
      }]);
    }
    // Entered unless the stage already has been at the pairing's round —
    // not where the ticket stands, which a refused hand-in moves to a halt
    // with that round entered, and asking for the command again must leave
    // it there. A stage that lists itself as a goto target rests at its
    // settled round — build, when publish's push fails — and pairing on it
    // enters the next. The one entered round still entered again is a crash
    // between its record and its status: owed, with the ticket elsewhere.
    const origin = gotoOrigin(deps.workflow, snapshot, ticket);
    if (!("refused" in origin)) {
      const entered = snapshot.run?.rounds[stage.id]?.entered ?? 0;
      const unfinished = origin.from.id !== stage.id && assess(snapshot, stage) === "pending";
      if (entered < pairing.round || unfinished) await enter(deps, ticket, snapshot, origin.from, stage, pairing.round);
    }

    const branch = stageBranch(stage, ticket, pairing.round);
    if (!branch.ok) throw new Error(branch.reason);
    const on = branch.branch === null ? undefined : { branch: branch.branch, write: mayWriteRepo(step.capabilities) };
    // Found before it is cut: the person may already be working in it, and
    // cutting again would rebuild a checkout that has fallen behind.
    const cwd = (await worktreeOf(slotOf(ticket), root)) ?? (await ensureWorktree(ticket, root, on, slotOf(ticket)));

    // The seed holds ticket text anyone can write, and the command is pasted
    // into a terminal, which acts on control characters before any shell
    // quoting is read. So the command names this file, never its contents.
    // Created afresh, never written through what is already there: a link
    // at the path would have the engine write ticket text wherever it points.
    const promptFile = await seedOf(root, ticket);
    await rm(promptFile, { force: true });
    await writeFile(promptFile, prompt, { flag: "wx", mode: 0o600 });

    const session = sessionOf(root, ticket, pairing);
    const resume = agentSession(snapshot, stage.id);
    const hand = await handoff({
      cwd, session, promptFile,
      ...(resume === null ? {} : { resume }),
      // The person's own way back to Landrace. Nothing on it is allowed
      // ahead of time: the person approves each call their session makes.
      ...(deps.server ? { server: { name: CHILD_SERVER_NAME, ...deps.server, tools: [] } } : {}),
    });
    return {
      stage: stage.id, round: pairing.round, session, cwd: hand.cwd,
      command: `cd ${shellLine([hand.cwd])} && ${shellLine(hand.argv)}`,
    };
  });
}

/**
 * Hand the pairing's work in: a closing turn, forked from the person's
 * session, asked for the step's answer — held to the step's own contract and
 * recorded as the pair's, after which the ticket moves on by its triggers.
 *
 * Refused or malformed, the round is recorded as rejected like a step's and
 * the ticket halts, with the pairing left open. Finishing again then enters
 * the stage anew at its next round, by the same checks a goto is held to, and
 * closes it there.
 */
export function finishPair(deps: PairDeps, ticket: string, note?: string): Promise<PairFinished> {
  return locked(deps, ticket, "finish", async () => {
    const executor = deps.executor;
    if (!executor) throw new Error("cannot finish: no agent executor is configured");
    const root = deps.sandbox?.root;
    if (root === undefined) throw new Error("cannot finish: a pairing needs a checkout of its own, and agent.isolation is not worktree");

    let snapshot = await snapshotOf(deps, ticket);
    const open = snapshot.run?.pairing ?? null;
    if (open === null) throw new Error(`#${ticket} has no pairing to finish`);
    const { stage, step } = stepOf(deps, open.stage);

    const origin = gotoOrigin(deps.workflow, snapshot, ticket);
    if ("refused" in origin) throw new Error(`cannot finish: ${origin.refused}`);
    const round = nextRound(snapshot, stage.id);
    // Where the ticket stands, settled is a round a crash left unentered —
    // entered here like any goto target; only a rejected one waits for the halt.
    const here = origin.from.id === stage.id ? assess(snapshot, stage) : null;
    if (here !== "pending") {
      if (here === "failed") {
        throw new Error(`#${ticket}'s last hand-in on "${stage.id}" was refused; once the ticket has halted, finish again`);
      }
      const refused = gotoNotListed(origin.from, stage.id) ?? gotoDeclined(origin.from, snapshot, stage.id);
      if (refused) throw new Error(`cannot finish #${ticket}'s pairing: ${refused}`);
      await enter(deps, ticket, snapshot, origin.from, stage, round);
      snapshot = await snapshotOf(deps, ticket);
    }

    const branch = stageBranch(stage, ticket, round);
    if (!branch.ok) throw new Error(branch.reason);
    const on = branch.branch === null ? undefined : { branch: branch.branch, write: mayWriteRepo(step.capabilities) };
    const cwd = (await worktreeOf(slotOf(ticket), root)) ?? (await ensureWorktree(ticket, root, on, slotOf(ticket)));
    const sandbox = { path: cwd };

    const scrub = scrubberOf(deps.ctx.secrets, deps.scrub);
    const reject = async (kind: "contract" | "refused", reason: string): Promise<never> => {
      await apply(deps, ticket, snapshot, [malformedEffect(stage.id, round, reason, scrub, kind === "refused" ? REFUSED_KIND : MALFORMED_KIND)]);
      throw new Error(`the hand-in was refused: ${reason}. #${ticket} halts with the pairing still open; finish again once it has`);
    };

    // Read now, not when the pairing began: what the person changed while
    // they worked is theirs, and only the closing turn is held to the step.
    const start = await sandboxBefore(sandbox, step.capabilities);
    if (!start.ok) return reject("refused", start.reason);

    const prompt = finishPrompt(note);
    try {
      await screened(deps, prompt, "this hand-in");
    } catch (e) {
      return reject("refused", messageOf(e));
    }

    const timeoutMs = (step.timeout === undefined ? null : durationMs(step.timeout)) ?? stepTimeoutMs(deps.workflow);
    const limit = AbortSignal.timeout(timeoutMs);
    let text: string;
    let sessionId: string | null;
    try {
      ({ text, sessionId } = await executor.run(prompt, {
        round,
        resume: sessionOf(root, ticket, open),
        fork: true,
        cwd,
        capabilities: step.capabilities ?? [],
        ...(step.model === undefined ? {} : { model: step.model }),
        ...(step.effort === undefined ? {} : { effort: step.effort }),
        timeoutMs,
        ...(mayCreateTickets(step.capabilities) && deps.childServer
          ? { child: { parent: ticket, stage: stage.id, round, server: childServerFor(deps.childServer, { parent: ticket, stage: stage.id, round }) } }
          : {}),
        signal: AbortSignal.any([deps.ctx.signal, limit]),
      }));
    } catch (e) {
      // Nothing was produced, so nothing is rejected: the pairing stays open
      // exactly as it was, and Finish may simply be asked again.
      throw new Error(limit.aborted ? `the closing turn ran past its ${timeoutMs}ms limit` : `the closing turn did not run: ${messageOf(e)}`);
    }

    const trespass = await sandboxTrespass(sandbox, start.before);
    if (trespass) return reject("refused", trespass);

    const settled = settleOutput({ step, ticket, stageId: stage.id, round, text, sessionId, by: PAIR_BY });
    if (!settled.ok) return reject(settled.kind === "refused" ? "refused" : "contract", settled.reason);
    // The destination first, then the record, as a step's are applied.
    await apply(deps, ticket, snapshot, settled.effects);

    // The output is recorded; what is still uncommitted goes with the
    // worktree, and the person is told what that was.
    const discarded = await worktreeState(cwd).then((s) => s.changes, () => []);
    await removeWorktree(ticket, root, slotOf(ticket));
    await rm(await seedOf(root, ticket), { force: true });
    return { stage: stage.id, round, discarded };
  });
}

/** Give the round back to the agent: a release record closes the pairing, and the next tick runs the step alone. */
export function releasePair(deps: PairDeps, ticket: string): Promise<{ stage: string; round: number }> {
  return locked(deps, ticket, "release", async () => {
    const snapshot = await snapshotOf(deps, ticket);
    const open = snapshot.run?.pairing ?? null;
    if (open === null) throw new Error(`#${ticket} has no pairing to release`);
    await apply(deps, ticket, snapshot, [{
      type: RECORD_EFFECT, kind: RELEASE_KIND, stage: open.stage, round: open.round,
      marker: `${RELEASE_KIND}:${open.stage}:${open.round}:${open.n}`,
      body: `Released the pairing on ${open.stage}, round ${open.round}: the agent runs it alone.`,
    }]);
    if (deps.sandbox) {
      await removeWorktree(ticket, deps.sandbox.root, slotOf(ticket));
      await rm(await seedOf(deps.sandbox.root, ticket), { force: true });
    }
    return { stage: open.stage, round: open.round };
  });
}
