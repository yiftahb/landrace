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
  effectBranch, neutraliseMarkers, parseMarker, PULL_REQUEST_KIND, renderMarker, sameLogin, stripMarker,
} from "#conventions.js";
import { headIn, headsOf } from "#kit/git.js";
import { createdAtOf, MAX_COMMENT_CHARS, wroteIt } from "#kit/tracker.js";
import type {
  ChangedFile, Effect, Finding, Node, Reply, ReviewThread, Snapshot, SnapshotComment, ThreadComment, ThreadCounts,
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
export function pullNode(
  pull: {
    number: number;
    title: string;
    link: string;
    merged: boolean;
    closed: boolean;
    headSha: string;
    branch: string | undefined;
    createdAt: string | undefined;
  },
  threads?: ThreadCounts,
): Node {
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

/**
 * And what each of its two halves may spend. The engine cuts a hook's whole
 * briefing at 32 KB from the end, which on a long history would drop the
 * newest comments and every review thread first — the opposite of what the
 * retro needs. Two halves this size, and the short `threads` beside them
 * when the review has settled, stay inside it.
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
 * no more text than one half of the history may spend — and the line saying
 * how many earlier ones were left out.
 */
export function newest<T>(all: T[], keep: number, what: string, render: (item: T) => string): { kept: Array<{ item: T; text: string }>; left: string } {
  const kept: Array<{ item: T; text: string }> = [];
  let spent = 0;
  for (let i = all.length - 1; i >= 0 && kept.length < keep; i--) {
    const item = all[i] as T;
    const text = render(item);
    if (spent + text.length > BRIEF_HISTORY_HALF_CHARS) break;
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

/**
 * The ticket's whole history, for the retro: every comment on it in order,
 * then every review thread on every pull request tied to it — resolved or
 * not, merged or not, because a correction that was argued and settled is
 * exactly what a retro learns from.
 *
 * A comment is Landrace's by the test `entriesFromComments` applies — our
 * login *and* our marker — so a person's reply the board posted as the bot
 * reads as that person's turn, not as a record. Each body is cut here, and
 * the engine bounds the whole on the way in.
 */
export function historyBrief(
  comments: SnapshotComment[],
  pulls: Array<{ number: number; state: string }>,
  read: Map<number, ReviewThread[]>,
  bot: string,
): string {
  const ours = (login: string | null | undefined): boolean => typeof login === "string" && sameLogin(login, bot);
  const text = (body: string | null | undefined): string => cut((body ?? "").trim(), BRIEF_BODY_CHARS);

  const said = newest(comments, BRIEF_COMMENTS, "comments", (c) => {
    const marker = wroteIt(c, bot) ? parseMarker(c.body ?? "") : null;
    return marker
      ? `Landrace [${marker.marker ?? marker.kind}]: ${text(stripMarker(c.body ?? ""))}`
      : `@${c.user?.login ?? "ghost"}: ${text(c.body)}`;
  });
  const conversation = said.kept.length === 0
    ? "No comments on the ticket."
    : said.left + said.kept.map((k) => k.text).join("\n\n");

  const ordered = [...pulls].sort((a, b) => a.number - b.number);
  const raised = newest(
    ordered.flatMap((pull) => (read.get(pull.number) ?? []).map((thread) => ({ pull: pull.number, thread }))),
    BRIEF_HISTORY_THREADS,
    "threads",
    ({ thread }) => {
      const opening = thread.first;
      const last = thread.last;
      const by = ours(opening?.author) ? "Landrace's reviewer" : `@${opening?.author ?? "ghost"}`;
      const reply = thread.comments > 1 && last
        ? `\nLast reply, from ${ours(last.author) ? "Landrace" : `@${last.author ?? "ghost"}`}: ${text(last.body)}`
        : "";
      return `${where(thread)}raised by ${by} — ${thread.resolved ? "resolved" : "open"}\n${text(opening?.body)}${reply}`;
    },
  );
  let n = 0;
  const reviews = ordered.length === 0
    ? "No pull request was opened on this ticket."
    : raised.left + ordered.map((pull) => {
      const listed = raised.kept.filter((r) => r.item.pull === pull.number).map((r) => `${++n}. ${r.text}`);
      return `### PR #${pull.number} (${pull.state.toLowerCase()})\n\n${listed.length === 0 ? "Nothing listed." : listed.join("\n\n")}`;
    }).join("\n\n");

  return `## Ticket conversation\n\n${conversation}\n\n## Review threads\n\n${reviews}`;
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
