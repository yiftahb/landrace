import {
  BRANCH_PUSH_EFFECT,
  effectBranch,
  entriesFromComments,
  PULL_OPEN_EFFECT,
  PULL_REQUEST_KIND,
  PULL_REVIEW_EFFECT,
  RECORD_EFFECT,
  RELATIONS,
  stageFromLabels,
} from "#conventions.js";
import { defineSource } from "#hooks/contracts.js";
import { compose } from "#kit/compose.js";
import { BaseDocs } from "#kit/docs.js";
import { BaseForge, prBranch } from "#kit/forge.js";
import { BaseTracker, commentSatisfied } from "#kit/tracker.js";
import type {
  BranchHeads,
  ChangedFile,
  CheckCounts,
  CheckState,
  Effect,
  EffectHandler,
  EffectTable,
  ExternalPull,
  ExternalPullSeed,
  ExternalState,
  ExternalItem,
  FailedCheck,
  Graph,
  HookContext,
  MergeAnswer,
  Node,
  PullRecord,
  RelationDecl,
  ReviewThread,
  Source,
  ThreadCounts,
  ItemPatch,
  ItemRecord,
  TrackerComment,
} from "#namespace.js";

/**
 * The login everything the engine writes is posted under, so what it wrote
 * reads back as its own and what a person wrote does not. Authorship is the
 * whole check on a marker — syntax is not — so a fake that posted everything
 * under one name would make a person's comment able to complete a stage.
 */
const BOT = "landrace";
const PERSON = "a-person";

/** The kind a fix round's route marker names — `fix:{round}` — as the shipped tracker hook reads it. */
const FIX_KIND = "fix";

/** Both relationship types this tracker reports: a sub-item's parent, and the item a pull request implements. */
const RELATION_DECLS: RelationDecl[] = [
  { type: RELATIONS.childOf, singular: true },
  { type: RELATIONS.implements, singular: true },
];

/**
 * A source that answers every question with one fixed graph, for a test that
 * needs an item to exist and nothing to change under it. `read` returns the
 * whole graph whatever it is asked for, which the runner accepts: the item
 * is in it, and every edge in it is whole.
 */
export function staticSource(graph: Graph, relations: RelationDecl[] = RELATION_DECLS): Source {
  return defineSource({ id: "static", relations, list: async () => graph, read: async () => graph });
}

/**
 * Monotonic per item, the way a real tracker's timestamps are: a comment
 * posted now is never dated before one already on the item. A bare counter
 * is not enough — a test seeding a human reply dated later than the counter
 * (the natural way to write "and then a person spoke") would have every
 * comment written afterwards sort *before* it, so `run.lastEvent.actor` stayed
 * "human" for the rest of the run and every handback trigger kept firing.
 */
function clock(): (existing: TrackerComment[]) => string {
  let tick = 0;
  return (existing) => {
    const next = new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();
    const latest = existing.reduce((max, c) => (c.created_at > max ? c.created_at : max), "");
    return latest >= next ? new Date(Date.parse(latest) + 1000).toISOString() : next;
  };
}

/** A row as the tracker reads it out: copies of its lists, so a node never aliases the live row a test goes on to move. */
const recordOf = (row: ExternalItem): ItemRecord => ({
  id: row.id,
  title: row.title,
  link: `memory://items/${row.id}`,
  closed: row.closed ?? null,
  labels: [...row.labels],
  assignees: [...row.assignees],
  body: row.body,
  author: row.author,
  editor: undefined,
  createdAt: undefined,
  parent: row.parent,
  priority: row.priority ?? null,
});

/**
 * A tracker in memory, on the kit's base like any tracker integration: its
 * vendor calls are reads and writes of a map.
 *
 * It overrides only what a tracker with no network behind it cannot do the
 * base's way: it knows its own login without asking, so its pre hook records
 * none, and its comment check asks its own login rather than the snapshot's.
 *
 * `readOnly` makes it a tracker a workflow may read and never write — a
 * company's list of the reviews waiting on a person, say. Every write it is
 * asked for then throws, saying what was asked of which item.
 */
export class MemoryTracker extends BaseTracker {
  /** Every item, live: a test moves one the way a person on the tracker would. */
  readonly rows = new Map<string, ExternalItem>();
  private readonly at = clock();
  private nextComment = 1000;
  private readonly readOnly: boolean;
  private readonly asked: string[] = [];

  constructor(seed: { items?: Array<Partial<ExternalItem>>; readOnly?: boolean } = {}) {
    super();
    this.readOnly = seed.readOnly ?? false;
    for (const [i, s] of (seed.items ?? []).entries()) this.add(s, s.id ?? String(i + 1));
  }

  /** Every write this tracker was asked for, in order, as `<operation> #<id>`: refused ones too. */
  writes(): string[] {
    return [...this.asked];
  }

  /*
   * Asked before every write. A read-only tracker refuses out loud rather than
   * doing nothing: a write that silently did not land reads back as one that
   * was never planned, which is exactly the leak a read-only workflow is
   * tested for — and a reconcile would plan it again on every tick.
   */
  private write(operation: string, of: string): void {
    this.asked.push(`${operation} ${of}`);
    if (this.readOnly) throw new Error(`this tracker is read-only: ${operation} was asked of ${of}`);
  }

  /** The live row behind an item. */
  row(id: string): ExternalItem {
    const row = this.rows.get(id);
    if (!row) throw new Error(`no such item #${id}`);
    return row;
  }

  /** A comment on an item, under `author`'s login, dated after every one already there. */
  post(id: string, author: string, body: string): void {
    const row = this.row(id);
    row.comments.push({ id: this.nextComment++, body, created_at: this.at(row.comments), user: { login: author } });
  }

  private add(s: Partial<ExternalItem>, id: string): ExternalItem {
    const row: ExternalItem = {
      id,
      title: s.title ?? `item ${id}`,
      body: s.body ?? "",
      labels: [...(s.labels ?? [])],
      assignees: [...(s.assignees ?? [])],
      comments: [...(s.comments ?? [])],
      priority: s.priority ?? null,
      parent: s.parent ?? null,
      closed: s.closed ?? null,
      author: s.author ?? PERSON,
    };
    this.rows.set(id, row);
    return row;
  }

  async login(): Promise<string> {
    return BOT;
  }

  async items(): Promise<ItemRecord[]> {
    return [...this.rows.values()].map(recordOf);
  }

  async item(id: string): Promise<ItemRecord> {
    return recordOf(this.row(id));
  }

  async children(id: string): Promise<ItemRecord[]> {
    return [...this.rows.values()].filter((r) => r.parent === id).map(recordOf);
  }

  async comments(id: string): Promise<TrackerComment[]> {
    return this.row(id).comments.map((c) => ({ ...c }));
  }

  async comment(id: string, body: string): Promise<void> {
    this.write("comment", `#${id}`);
    this.post(id, BOT, body);
  }

  async addLabels(id: string, labels: string[]): Promise<void> {
    this.write("addLabels", `#${id}`);
    const row = this.row(id);
    for (const label of labels) if (!row.labels.includes(label)) row.labels.push(label);
  }

  async removeLabel(id: string, label: string): Promise<void> {
    this.write("removeLabel", `#${id}`);
    const row = this.row(id);
    row.labels = row.labels.filter((l) => l !== label);
  }

  async close(id: string, how: "done" | "dropped"): Promise<void> {
    this.write("close", `#${id}`);
    this.row(id).closed = how;
  }

  async create(item: { title: string; body: string; parent: string | undefined; priority: number | undefined }): Promise<string> {
    this.write("create", item.parent === undefined ? "a new item" : `a new item under #${item.parent}`);
    if (item.parent !== undefined) this.row(item.parent); // throws "no such item #<parent>" when it is not one
    let n = this.rows.size + 1;
    while (this.rows.has(String(n))) n++;
    return this.add({ ...item, author: BOT, parent: item.parent ?? null, priority: item.priority ?? null }, String(n)).id;
  }

  async update(id: string, fields: Pick<ItemPatch, "title" | "body" | "state">): Promise<void> {
    this.write("update", `#${id}`);
    const row = this.row(id);
    if (fields.title !== undefined) row.title = fields.title;
    if (fields.body !== undefined) row.body = fields.body;
    if (fields.state !== undefined) row.closed = fields.state === "closed" ? "done" : null;
  }

  /*
   * Exactly what `observe` below puts in the snapshot — tests/hooks/provides.test.ts
   * holds the two level. No `tracker.bot`: the login is this class's own.
   */
  override provides(): string[] {
    return ["item", "item.body", "item.comments", "entries"];
  }

  override async observe({ item }: HookContext): Promise<Record<string, unknown>> {
    const comments = await this.comments(item);
    return { item: { body: this.row(item).body, comments }, entries: entriesFromComments(comments, BOT) };
  }

  override effects(): EffectTable {
    const effects = super.effects();
    const comment = effects[RECORD_EFFECT] as EffectHandler;
    // The kit's own check — ours, by login, and the marker parsed whole —
    // against the login this tracker posts as, which its snapshot does not carry.
    return {
      ...effects,
      [RECORD_EFFECT]: { apply: comment.apply, satisfied: (snapshot, effect) => commentSatisfied({ ...snapshot, tracker: { bot: BOT } }, effect) },
    };
  }
}

/** A pull request as the forge reads it out: memory's names the one item it was opened for, whatever its branch. */
const pullRecordOf = (p: ExternalPull): PullRecord => ({
  number: p.number,
  title: `PR #${p.number}`,
  link: `memory://pulls/${p.number}`,
  merged: p.merged,
  closed: p.closed !== null,
  headSha: p.headSha,
  branch: p.branch,
  createdAt: undefined,
  items: [p.item],
});

/** The forge's review calls, which the in-memory forge does not make: its threads are counts, and its `pull.review` moves them. */
const countsOnly = (): Error => new Error("the in-memory forge keeps review threads as counts, not as threads");

/**
 * A forge in memory, on the kit's base: pull requests are records it keeps,
 * and a push is something it is only told about.
 *
 * Its threads are counts rather than text, so a test can set "two open, one
 * awaiting a fix" in one line — which is also what it overrides: a pull
 * request node carries the live counts, and `pull.review` moves them. With no
 * repository behind it, nothing can say a push has landed, so one is taken
 * every time it is planned, and a pull request is opened from any branch.
 * Its checks are a field a test sets, and a push a test makes is a new
 * `headSha` — which is what a merge guarded by the old one is refused on.
 */
export class MemoryForge extends BaseForge {
  /** Every pull request, by node id: live, so a test merges, closes or comments on one the way a person would. */
  readonly rows = new Map<string, ExternalPull>();
  private readonly pushed: string[] = [];
  /** How many times a pull request's checks were asked for: a closed one's never should be. */
  checkCalls = 0;

  /**
   * Open a pull request implementing `item`, numbered from 1 in creation
   * order. Merged means closed as done unless `closed` says otherwise, and
   * `awaitingFix` defaults to `openThreads`: a thread nobody answered awaits a fix.
   * Its head is `sha-<number>` and nothing checks it, unless the test says.
   */
  add(item: string, pr: ExternalPullSeed = {}): string {
    const number = this.rows.size + 1;
    const closed = pr.closed !== undefined ? pr.closed : pr.merged ? "done" : null;
    const pull: ExternalPull = {
      id: `pr-${number}`, number, item, merged: false, openThreads: 0, awaitingFix: pr.openThreads ?? 0,
      headSha: `sha-${number}`, checks: "none", failed: [], ...pr, closed,
    };
    this.rows.set(pull.id, pull);
    return pull.id;
  }

  pull(id: string): ExternalPull {
    const pull = this.rows.get(id);
    if (!pull) throw new Error(`no such pull request ${id}`);
    return pull;
  }

  /** Every branch a `branch.push` was applied for, in order. */
  pushes(): string[] {
    return [...this.pushed];
  }

  async login(): Promise<string> {
    return BOT;
  }

  async pulls(): Promise<PullRecord[]> {
    return [...this.rows.values()].map(pullRecordOf);
  }

  async pullsNaming(item: string): Promise<PullRecord[]> {
    return [...this.rows.values()].filter((p) => p.item === item || p.branch === prBranch(item)).map(pullRecordOf);
  }

  // ponytail: counts, not threads — briefed as none open, whatever the count says; hold thread text here if a test ever briefs it.
  async threads(): Promise<ReviewThread[]> {
    return [];
  }

  async changedFiles(): Promise<ChangedFile[]> {
    return [];
  }

  async reviews(): Promise<string[]> {
    throw countsOnly();
  }

  async postReview(): Promise<void> {
    throw countsOnly();
  }

  async reply(): Promise<void> {
    throw countsOnly();
  }

  async resolve(): Promise<void> {
    throw countsOnly();
  }

  async openPull({ item, branch }: { item: string; branch: string }): Promise<void> {
    this.add(item, { branch });
  }

  async closePull(pull: number): Promise<void> {
    const open = this.pull(`pr-${pull}`);
    if (open.closed === null) open.closed = "dropped";
  }

  async checks(pull: PullRecord): Promise<CheckState> {
    this.checkCalls++;
    return this.pull(`pr-${pull.number}`).checks;
  }

  async failedChecks(pull: PullRecord): Promise<FailedCheck[]> {
    return this.pull(`pr-${pull.number}`).failed;
  }

  /**
   * As a forge guards one: merged already is merged, and another head than
   * the one asked for is refused as moved. One a person closed is refused
   * outright, before its head is looked at: merging it would undo their close.
   */
  async merge(pull: number, headSha: string): Promise<MergeAnswer> {
    const row = this.pull(`pr-${pull}`);
    if (row.merged) return "merged";
    if (row.closed !== null) throw new Error(`${row.id} for #${row.item} was closed without being merged, so there is nothing to merge`);
    if (headSha !== row.headSha) return "moved";
    row.merged = true;
    row.closed = "done";
    return "merged";
  }

  async heads(): Promise<BranchHeads> {
    return { local: {}, remote: {} };
  }

  async push(branch: string): Promise<void> {
    this.pushed.push(branch);
  }

  /** No branch heads: there is no checkout behind this forge. */
  override provides(): string[] {
    return [];
  }

  override async observe(): Promise<Record<string, unknown>> {
    return {};
  }

  /*
   * Closed and merged as a test set them, independently, and the live counts
   * — an open pull request's only, as a forge reports them: a thread left on
   * a merged or abandoned one is nothing a fix round can act on. Zero rather
   * than absent, so "no thread awaits a fix" stays readable once all merge.
   * Its checks are the kit's: what `read()` asked of an open one, `none` for
   * a closed one, and nothing on a listed one — so the kit's own zeroing is
   * what a test of this forge exercises, not a copy of it.
   */
  protected override node(pull: PullRecord, _threads?: ThreadCounts, ci?: CheckCounts): Node {
    const p = this.pull(`pr-${pull.number}`);
    return {
      id: p.id,
      kind: PULL_REQUEST_KIND,
      title: pull.title,
      link: pull.link,
      closed: p.closed,
      priority: null,
      origin: null,
      state: {
        merged: p.merged,
        headSha: p.headSha,
        openThreads: p.closed === null ? p.openThreads : 0,
        awaitingFix: p.closed === null ? p.awaitingFix : 0,
        ...(p.branch === undefined ? {} : { branch: p.branch }),
        ...ci,
      },
    };
  }

  override effects(): EffectTable {
    const effects = super.effects();
    return {
      ...effects,
      // Nothing can say the remote already has the branch's head, and a push
      // of a branch already there changes nothing: taken whenever planned.
      [BRANCH_PUSH_EFFECT]: {
        satisfied: (_snapshot, effect) => {
          effectBranch(effect);
          return false;
        },
        apply: (effect) => this.push(effectBranch(effect)),
      },
      // No checkout to ask whether the branch has anything on it.
      [PULL_OPEN_EFFECT]: {
        satisfied: (effects[PULL_OPEN_EFFECT] as EffectHandler).satisfied,
        apply: (effect, { item }) => this.openPull({ item, branch: effectBranch(effect) }),
      },
      [PULL_REVIEW_EFFECT]: {
        satisfied: (effects[PULL_REVIEW_EFFECT] as EffectHandler).satisfied,
        apply: async (effect, { item }) => this.countReview(effect, item),
      },
    };
  }

  /*
   * A review, as what it does to the counts: each well-formed finding opens a
   * thread awaiting a fix; each reply from a `fix` round hands one to the
   * person and each other reply hands one back; and each id a review lists as
   * resolved closes one the reviewer raised — never more than it raised, since
   * a person's thread is theirs to close. A fix round resolves nothing. Once
   * per round, by its marker.
   */
  private async countReview(effect: Effect, item: string): Promise<void> {
    const branch = effectBranch(effect);
    const out = (effect.output ?? {}) as { findings?: unknown; resolved?: unknown; replies?: unknown };
    const some = (v: unknown): boolean => Array.isArray(v) && v.length > 0;
    const fromBranch = [...this.rows.values()].filter((p) => p.item === item && p.branch === branch);
    const pull = fromBranch.find((p) => p.closed === null && !p.merged);
    if (!pull) {
      // Merged meanwhile, or a clean review, is nothing to fix; no pull
      // request from the branch at all is a route naming the wrong branch.
      const empty = !some(out.findings) && !some(out.resolved) && !some(out.replies);
      if (empty || fromBranch.length > 0) return;
      throw new Error(`there is no open pull request from ${branch} to put the review on`);
    }
    const marker = String(effect.marker);
    if ((pull.reviews ?? []).includes(marker)) return;
    const fix = marker.split(":")[0] === FIX_KIND;
    const opened = (Array.isArray(out.findings) ? out.findings : []).filter((f) => {
      const x = f as { file?: unknown; line?: unknown; body?: unknown } | null;
      return typeof x === "object" && x !== null && typeof x.file === "string" && Number.isInteger(x.line) && typeof x.body === "string";
    }).length;
    const replied = (Array.isArray(out.replies) ? out.replies : []).filter((r) => {
      const x = r as { thread?: unknown; body?: unknown } | null;
      return typeof x === "object" && x !== null && typeof x.thread === "string" && typeof x.body === "string";
    }).length;
    const raised = pull.raised ?? 0;
    const closing = fix ? 0 : Math.min(raised, Array.isArray(out.resolved) ? out.resolved.length : 0);
    pull.raised = raised - closing + opened;
    pull.openThreads = pull.openThreads - closing + opened;
    // ponytail: a count cannot tell which thread a reply or a resolve
    // touched, so it is held inside [0, openThreads]; a real forge reads
    // each thread's last word instead.
    const awaiting = pull.awaitingFix + opened + (fix ? -replied : replied);
    pull.awaitingFix = Math.min(pull.openThreads, Math.max(0, awaiting));
    pull.reviews = [...(pull.reviews ?? []), marker];
  }
}

/** Docs in memory, on the kit's base: each item's spec page is a string it keeps. */
export class MemoryDocs extends BaseDocs {
  /** Every published page, by item. */
  readonly pages = new Map<string, string>();

  async page(item: string): Promise<string | null> {
    return this.pages.get(item) ?? null;
  }

  async publish(item: string, content: string): Promise<void> {
    this.pages.set(item, content);
  }

  async link(item: string): Promise<string> {
    return `memory://specs/${item}`;
  }

  async published(): Promise<Set<string>> {
    return new Set(this.pages.keys());
  }
}

/**
 * A tracker, a forge and a docs integration in memory, composed exactly as a
 * project's own are, speaking the conventions and nobody's dialect.
 *
 * This is not a second copy of an integration. A real integration is tested
 * over a fake HTTP boundary, which is the only way to test *it* — a
 * hand-written imitation would be free to disagree with the real hook, and the
 * place it disagreed is exactly where a leak across the boundary stopped being
 * visible. What this is for is the workflow: labels, records and human turns,
 * so a graph can be driven and its loops watched before any integration for a
 * given tracker exists at all.
 *
 * Its hooks are `compose`'s over `MemoryTracker`, `MemoryForge` and
 * `MemoryDocs`, the same kit bases every integration is built on, so every
 * effect name and every `satisfied()` is the kit's own rather than a copy.
 * `readOnly` makes the tracker refuse every write (see `MemoryTracker`).
 */
export function createExternalState(seed: { items?: Array<Partial<ExternalItem>>; readOnly?: boolean } = {}): ExternalState {
  const tracker = new MemoryTracker(seed);
  const forge = new MemoryForge();
  const docs = new MemoryDocs();

  return {
    ...compose({ tracker, forge, docs }),
    item: (id) => tracker.row(id),
    children: (parent) => [...tracker.rows.values()].filter((r) => r.parent === parent),
    openPull: (item, pr = {}) => {
      tracker.row(item);
      return forge.add(item, pr);
    },
    pull: (id) => forge.pull(id),
    pushes: () => forge.pushes(),
    comments: (n) => tracker.row(n).comments.map((c) => c.body),
    entriesOf: (n) => entriesFromComments(tracker.row(n).comments, BOT),
    stage: (n) => stageFromLabels(tracker.row(n).labels).stage,
    label: (n, label) => {
      const row = tracker.row(n);
      if (!row.labels.includes(label)) row.labels.push(label);
    },
    unlabel: (n, label) => {
      const row = tracker.row(n);
      row.labels = row.labels.filter((l) => l !== label);
    },
    say: (n, text) => tracker.post(n, PERSON, text),
    writes: () => tracker.writes(),
  };
}
