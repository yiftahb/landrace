/*
 * What every forge integration shares and none of them is: whose turn a
 * review thread is, the thread counts the review loop gates on, where a
 * review's findings can go on a diff, a pull request as the node the engine
 * routes on, the briefings a step is handed, and whether a push has landed.
 * Published as part of `landrace/kit`.
 *
 * Everything here works on plain neutral shapes — `ReviewThread`,
 * `ChangedFile` — which an integration maps its forge's answers into. What
 * stays with the integration is the forge's API: its queries, their paging,
 * the requests that post, reply and resolve, and every word said in the
 * forge's own name.
 */
import {
  BRANCH_PUSH_EFFECT, effectBranch, hasPullFrom, neutraliseMarkers, NODES_CLOSE_EFFECT, parseMarker, PULL_OPEN_EFFECT,
  PULL_REQUEST_KIND, PULL_REVIEW_EFFECT, RELATIONS, renderMarker, sameLogin, stripMarker,
} from "#conventions.js";
import { headIn, headsOf } from "#kit/git.js";
import { createdAtOf, MAX_COMMENT_CHARS, nodesCloseSatisfied, stillOpen, updatedAtOf, wroteIt } from "#kit/tracker.js";
import type {
  BranchHeads, BriefTable, ChangedFile, Effect, EffectTable, Finding, Graph, HistoryItem, HookContext, Node, PullRecord,
  RelationDecl, Relationship, Reply, ReviewThread, RuntimeContext, Snapshot, SnapshotComment, ThreadComment, ThreadCounts,
} from "#namespace.js";

export type { ChangedFile, Finding, Reply, ReviewThread, ThreadComment, ThreadCounts } from "#namespace.js";

/** The marker kind a finding's thread ends with: how a reviewer's own thread is told from a person's. */
export const FINDING_KIND = "finding";

/** The marker kind of fix-review's route, and of each reply it posts: the fixer has answered, and the thread is the person's turn. */
export const FIX_KIND = "fix";

/**
 * Whether a thread's last word is the fixer's answer — ours, by login and
 * marker both, since anyone with comment access can paste a marker. Anything
 * else last, or no reply at all, is a thread awaiting a fix.
 */
export const answered = (last: ThreadComment | null | undefined, bot: string): boolean =>
  typeof last?.author === "string" && sameLogin(last.author, bot) && parseMarker(last.body)?.kind === FIX_KIND;

/**
 * How many of these threads nobody has resolved, and how many of those await
 * a fix. Every page of them, or the integration refuses: a count over part of
 * a pull request's threads is a number known to be short.
 */
export function threadCounts(threads: Array<Pick<ReviewThread, "resolved" | "last">>, bot: string): ThreadCounts {
  const counts: ThreadCounts = { openThreads: 0, awaitingFix: 0 };
  for (const t of threads) {
    if (t.resolved) continue;
    counts.openThreads++;
    if (!answered(t.last, bot)) counts.awaitingFix++;
  }
  return counts;
}

export const isFinding = (f: unknown): f is Finding => {
  const x = f as Partial<Finding> | null;
  return typeof x === "object" && x !== null && typeof x.file === "string" && x.file !== "" &&
    Number.isInteger(x.line) && (x.line ?? 0) > 0 && typeof x.body === "string" && x.body.trim() !== "";
};

export const isReply = (r: unknown): r is Reply => {
  const x = r as Partial<Reply> | null;
  return typeof x === "object" && x !== null && typeof x.thread === "string" && x.thread !== "" &&
    typeof x.body === "string" && x.body.trim() !== "";
};

/**
 * The new-side lines a patch shows — added or unchanged context — which are
 * the lines a forge takes a line comment on. A removed line has no new-side
 * number, and a line outside every hunk is not in the diff at all.
 */
export function commentableLines(patch: string | undefined): Set<number> {
  const lines = new Set<number>();
  let next = 0;
  for (const row of (patch ?? "").split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) {
      next = Number(hunk[1]);
      continue;
    }
    if (next === 0 || row.startsWith("-") || row.startsWith("\\")) continue;
    lines.add(next++);
  }
  return lines;
}

/**
 * Where each of a review's findings can go, by what a forge accepts: a
 * finding on a line the diff shows is a line thread; one elsewhere in a
 * changed file is a thread on the file, naming the line; one in a file the
 * pull request does not touch cannot be threaded at all, and is listed in the
 * review's text instead. A malformed finding is listed the same way rather
 * than failing the step — the engine checks an output's fields, not what is
 * inside them.
 *
 * Each threaded body ends in its own finding marker, `finding:{stage}:{round}:{i}`,
 * which is how a reviewer later tells its own threads from a person's.
 */
export function placeFindings(findings: unknown[], changed: ChangedFile[], stage: string, round: number): {
  onLines: Array<{ path: string; line: number; body: string }>;
  onFiles: Array<{ path: string; body: string }>;
  unplaced: string[];
} {
  const lines = new Map(changed.map((f) => [f.path, commentableLines(f.patch)]));
  const onLines: Array<{ path: string; line: number; body: string }> = [];
  const onFiles: Array<{ path: string; body: string }> = [];
  const unplaced: string[] = [];
  findings.forEach((f, i) => {
    if (!isFinding(f)) {
      unplaced.push(`- ${neutraliseMarkers(cut(typeof f === "string" ? f : JSON.stringify(f) ?? String(f), BRIEF_BODY_CHARS))}`);
      return;
    }
    const tail = renderMarker({ stage, kind: FINDING_KIND, round, marker: `${FINDING_KIND}:${stage}:${round}:${i}` });
    const text = neutraliseMarkers(cut(f.body.trim(), MAX_COMMENT_CHARS - 1_000));
    const shown = lines.get(f.file);
    if (shown?.has(f.line)) onLines.push({ path: f.file, line: f.line, body: text + tail });
    else if (shown) onFiles.push({ path: f.file, body: `line ${f.line}: ${text}${tail}` });
    else unplaced.push(`- \`${f.file}:${f.line}\` — ${text}`);
  });
  return { onLines, onFiles, unplaced };
}

/**
 * Derived from the ticket, never stored — the same rule the spec's path
 * follows. There is no PR id to remember and nothing to repair: the branch
 * names the ticket, and every pull request with that head is its work.
 */
export const prBranch = (ticket: string): string => `landrace/${ticket}`;

/** The ticket a head branch names, when it is one of ours. */
export const ticketOfBranch = (head: string): string | null => /^landrace\/([1-9][0-9]*)$/.exec(head)?.[1] ?? null;

/**
 * The one mapping from a pull request, as an integration reads its forge's,
 * to a pull request node. Merged is done; closed without merging is dropped.
 *
 * `branch` is the head branch, so `pull.open` can tell one branch's pull
 * request from another's: a ticket has as many as its workflow's stages name.
 * An integration leaves it undefined for a fork's, whose branch is in another
 * repository and could carry any name — ours included — and so stand in for
 * the one we would open.
 */
export function pullNode(pull: Omit<PullRecord, "tickets">, threads?: ThreadCounts): Node {
  return {
    id: `pr-${pull.number}`,
    kind: PULL_REQUEST_KIND,
    title: pull.title,
    link: pull.link,
    closed: pull.merged ? "done" : pull.closed ? "dropped" : null,
    priority: null,
    origin: null,
    state: {
      merged: pull.merged,
      headSha: pull.headSha,
      ...(pull.branch === undefined ? {} : { branch: pull.branch }),
      ...threads,
    },
    ...createdAtOf(pull.createdAt),
    ...updatedAtOf(pull.updatedAt),
  };
}

/**
 * What the briefing carries, and it is not the same bound as the count's.
 *
 * Twenty findings is more than any one fix round can honestly address, and a
 * thousand characters is a long review comment. The count stays exact however
 * many there are — that is the gate — while the text is a working list, cut
 * with a line saying how much was left out so the agent is never told there
 * are three findings when there are fifty.
 */
export const BRIEF_THREADS = 20;
export const BRIEF_BODY_CHARS = 1000;

/**
 * The history's bounds: the newest of each kept, since the latest correction
 * is the one a retro most needs to see, with the older ones counted aloud.
 */
export const BRIEF_COMMENTS = 60;
export const BRIEF_HISTORY_THREADS = 40;
/** And of the one timeline both roles' entries share: the two bounds together. */
export const BRIEF_HISTORY_ITEMS = BRIEF_COMMENTS + BRIEF_HISTORY_THREADS;

/**
 * And what each of its two halves may spend. The engine cuts a hook's whole
 * briefing at 32 KB from the end, which on a long history would drop the
 * newest comments and every review thread first — the opposite of what the
 * retro needs. Two halves this size, and the short `threads` beside them
 * when the review has settled, stay inside it; the timeline spends both.
 */
export const BRIEF_HISTORY_HALF_CHARS = 14_000;

/** How much of the diff a reviewer's prompt carries; the rest is named, to read in the worktree. */
export const BRIEF_DIFF_CHARS = 24_000;

export const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

/** "src/x.ts:12", "src/x.ts", or nothing at all — a forge cannot always place a thread. */
export const where = (thread: Pick<ReviewThread, "path" | "line">): string =>
  thread.path === null ? "" : `${thread.path}${thread.line === null ? "" : `:${thread.line}`} — `;

/**
 * The newest of a list, rendered, oldest first: at most `keep` of them and
 * no more text than `budget` — one half of the history, unless said — and
 * the line saying how many earlier ones were left out.
 */
export function newest<T>(
  all: T[], keep: number, what: string, render: (item: T) => string, budget = BRIEF_HISTORY_HALF_CHARS,
): { kept: Array<{ item: T; text: string }>; left: string } {
  const kept: Array<{ item: T; text: string }> = [];
  let spent = 0;
  for (let i = all.length - 1; i >= 0 && kept.length < keep; i--) {
    const item = all[i] as T;
    const text = render(item);
    if (spent + text.length > budget) break;
    spent += text.length;
    kept.push({ item, text });
  }
  const dropped = all.length - kept.length;
  return {
    kept: kept.reverse(),
    left: dropped === 0 ? "" : `(${dropped} earlier ${what} are not listed here.)\n\n`,
  };
}

/**
 * The open review threads across every open pull request on the ticket —
 * `open` is their numbers, `read` every thread on each — rendered for a
 * prompt under one `## PR #N` heading each: whose turn each is, and its last
 * reply when it has one. The ones awaiting a fix come first, so the cut falls
 * on threads already answered.
 */
export function threadsBrief(open: number[], read: Map<number, ReviewThread[]>, bot: string): string {
  if (open.length === 0) return "There is no pull request open on this ticket, so there is nothing to address.";

  const unresolved = open.flatMap((pull) => (read.get(pull) ?? [])
    .filter((thread) => !thread.resolved)
    .map((thread) => ({ pull, thread, waiting: !answered(thread.last, bot) })));
  if (unresolved.length === 0) return "No review thread on the ticket's pull requests is open. Nothing here needs addressing.";
  // Stable, so each group keeps the forge's order.
  unresolved.sort((a, b) => Number(b.waiting) - Number(a.waiting));
  const shown = unresolved.slice(0, BRIEF_THREADS);
  const more = unresolved.length - shown.length;
  const text = (body: string | undefined): string => cut(stripMarker(body ?? "").trim(), BRIEF_BODY_CHARS);

  const sections = open.flatMap((pull) => {
    const here = shown.filter((s) => s.pull === pull);
    return here.length === 0 ? [] : [`## PR #${pull}\n\n${here.map(({ thread, waiting }, i) => {
      const opening = thread.first?.body ?? "";
      // The id is what a reviewer lists to resolve a thread, and only its
      // own may be: ours by the finding marker pull.review stamped.
      const ours = parseMarker(opening)?.kind === FINDING_KIND ? "(raised by the reviewer) " : "";
      const turn = waiting ? "[awaiting a fix] " : "[answered by the fixer, awaiting the person] ";
      const last = thread.last;
      const reply = thread.comments > 1 && last
        ? `\n   Last reply, from ${last.author !== null && sameLogin(last.author, bot) ? "Landrace" : `@${last.author ?? "ghost"}`}: ${text(last.body)}`
        : "";
      return `${i + 1}. [thread ${thread.id}] ${turn}${where(thread)}${ours}${text(opening)}${reply}`;
    }).join("\n\n")}`];
  });

  // Said out loud rather than left implicit: an agent shown twenty of fifty
  // findings and told nothing would report the pull request addressed.
  const tail = more === 0
    ? ""
    : `\n\n(${more} more open threads are not listed here, the ones awaiting a fix first. Address what is above; any still awaiting a fix come back next round.)`;

  return sections.join("\n\n") + tail;
}

/**
 * What the ticket's open pull requests change, file by file, for a reviewer
 * that has no shell to run `git diff` with. Files past the budget are listed
 * by name rather than dropped silently.
 */
export function diffBrief(open: Array<{ number: number; files: ChangedFile[] }>): string {
  if (open.length === 0) return "No pull request is open on this ticket, so there is no diff to review.";
  const parts: string[] = [];
  const unshown: string[] = [];
  let spent = 0;
  for (const pull of open) {
    parts.push(`## PR #${pull.number} — ${pull.files.length} files changed`);
    for (const f of pull.files) {
      const text = `### ${f.path} (${f.status}, +${f.additions} −${f.deletions})\n\n` +
        (f.patch === undefined ? "(no textual diff: binary, or too large for the forge to show)" : "```diff\n" + f.patch + "\n```");
      if (spent + text.length > BRIEF_DIFF_CHARS) {
        unshown.push(`- ${f.path} (+${f.additions} −${f.deletions})`);
        continue;
      }
      spent += text.length;
      parts.push(text);
    }
  }
  const tail = unshown.length === 0
    ? ""
    : `\n\n${unshown.length} more changed files are not shown here; read them in the worktree:\n${unshown.join("\n")}`;
  return parts.join("\n\n") + tail;
}

const briefText = (body: string | null | undefined): string => cut((body ?? "").trim(), BRIEF_BODY_CHARS);

/**
 * One ticket comment as the history shows it. Landrace's by the test
 * `entriesFromComments` applies — our login *and* our marker — so a person's
 * reply the board posted as the bot reads as that person's turn, not as a
 * record. The body is cut here; the engine bounds the whole on the way in.
 */
export function commentLine(c: SnapshotComment, bot: string): string {
  const marker = wroteIt(c, bot) ? parseMarker(c.body ?? "") : null;
  return marker
    ? `Landrace [${marker.marker ?? marker.kind}]: ${briefText(stripMarker(c.body ?? ""))}`
    : `@${c.user?.login ?? "ghost"}: ${briefText(c.body)}`;
}

/** One review thread as the history shows it: where, who raised it, whether it is settled, what it said, and its last reply. */
export function threadLine(thread: ReviewThread, bot: string): string {
  const ours = (login: string | null | undefined): boolean => typeof login === "string" && sameLogin(login, bot);
  const opening = thread.first;
  const last = thread.last;
  const by = ours(opening?.author) ? "Landrace's reviewer" : `@${opening?.author ?? "ghost"}`;
  const reply = thread.comments > 1 && last
    ? `\nLast reply, from ${ours(last.author) ? "Landrace" : `@${last.author ?? "ghost"}`}: ${briefText(last.body)}`
    : "";
  return `${where(thread)}raised by ${by} — ${thread.resolved ? "resolved" : "open"}\n${briefText(opening?.body)}${reply}`;
}

/**
 * The ticket's whole history, for the retro: every entry each role rendered —
 * the tracker's comments, the forge's review threads, resolved or not, merged
 * or not, because a correction that was argued and settled is exactly what a
 * retro learns from — as one timeline, oldest first, the newest kept.
 */
export function historyBrief(items: HistoryItem[]): string {
  if (items.length === 0) return "Nothing has been said on this ticket, and no review thread was raised on its pull requests.";
  const at = (item: HistoryItem): number => {
    const ms = Date.parse(item.at);
    return Number.isNaN(ms) ? 0 : ms;
  };
  // Stable, so entries at one moment keep the order their roles gave them.
  const ordered = [...items].sort((a, b) => at(a) - at(b));
  const { kept, left } = newest(ordered, BRIEF_HISTORY_ITEMS, "entries", (item) => item.text, 2 * BRIEF_HISTORY_HALF_CHARS);
  return left + kept.map((k) => k.text).join("\n\n");
}

/**
 * `branch.push`: done when origin's head, as this checkout last saw it, is
 * the local one. A branch the checkout does not have has nothing to publish —
 * pushing it would fail, not push — so that is done too.
 */
export function pushSatisfied(snapshot: Snapshot, effect: Effect): boolean {
  const branch = effectBranch(effect);
  const { local, remote } = headsOf(snapshot);
  const head = headIn(local, branch);
  return head === undefined || headIn(remote, branch) === head;
}

/** What follows `landrace/` in a pull request's head, whether or not it is a ticket. */
const headOf = (pull: Pick<PullRecord, "branch">): string | undefined => {
  const ours = prBranch("");
  return pull.branch?.startsWith(ours) ? pull.branch.slice(ours.length) : undefined;
};

/**
 * Every ticket a pull request names: the ones its own text does (`Closes #n`)
 * and the one a `landrace/{ticket}` head is for, when that is one of the
 * `known` tickets. A branch named any other way — `api/{ticket}`, a fork's —
 * names nothing: anybody can call a branch after any ticket, and only our own
 * head convention is ours. Nor does a `landrace/` head that is no ticket's —
 * `landrace/7-api`, a workflow's second branch for #7 — which a tracker whose
 * ids may carry a "-" could not otherwise tell from a ticket called "7-api".
 */
export function ticketsNamedBy(pull: Pick<PullRecord, "branch" | "tickets">, known: ReadonlySet<string>): Set<string> {
  const named = new Set(pull.tickets);
  const head = headOf(pull);
  if (head !== undefined && known.has(head)) named.add(head);
  return named;
}

/** The pull request number a `pr-{n}` node id stands for. */
const pullNumber = (id: string): number => {
  const n = /^pr-([1-9][0-9]*)$/.exec(id)?.[1];
  if (n === undefined) throw new Error(`"${id}" is not a pull request node`);
  return Number(n);
};

const isOpen = (pull: PullRecord): boolean => !pull.merged && !pull.closed;

/**
 * A forge integration: its vendor's calls, and nothing else.
 *
 * An integration extends this and writes the abstract methods, answered in
 * the plain shapes of `src/namespace.ts`. What is here is everything else a
 * forge does: which ticket each pull request implements and the thread counts
 * the review loop gates on, the branch heads a push is judged by, the three
 * publishing effects and its half of `nodes.close`, the `threads` and `diff`
 * briefings, and the review threads' place in the ticket's history.
 * `compose` makes the hooks out of it.
 *
 * To change one piece, subclass and override it: an effect by spreading
 * `super.effects()`, a briefing by spreading `super.briefs()`.
 */
export abstract class BaseForge {
  /** The login we post as here: whose turn a review thread is, by its last word. */
  abstract login(ctx: RuntimeContext): Promise<string>;
  /** Every open pull request, and any closed one the board should still show. */
  abstract pulls(ctx: RuntimeContext): Promise<PullRecord[]>;
  /** Every pull request tied to a ticket — from its `landrace/{ticket}` head, or naming it — merged and closed ones too. */
  abstract pullsNaming(ticket: string, ctx: RuntimeContext): Promise<PullRecord[]>;
  /** Every review thread on a pull request, resolved or not, every page — or a refusal, never a short list. */
  abstract threads(pull: number, ctx: RuntimeContext): Promise<ReviewThread[]>;
  /** What a pull request changes, file by file. */
  abstract changedFiles(pull: number, ctx: RuntimeContext): Promise<ChangedFile[]>;
  /** The body of every review posted on a pull request: its marker is what says a round is already there. */
  abstract reviews(pull: number, ctx: RuntimeContext): Promise<string[]>;
  /** Propose `branch` for `ticket`, naming the ticket in the forge's own way. */
  abstract openPull(pull: { ticket: string; branch: string; title: string }, ctx: RuntimeContext): Promise<void>;
  /** Close a pull request without merging it. */
  abstract closePull(pull: number, ctx: RuntimeContext): Promise<void>;
  /**
   * Post one review round: `files` as threads on their files, `lines` as
   * line threads inside the review, then the review itself with `body` —
   * last, because its marker is what says the round is on the forge.
   */
  abstract postReview(
    pull: number,
    review: {
      body: string;
      lines: Array<{ path: string; line: number; body: string }>;
      files: Array<{ path: string; body: string }>;
      head: string;
    },
    ctx: RuntimeContext,
  ): Promise<void>;
  abstract reply(thread: string, body: string, ctx: RuntimeContext): Promise<void>;
  abstract resolve(thread: string, ctx: RuntimeContext): Promise<void>;
  /** This checkout's branch heads, local and origin's, as `branchHeads` reads them. */
  abstract heads(ctx: RuntimeContext): Promise<BranchHeads>;
  /** Publish a branch to origin, with whatever credential the forge trusts it with — `pushBranch`, usually. */
  abstract push(branch: string, ticket: string, ctx: HookContext): Promise<void>;

  /** Run once at startup, before anything is paid for. */
  check?(ctx: RuntimeContext): Promise<void>;

  relations(): RelationDecl[] {
    return [{ type: RELATIONS.implements, singular: true }];
  }

  /** Exactly what `observe` puts in the snapshot. */
  provides(): string[] {
    return ["git", "git.local", "git.remote"];
  }

  /** The branch heads, read once a pass: `satisfied()` cannot ask git whether a push has landed. */
  async observe(ctx: HookContext): Promise<Record<string, unknown>> {
    return { git: await this.heads(ctx) };
  }

  /** A pull request as the node the engine routes on. */
  protected node(pull: PullRecord, threads?: ThreadCounts): Node {
    return pullNode(pull, threads);
  }

  /**
   * The pull requests tied to the listed tickets. One naming two tickets, or
   * one the list does not carry, is left out: the first is an ambiguity `read`
   * of either ticket halts on, and the second would be an edge that dangles.
   */
  async list(tickets: ReadonlySet<string>, ctx: RuntimeContext): Promise<Graph> {
    const nodes: Node[] = [];
    const relationships: Relationship[] = [];
    for (const pull of await this.pulls(ctx)) {
      const [only, ...more] = ticketsNamedBy(pull, tickets);
      if (only === undefined || more.length > 0 || !tickets.has(only)) continue;
      const node = this.node(pull);
      nodes.push(node);
      relationships.push({ from: node.id, to: only, type: RELATIONS.implements });
    }
    return { nodes, relationships };
  }

  /**
   * Every pull request tied to any of these tickets, merged and closed ones
   * included — "every pull request is merged" is a count over all of them.
   * One tied to two tickets halts: which it implements is not a guess. A
   * `landrace/` head counts for a ticket in this read, and for one outside
   * it when `isTicket` — the tracker — says it is one: #12's branch closing
   * #8 is tied to both, whichever is read.
   *
   * Only an open one's threads are counted. A thread left on a merged or
   * abandoned one is nothing a fix round can act on, and counting it would
   * loop the ticket through review for ever — so a closed one is zero, not
   * absent, which keeps "no thread awaits a fix" readable once all are merged.
   */
  async read(tickets: string[], ctx: RuntimeContext, isTicket: (id: string) => Promise<boolean>): Promise<Graph> {
    const nodes = new Map<number, Node>();
    const relationships: Relationship[] = [];
    const known = new Set(tickets);
    for (const ticket of tickets) {
      for (const pull of await this.pullsNaming(ticket, ctx)) {
        const named = ticketsNamedBy(pull, known);
        const head = headOf(pull);
        if (head !== undefined && !named.has(head) && (await isTicket(head))) named.add(head);
        if (named.size > 1) {
          throw new Error(
            `pull request #${pull.number} is tied to ${[...named].map((t) => `#${t}`).join(" and ")}; a pull request implements one ticket`,
          );
        }
        if (nodes.has(pull.number) || !named.has(ticket)) continue;
        const threads = isOpen(pull)
          ? threadCounts(await this.threads(pull.number, ctx), await this.login(ctx))
          : { openThreads: 0, awaitingFix: 0 };
        const node = this.node(pull, threads);
        nodes.set(pull.number, node);
        relationships.push({ from: node.id, to: ticket, type: RELATIONS.implements });
      }
    }
    return { nodes: [...nodes.values()], relationships };
  }

  effects(): EffectTable {
    return {
      [BRANCH_PUSH_EFFECT]: {
        satisfied: pushSatisfied,
        apply: (effect, ctx) => this.push(effectBranch(effect), ctx.ticket, ctx),
      },
      [PULL_OPEN_EFFECT]: {
        satisfied: (snapshot, effect) =>
          hasPullFrom(snapshot.graph as Graph | undefined, (snapshot.node as Node | undefined)?.id, effectBranch(effect)),
        apply: async (effect, ctx) => {
          const branch = effectBranch(effect);
          // Asked of the checkout first: a branch that is nowhere has nothing
          // to propose, and a forge's own answer to it names neither the
          // ticket nor why.
          const { local, remote } = headsOf(ctx.snapshot);
          if (headIn(local, branch) === undefined && headIn(remote, branch) === undefined) {
            throw new Error(
              `cannot open a pull request for #${ctx.ticket} from ${branch}: this checkout has no such branch, ` +
              "so no step has committed anything to it",
            );
          }
          const title = (ctx.snapshot.node as Node | undefined)?.title ?? `#${ctx.ticket}`;
          await this.openPull({ ticket: ctx.ticket, branch, title }, ctx);
        },
      },
      [PULL_REVIEW_EFFECT]: {
        // Asked of the forge by apply() itself, by the review's marker: the
        // snapshot carries no reviews, and a step's route effect is planned
        // once, right after its step.
        satisfied: (_snapshot, effect) => {
          effectBranch(effect);
          return false;
        },
        apply: (effect, ctx) => this.review(effect, ctx),
      },
      [NODES_CLOSE_EFFECT]: {
        satisfied: nodesCloseSatisfied,
        apply: async (effect, ctx) => {
          for (const id of stillOpen(ctx.snapshot, effect)) await this.closePull(pullNumber(id), ctx);
        },
      },
    };
  }

  /** `threads`, what is left to address on the ticket's open pull requests, and `diff`, what they change. */
  briefs(): BriefTable {
    const open = async (ctx: HookContext): Promise<PullRecord[]> => (await this.pullsNaming(ctx.ticket, ctx)).filter(isOpen);
    return {
      threads: async (ctx) => {
        const pulls = await open(ctx);
        const read = new Map<number, ReviewThread[]>();
        for (const pull of pulls) read.set(pull.number, await this.threads(pull.number, ctx));
        return threadsBrief(pulls.map((p) => p.number), read, await this.login(ctx));
      },
      diff: async (ctx) => {
        const changed: Array<{ number: number; files: ChangedFile[] }> = [];
        for (const pull of await open(ctx)) changed.push({ number: pull.number, files: await this.changedFiles(pull.number, ctx) });
        return diffBrief(changed);
      },
    };
  }

  /** Every review thread on every pull request tied to the ticket, for the history's one timeline. */
  async history(ctx: HookContext): Promise<HistoryItem[]> {
    const bot = await this.login(ctx);
    const items: HistoryItem[] = [];
    for (const pull of await this.pullsNaming(ctx.ticket, ctx)) {
      const state = pull.merged ? "merged" : pull.closed ? "closed" : "open";
      for (const thread of await this.threads(pull.number, ctx)) {
        items.push({ at: thread.at ?? "", text: `On PR #${pull.number} (${state}): ${threadLine(thread, bot)}` });
      }
    }
    return items;
  }

  /**
   * `pull.review`: a step's replies on the threads they name, a thread per
   * finding, its prose as one review, and the reviewer's own threads it lists
   * as addressed resolved.
   *
   * The step is told apart by its route's marker — `fix:{round}` for a fix
   * round, `review:{round}` for a review — and that kind is what each reply
   * ends in: a `fix` one hands the thread to the person, any other puts it
   * back to awaiting a fix. A fix round resolves nothing; a review resolves
   * only its own findings. Each reply is idempotent by its own marker, and the
   * review by the round's, checked on the forge itself: the one way it runs
   * twice is a crash before the record, which re-runs the step at its round.
   */
  protected async review(effect: Effect, ctx: HookContext): Promise<void> {
    const { snapshot, log } = ctx;
    const branch = effectBranch(effect);
    const out = (effect.output ?? {}) as { findings?: unknown; resolved?: unknown; replies?: unknown };
    const findings = Array.isArray(out.findings) ? out.findings : [];
    const replies = Array.isArray(out.replies) ? out.replies.filter(isReply) : [];
    const stage = String(effect.stage ?? "review");
    const round = Number(effect.round ?? 0);
    const marker = String(effect.marker ?? `review:${stage}:${round}`);
    const kind = marker.split(":")[0] || "review";
    const resolved = kind === FIX_KIND || !Array.isArray(out.resolved)
      ? []
      : out.resolved.filter((id): id is string => typeof id === "string");
    const fromBranch = ((snapshot.graph as Graph | undefined)?.nodes ?? []).filter(
      (node) => node.kind === PULL_REQUEST_KIND && node.state.branch === branch,
    );
    const pr = fromBranch.find((node) => node.closed === null);
    if (!pr) {
      // Merged or closed while the review ran — or a clean review with no
      // pull request left to put it on — is nothing to fix, and halting would
      // hold the ticket back from done. No pull request from the branch at
      // all is a route naming the wrong branch, and that is said.
      if ((findings.length === 0 && resolved.length === 0 && replies.length === 0) || fromBranch.length > 0) {
        log("forge.review.nowhere", { branch, findings: findings.length, why: "no open pull request from the branch" });
        return;
      }
      throw new Error(`there is no open pull request from ${branch} to put the review on`);
    }
    const number = pullNumber(pr.id);

    const threads = replies.length > 0 || resolved.length > 0
      ? new Map((await this.threads(number, ctx)).map((t) => [t.id, t]))
      : new Map<string, ReviewThread>();

    // Replies first, the review last: its marker says the round is posted.
    const bot = replies.length > 0 ? await this.login(ctx) : "";
    for (const reply of replies) {
      const thread = threads.get(reply.thread);
      if (!thread) {
        log("forge.review.unrepliable", { thread: reply.thread, why: "no such thread on the pull request" });
        continue;
      }
      const said = `${kind}:${stage}:${round}:${thread.id}`;
      const last = thread.last;
      if (typeof last?.author === "string" && sameLogin(last.author, bot) && parseMarker(last.body)?.marker === said) continue;
      await this.reply(
        thread.id,
        neutraliseMarkers(cut(reply.body.trim(), MAX_COMMENT_CHARS - 1_000)) + renderMarker({ stage, kind, round, marker: said }),
        ctx,
      );
    }

    const posted = (await this.reviews(number, ctx)).some((body) => parseMarker(body)?.marker === marker);
    if (!posted) {
      const { onLines, onFiles, unplaced } = placeFindings(findings, await this.changedFiles(number, ctx), stage, round);
      const listed = unplaced.length === 0 ? "" : `\n\nFindings that cannot be placed on this pull request's diff:\n\n${unplaced.join("\n")}`;
      const body = cut(neutraliseMarkers(String(effect.body ?? "").trim()) + listed, MAX_COMMENT_CHARS - 1_000) +
        renderMarker({ stage, kind, round, marker });
      const head = typeof pr.state.headSha === "string" ? pr.state.headSha : "";
      await this.postReview(number, { body, lines: onLines, files: onFiles, head }, ctx);
    }

    for (const id of resolved) {
      const thread = threads.get(id);
      if (!thread || parseMarker(thread.first?.body ?? "")?.kind !== FINDING_KIND) {
        // A person's thread is theirs to close, and an id not on the pull
        // request is a mistake worth seeing: said, never silently dropped.
        log("forge.review.unresolvable", { thread: id, why: thread ? "a person raised it" : "no such thread on the pull request" });
        continue;
      }
      if (!thread.resolved) await this.resolve(id, ctx);
    }
  }
}
