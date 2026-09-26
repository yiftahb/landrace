/**
 * Shared vocabulary: the labels the workflow uses to record position, the
 * marker we stamp on everything we write, and how a tracker's records read
 * back as the engine's. None of it belongs to a tracker — a Jira hook would
 * use the same names — so none of it lives in a hook.
 */
import type { Effect, Entry, Graph, Marker, Node, Origin, TrackerComment, Trailing } from "#namespace.js";

export const LABELS = {
  eligible: "lr:auto",
  working: "lr:working",
  awaiting: "lr:awaiting",
  blocked: "lr:blocked",
  approved: "lr:approved",
  stage: (id: string) => `lr:stage:${id}`,
} as const;

/** The engine's own label namespace. Anything under it is workflow state we write. */
export const LABEL_NAMESPACE = "lr:";

/** Trackers compare label names case-insensitively, so this does too. */
export const isEngineLabel = (label: string): boolean =>
  label.trim().toLowerCase().startsWith(LABEL_NAMESPACE);

const STAGE_RE = /^lr:stage:(.+)$/;
export const STAGE_LABEL_PREFIX = "lr:stage:";

/**
 * Position is a label, so two of them means we cannot place the ticket.
 *
 * `stage` is null when there are two, not `found[0]`. Returning the first was
 * the only first-match-wins in this codebase, and it was in the hot path of
 * the one thing the design says it never does: `landrace status` and the MCP
 * `status` tool both read `ambiguous` and reported the ticket as unplaceable,
 * while buildSnapshot — the one caller that *acts* — read `.stage`, dropped
 * the flag, and ran a paid step at whichever label happened to come first in
 * the array. The same ticket with its two labels the other way round ran a
 * different stage.
 *
 * `found` is returned so a halt can name which two, the way every other
 * ambiguity in the engine names what it could not tell apart.
 */
export function stageFromLabels(labels: string[]): { stage: string | null; ambiguous: boolean; found: string[] } {
  const found = labels.map((l) => STAGE_RE.exec(l)?.[1]).filter((s): s is string => Boolean(s));
  const ambiguous = found.length > 1;
  return { stage: ambiguous ? null : (found[0] ?? null), ambiguous, found };
}

/**
 * Ids that are not names but reachable keys on a plain object. A comment
 * naming stage "__proto__" made `outputs[stage] = data` write the *prototype*
 * of every stage's outputs at once: Object.keys() showed nothing, while
 * `outputs.triage.intent` read "approve" and the engine transitioned. Blocked
 * here, at the boundary, so no path into the engine can carry one — the
 * null-prototype objects in deriveRun are the second half of that fix, not a
 * substitute for it.
 */
export const RESERVED_IDS: readonly string[] = ["__proto__", "constructor", "prototype"];

export const isReservedId = (id: string): boolean => RESERVED_IDS.includes(id);

/**
 * What a ticket id may look like, whatever tracker it came from.
 *
 * Opaque to the engine — "42" and "PROJ-7" are both fine — but not arbitrary:
 * an id becomes a lock file name, a worktree directory, a branch name and part
 * of a deep link a coding agent acts on. Refusing anything but a short run of
 * letters, digits, `.`, `_` and `-`, starting with a letter or digit, is what
 * lets every one of those use it as-is instead of each growing its own escaping
 * — and a path segment of `..` or `a/b` cannot be written at all.
 */
const TICKET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function ticketIdProblem(id: unknown): string | null {
  if (typeof id !== "string") return `a ticket id must be a string, got ${id === null ? "null" : typeof id}`;
  if (isReservedId(id)) return `"${id}" is a reserved object key and cannot be a ticket id`;
  if (!TICKET_ID.test(id)) {
    return `"${id.slice(0, 80)}" is not a usable ticket id: 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit`;
  }
  return null;
}

export const isTicketId = (id: unknown): id is string => ticketIdProblem(id) === null;

/**
 * How ids order wherever a person reads a list of them. Numeric-aware, so
 * numeric ids print in numeric order (9 before 10); then plain code-unit order
 * as the tie-break, so the order is total and the same on every machine
 * whatever its locale.
 */
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "variant" });
export const compareIds = (a: string, b: string): number =>
  collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

/**
 * The kinds and relationship types every tracker hook uses, named once, for
 * the reason the label names are: a tracker hook must spell them the way a
 * workflow written against any tracker reads them, or the workflow silently
 * counts zero children.
 */
export const TICKET_KIND = "ticket";
export const PULL_REQUEST_KIND = "pull-request";
/**
 * A page written about a ticket — a published spec, say — reported as a node
 * so the board can draw it. It points at its ticket with `documents`, and at
 * one ticket only.
 */
export const DOCUMENT_KIND = "document";
export const RELATIONS = { childOf: "child-of", implements: "implements", documents: "documents" } as const;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/** A ticket node's labels — position, eligibility and whose turn it is. Empty, never absent. */
export const labelsOf = (node: Node | undefined): string[] => strings(node?.state.labels);

/** A ticket node's assignees, as logins. Empty, never absent: an absent path abstains, and abstaining means eligible. */
export const assigneesOf = (node: Node | undefined): string[] => strings(node?.state.assignees);

/**
 * Whether a listed node is work: a ticket, and an open one. A closed ticket
 * is in a graph so a parent can count it, and it keeps whatever labels it had
 * — `lr:auto` included — so reading its labels alone would pay for steps on a
 * ticket somebody already finished.
 */
export const isOpenTicket = (node: Node): boolean => node.kind === TICKET_KIND && node.closed === null;

/**
 * The order the tick hands work out in. Lower priority first; unprioritised
 * after every number, so a hook that forgot to map priority does not jump its
 * whole tracker to the front; then the id, so the order is total. Ordering
 * work is not choosing a transition — nothing here decides what happens to a
 * ticket, only which one gets an agent first.
 */
export const compareWork = (a: Node, b: Node): number => {
  if (a.priority !== b.priority) {
    if (a.priority === null) return 1;
    if (b.priority === null) return -1;
    return a.priority - b.priority;
  }
  return compareIds(a.id, b.id);
};

/**
 * The marker kind a stage's on_enter writes to record that the state was
 * entered. Shared vocabulary rather than a literal in two files: core counts
 * these to decide whether a stage owes another round, and `landrace validate`
 * requires one from every stage that runs a step, and the two must mean the
 * same thing.
 */
export const ENTRY_KIND = "enter";

/**
 * The marker kind a step's own result is recorded under. Shared for the same
 * reason ENTRY_KIND is, across one more layer: the runner stamps it, core
 * counts it to derive rounds and outputs, a tracker adapter reads the step's
 * value back out of it, and `landrace validate` refuses a step whose every
 * route retargets it. Four files that must mean the same thing by one name.
 */
export const OUTPUT_KIND = "output";

/**
 * The effect type that leaves a durable record on the tracker.
 *
 * Tracker-agnostic in the same way the marker format is — a Jira hook handles
 * the same type — and named here because the engine itself plans one in two
 * places a workflow does not reach: a step whose route sends its content off
 * the tracker still records that it ran, and a rejected output records why.
 */
export const RECORD_EFFECT = "tracker.comment";

/**
 * The other two writes a tracker owns, named for the same reason and at the
 * same level: a Jira hook handles `tracker.status` too, and a workflow carried
 * from one tracker to another should not rewrite every `on_enter` in the file.
 *
 * Unlike RECORD_EFFECT the engine never plans one of these — a workflow does —
 * but the in-memory tracker in `src/testing` has to handle exactly the set a
 * real one does, and two spellings of a name is how a fake and the integration
 * it stands in for drift apart without anybody noticing.
 */
export const STATUS_EFFECT = "tracker.status";
export const LABEL_EFFECT = "tracker.label";

/**
 * The kind a conversation turn is recorded under: what a person asked a
 * running step through the MCP, and what it answered.
 */
export const CONVERSATION_KIND = "conversation";

/**
 * The marker kind on a child a step created. The marker's own `stage` and
 * `round` are the creating stage and round; `parent` rides beside them.
 */
export const CHILD_KIND = "child";

/** Drop nodes: planned by core from `{ type, follow }` into `{ type, ids }`. */
export const NODES_CLOSE_EFFECT = "nodes.close";

/**
 * Close this ticket as done. A finished child has to read closed, or its
 * parent — which routes on `rel.child-of.in.not.closed` — waits for ever.
 */
export const CLOSE_EFFECT = "tracker.close";

/**
 * Publish the branch the effect names, and open a pull request from it. Named
 * here for the reason the tracker writes are: the in-memory tracker handles
 * both, and a forge hook for somebody else's tracker has to spell them the
 * same way or a workflow does not carry over. Which branch is always the
 * effect's own `branch` field — the workflow says, never a convention — so a
 * ticket can have as many branches as its stages name.
 */
export const BRANCH_PUSH_EFFECT = "branch.push";
export const PULL_OPEN_EFFECT = "pull.open";

/**
 * The branch a publishing effect names. Which branch is the workflow's to
 * say, so an effect that names none — or names one git would refuse — is
 * refused here, in `satisfied()` as well as in `apply()`, rather than guessed.
 */
export function effectBranch(effect: Effect): string {
  if (typeof effect.branch !== "string" || effect.branch === "") {
    throw new Error(`a ${effect.type} effect must name the branch it is for, and this one names none`);
  }
  const problem = branchNameProblem(effect.branch);
  if (problem) throw new Error(`a ${effect.type} effect names a branch git would refuse: ${problem}`);
  return effect.branch;
}

/**
 * The satisfied() every `pull.open` handler shares: this ticket already has a
 * pull request from this branch, open or merged, in the graph the engine read.
 *
 * By branch, never "the ticket has one": a ticket has as many branches as its
 * stages name, and a pull request from one says nothing about another. An
 * abandoned one does not count — the work on the branch is not merged and no
 * longer proposed, so a new pull request is what "open one" still means.
 */
export function hasPullFrom(graph: Graph | undefined, ticket: string | undefined, branch: string): boolean {
  if (!graph) throw new Error("a pull.open effect cannot be checked: the snapshot has no graph");
  const implementing = new Set(graph.relationships
    .filter((r) => r.type === RELATIONS.implements && r.to === ticket)
    .map((r) => r.from));
  return graph.nodes.some((n) =>
    implementing.has(n.id) && n.kind === PULL_REQUEST_KIND && n.state.branch === branch && n.closed !== "dropped");
}

/**
 * Why git would refuse this as a branch name, or null if it would take it —
 * `git check-ref-format --branch`, which tests/conventions/branch-name.test.ts
 * holds this level with.
 *
 * Asked before git is: a branch name becomes argv for `git worktree add` and
 * `git push`, and a name git refuses there surfaces as git's own stderr from
 * the middle of a step, while one that starts with "-" is not refused at all
 * — it is read as an option. Stricter than git about `@`, which git accepts
 * as a branch and every other command reads as HEAD.
 */
export function branchNameProblem(name: string): string | null {
  const bad = (why: string): string => `"${name.slice(0, 80)}" is not a usable branch name: ${why}`;
  if (name === "") return bad("it is empty");
  if (name.startsWith("-")) return bad('it starts with "-", which git would read as an option');
  if (name === "HEAD" || name === "@") return bad("git reads it as the current checkout");
  if ([...name].some((c) => c <= " " || c === "\u007f" || "~^:?*[\\".includes(c))) {
    return bad("it contains a space, a control character, or one of ~ ^ : ? * [ \\");
  }
  if (name.includes("..")) return bad('it contains ".."');
  if (name.includes("@{")) return bad('it contains "@{"');
  if (name.endsWith(".")) return bad('it ends with "."');
  for (const part of name.split("/")) {
    if (part === "") return bad('it has an empty component — a leading, trailing or doubled "/"');
    if (part.startsWith(".")) return bad(`its component "${part}" starts with "."`);
    if (part.endsWith(".lock")) return bad(`its component "${part}" ends with ".lock"`);
  }
  return null;
}

/**
 * How big one ticket's neighbourhood may be. `read` returns the whole
 * descendant subtree, because a cascade close must see every node it closes,
 * and it runs on every converge pass. Past this, the honest answer is a halt
 * naming the size, from the engine and from a source that stops reading
 * there — ponytail: page the subtree when a real epic gets here.
 */
export const MAX_SUBGRAPH_NODES = 200;

/**
 * What a step may declare it is allowed to do, and the whole of it.
 *
 * Deliberately two words long. Each one is enforced twice — by the flags an
 * executor builds from it, and by the engine reading the step's worktree
 * afterwards (src/agent/worktree.ts) — and a third word may only arrive with
 * both. A capability that is declared and not enforced is worse than none at
 * all: the operator reads the step file, sees the word, and believes they are
 * covered. That is why an unrecognised one is a refusal rather than a value
 * quietly carried around, and why the list lives here with the labels and the
 * marker format rather than inside the one executor that happens to know a CLI
 * flag for it — a second executor has to answer for the same two words.
 *
 * `tickets:create` is enforced twice like the others: an executor offers the
 * create_child tool only to a step that declares it, and runStep reads the
 * ticket's graph afterwards — a child stamped with this round's origin that a
 * step without the word somehow made is a refusal, not a record.
 */
export const CAPABILITIES = ["repo:read", "repo:write", "tickets:create"] as const;

/** The declared names nothing in the engine knows how to enforce. */
export const unknownCapabilities = (declared: readonly string[] | undefined): string[] =>
  (declared ?? []).filter((c) => !(CAPABILITIES as readonly string[]).includes(c));

/**
 * Whether a step declared that it may change the repository. Absent and empty
 * both mean no: a step that declares nothing is the most restricted one there
 * is, never the least.
 */
export const mayWriteRepo = (declared: readonly string[] | undefined): boolean =>
  (declared ?? []).includes("repo:write");

/** Whether a step may create children. Absent and empty both mean no. */
export const mayCreateTickets = (declared: readonly string[] | undefined): boolean =>
  (declared ?? []).includes("tickets:create");

/*
 * Caps on what a marker may carry, and on how much of a comment is even
 * looked at. Both exist because a comment body is untrusted text that is
 * re-read on every tick:
 *
 *  - A ~10 KB body whose marker JSON nested ~5000 arrays deep parsed fine and
 *    then blew the stack inside canonicalize(), and no tick could get past it
 *    again — the comment is still there next time.
 *  - The old scan matched marker-shaped text across the whole body, which is
 *    quadratic: 64 KB of "<!-- landrace {" cost 65 ms per comment, twice per
 *    tick, over up to 100 comments.
 *
 * The window is derived from the payload cap rather than chosen separately,
 * and it *is* the size cap on reading: a marker larger than the window cannot
 * have its opening inside it, so it is never seen. A second length check in
 * parseMarker was unreachable, and an unreachable guard kept for reassurance
 * is a guard nobody can test.
 */
const MARKER_MAX_PAYLOAD = 8 * 1024;
const MARKER_MAX_DEPTH = 8;
const TAIL_WINDOW = MARKER_MAX_PAYLOAD + 256;

/**
 * Room inside the payload cap that a step's output value may not use, kept
 * for the marker's own envelope — stage, kind, round, the route's marker
 * string, and the session id the engine records beside the value. Every one
 * of those comes from the workflow file or from the engine, so the envelope
 * is bounded by something a contributor writes rather than by something an
 * agent chose; a workflow whose ids are long enough to overrun a kilobyte of
 * slack is a defect, and renderMarker throwing is how it is reported.
 */
const MARKER_ENVELOPE_RESERVE = 1024;

/** A marker is depth 1, so the value hanging off its `output` key is depth 2. */
const MARKER_VALUE_DEPTH = 2;

const TRAILING_RE = /^<!--\s*landrace\s+(\{[\s\S]*\})\s*-->$/;

/** Both halves of the delimiter a marker lives inside, and what they read as once escaped. */
const COMMENT_OPEN = "<!--";
const COMMENT_CLOSE = "-->";
const ESCAPED_OPEN = "&lt;!--";
const ESCAPED_CLOSE = "--&gt;";

/**
 * `<` and `>` written as the \u escapes JSON.parse reads straight back, so
 * neither half of an HTML comment delimiter can appear in the payload.
 *
 * A marker carries the step's own output value now, which is the first
 * agent-authored text to live *inside* the marker rather than beside it.
 * JSON.stringify escapes quotes and backslashes and nothing else, so a value
 * containing `<!--` gave trailing() a later opening than the real one — and
 * the escaped json between it and the close does not parse — while `-->`
 * closes the comment early. Either way our own comment stops reading as ours,
 * the step looks like it never ran, and it is re-invoked and paid for on
 * every tick: neutraliseMarkers' problem, one level in.
 */
const escapeAngles = (json: string): string => json.replace(/</g, "\\u003c").replace(/>/g, "\\u003e");

/**
 * Why a marker could not carry this value, or null if it can. Asked at the
 * step boundary, where a rejection is a broken output contract and leaves a
 * durable record; renderMarker's own throw is the backstop for everything
 * that does not come through there.
 */
export function outputValueProblem(value: unknown): string | null {
  const room = MARKER_MAX_PAYLOAD - MARKER_ENVELOPE_RESERVE;
  const json = escapeAngles(JSON.stringify(value));
  if (json.length > room) return `is ${json.length} characters, over the ${room} a record can carry`;
  if (tooDeep(value, MARKER_VALUE_DEPTH)) return `is nested deeper than the ${MARKER_MAX_DEPTH} levels a record can carry`;
  return null;
}

/**
 * Throws rather than emit a marker the reader would not see. A marker past the
 * caps is not rejected on the way back in — it is *invisible*, so our own
 * comment reads as a human's, the step looks like it never ran, and it is
 * re-invoked on every tick forever. Failing at write time is loud and local.
 */
export const renderMarker = (m: Marker): string => {
  const json = escapeAngles(JSON.stringify(m));
  if (json.length > MARKER_MAX_PAYLOAD) {
    throw new Error(`marker is too large to be read back: ${json.length} > ${MARKER_MAX_PAYLOAD} characters`);
  }
  if (tooDeep(m, 1)) {
    throw new Error(`marker is too deep to be read back: over ${MARKER_MAX_DEPTH} levels of nesting`);
  }
  return `\n\n<!-- landrace ${json} -->`;
};

/**
 * The marker at the very end of a body, if there is one.
 *
 * Read backwards from the end rather than forwards over every match: a body
 * is free to *contain* marker-shaped text — a document about this system
 * quotes the format — and only a marker with nothing after it is ours.
 * Reading forwards found the example instead of the real one, and made the
 * cost of a comment quadratic in its length.
 */
function trailing(body: string): Trailing | null {
  const offset = Math.max(0, body.length - TAIL_WINDOW);
  const tail = body.slice(offset);

  const close = tail.lastIndexOf("-->");
  if (close === -1 || tail.slice(close + 3).trim() !== "") return null;
  const open = tail.lastIndexOf("<!--", close);
  if (open === -1) return null;

  const m = TRAILING_RE.exec(tail.slice(open, close + 3));
  return m ? { index: offset + open, json: m[1] as string } : null;
}

/** Depth-capped, and capped from above, so it can never recurse further than the cap. */
function tooDeep(value: unknown, depth: number): boolean {
  if (depth > MARKER_MAX_DEPTH) return true;
  if (Array.isArray(value)) return value.some((v) => tooDeep(v, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((v) => tooDeep(v, depth + 1));
  }
  return false;
}

export function parseMarker(body: string): Marker | null {
  // No size check here: the tail window above is the size cap, and
  // renderMarker refuses to write anything this reader could not see.
  const m = trailing(body);
  if (!m) return null;
  try {
    const parsed: unknown = JSON.parse(m.json);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { stage, kind, round } = parsed as Partial<Marker>;
    if (typeof stage !== "string" || typeof kind !== "string" || typeof round !== "number") return null;
    if (isReservedId(stage)) return null;
    if (tooDeep(parsed, 1)) return null;
    return parsed as Marker;
  } catch {
    return null;
  }
}

export function stripMarker(body: string): string {
  const m = trailing(body);
  return (m ? body.slice(0, m.index) : body).trim();
}

/**
 * The origin marker a hook appends to a child's body. The same trailing-marker
 * format as every record, so the same reader, the same caps and the same
 * escaping protect it.
 */
export const renderOrigin = (o: Origin): string =>
  renderMarker({
    stage: o.stage, kind: CHILD_KIND, round: o.round, parent: o.parent,
    marker: `child:${o.parent}:${o.stage}:${o.round}`,
  });

/**
 * Whether two logins name one account. Case-insensitive, the way trackers
 * compare them, and blind to a trailing "[bot]": a tracker can report an app's
 * login without it in one API and with it in another — and in `tracker.bot` —
 * reading our own children as a stranger's would leave every one of them
 * outside the cascade that should drop it.
 */
export function sameLogin(a: string, b: string): boolean {
  const norm = (login: string): string => login.trim().toLowerCase().replace(/\[bot\]$/, "");
  return norm(a) === norm(b);
}

/**
 * Who created this ticket, when it was a step — or null.
 *
 * Authorship first, exactly as entriesFromComments: an origin is control
 * state, because a breakdown re-run closes whatever claims it. A person who
 * could write one into an issue body could have their issue — and everything
 * hanging off it — cascaded closed by somebody else's ticket.
 */
export function parseOrigin(body: string, author: string | undefined, botLogin: string): Origin | null {
  if (!botLogin.trim()) {
    throw new Error("parseOrigin needs the login landrace posts as; refusing to read markers without it");
  }
  if (typeof author !== "string" || !sameLogin(author, botLogin)) return null;
  const m = parseMarker(body);
  if (!m || m.kind !== CHILD_KIND) return null;
  const { parent, round, stage } = m as { parent?: unknown; round: number; stage: string };
  if (!isTicketId(parent) || !Number.isInteger(round) || round < 1) return null;
  return { parent, stage, round };
}

/**
 * The satisfied() every nodes.close handler shares: each id reads back closed,
 * done or dropped. Either counts, because a merged pull request can never be
 * dropped, and a check waiting for it to be would re-apply the close on every
 * tick. A missing id is not closed — it may be a read that did not reach it.
 */
export function allClosed(graph: Graph | undefined, ids: readonly string[]): boolean {
  if (!graph) throw new Error("a nodes.close effect cannot be checked: the snapshot has no graph");
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return ids.every((id) => (byId.get(id)?.closed ?? null) !== null);
}

/**
 * Text we did not author must not be able to emit our control tokens. Escaped
 * rather than deleted: a document explaining the format should still show it,
 * just visibly and inertly.
 *
 * Every `<!--` and every `-->` in the body, not only the pair bracketing each
 * marker-shaped match. Matching whole markers looked tighter and was not a
 * control at all: the match was lazy, so a marker *nested* inside another
 * one's span kept both its own delimiters, and N levels of nesting survived N
 * escape passes — including the two the relay sinks apply (once in the MCP
 * tool, once in the tracker hook), which is how text an operator pasted came
 * back out under our own login as a record the engine counted. A third pass
 * loses the same race to a third level. Convergence ends it instead: one pass
 * leaves no readable delimiter anywhere, so a second pass is a no-op and the
 * nesting depth stops mattering.
 *
 * The two replacements run in sequence rather than as one alternation because
 * they overlap: in `<!-->` the opener and the closer share two dashes, and a
 * single left-to-right scan that consumed the opener would step past the
 * `-->` it had just exposed. Escaping every opener first and every closer
 * second cannot leave one behind — neither replacement introduces a `<` or a
 * `>`, so neither pass can create work for the other or undo its own.
 *
 * Fixed strings, not a pattern with a quantifier: the lazy scan this replaces
 * was quadratic in the number of openings, and the agent prose that reaches
 * here is bounded only by MAX_OUTPUT_BYTES, so 8 MB of them blocked the
 * single-threaded orchestrator for a quarter of an hour.
 * tests/security/marker-neutralise.test.ts pins the convergence and the cost.
 */
export const neutraliseMarkers = (body: string): string =>
  body.replaceAll(COMMENT_OPEN, ESCAPED_OPEN).replaceAll(COMMENT_CLOSE, ESCAPED_CLOSE);

/**
 * The most prose a record may carry.
 *
 * Every tracker caps a comment somewhere in the tens of thousands of
 * characters, and no tracker's number belongs in the engine — so this is not
 * any of them. It is a bound on what an honest step writes: 32 KB is several
 * thousand words of explanation beside a json block, far more than a step has
 * ever needed and comfortably under the smallest limit a tracker is known to
 * impose, with room left over for the marker appended after it. The real
 * number is the hook's to know and to refuse by, which is the same division
 * renderMarker and outputValueProblem already have.
 */
const MAX_RECORD_BODY = 32 * 1024;

/**
 * Why a record could not carry this prose, or null if it can.
 *
 * Asked at the step boundary, where a rejection is a broken output contract
 * that leaves a durable record — never at apply time. An apply refused by the
 * tracker throws, converge halts, and *nothing* is written: the next tick
 * re-derives the stage as pending and pays for the step again, for ever. A
 * step that writes a long honest report is all it takes.
 *
 * Measured escaped, because escaped is what a hook hands the tracker and
 * escaping only ever grows a body — `-->` becomes `--&gt;`, so prose made of
 * delimiters doubles on the way out. Judging the raw length would admit a
 * body that is refused where it lands, which is the whole failure being
 * closed here.
 */
export function recordBodyProblem(body: string): string | null {
  const escaped = neutraliseMarkers(body).length;
  if (escaped > MAX_RECORD_BODY) {
    return `is ${escaped} characters once escaped, over the ${MAX_RECORD_BODY} a record can carry`;
  }
  return null;
}

const TRUNCATED = "\n\n…[truncated: the full text was longer than a record can carry]";

/**
 * The same prose, cut to something a record can carry.
 *
 * For the one place where refusing costs more than truncating. A step's
 * output is refused (`recordBodyProblem` above), and rightly: there the prose
 * is a document, and half a document published as a whole one is worse than
 * none. A conversation turn's answer is the opposite case — it has *already
 * been paid for* by the time its length is known, nothing in the engine
 * routes on it (a conversation record is read back for its `resolved` flag
 * and its session id, both of which ride in the marker, not in the body), and
 * the caller receives the whole of it regardless. Throwing there loses a paid
 * turn's answer and the session the next turn would have resumed from, which
 * is the failure step.ts closes on its own path and this one did not have.
 *
 * Cut at half the cap, because escaping can double a body — `-->` becomes
 * `--&gt;` — so half of it fits whatever the prose is made of. Being
 * conservative costs nothing: this only ever runs on a body that could not be
 * posted at all.
 */
export function fitRecordBody(body: string): string {
  if (recordBodyProblem(body) === null) return body;
  return body.slice(0, Math.floor(MAX_RECORD_BODY / 2) - TRUNCATED.length) + TRUNCATED;
}

/**
 * What core reads as a record's payload — `run.outputs[stage]` for an output
 * record, and the marker itself for the kinds core reads no value from.
 *
 * An output record's payload is the step's own value and nothing else. The
 * envelope (stage, kind, round) is already on the Entry, and leaving it in
 * `data` as well is what made `outputs.spec.kind` read back the literal
 * "output" for every shape a step could produce, so every trigger in the
 * shipped workflow that routed on an output field was dead. A record written
 * before markers carried values has no value at all: undefined, not the
 * envelope — answering "output" again for exactly the tickets already in
 * flight is the bug, not the compatible thing to do.
 */
const payloadOf = (m: Marker): unknown => (m.kind === OUTPUT_KIND ? m.output : m);

/**
 * The session a marker carries, if it carries a usable one.
 *
 * Read only from the marker's own field — never from the payload, which on an
 * output record is the agent's value and may itself declare a field of this
 * name. That separation is the whole point of moving the id out of `output`:
 * a session id is an argument to a paid agent run, and the agent does not get
 * to choose which conversation the next turn resumes. Checked rather than
 * trusted because a marker is JSON we parsed back out of a comment body, so
 * its declared type is a claim: an empty string is an id that resumes
 * nothing, and a number would build a `--resume` argument out of "7".
 */
const sessionOf = (m: Marker): { session?: string } =>
  typeof m.session === "string" && m.session !== "" ? { session: m.session } : {};

/**
 * Turn a tracker's records into the engine's own. Vocabulary, not integration:
 * the marker format lives here, so every hook that records progress as text in
 * a comment reads it back the same way, and core never learns the format at
 * all.
 *
 * A marker is control state, and it is trustworthy only because *we* wrote it.
 * An earlier version stamped `byAgent` on any comment whose trailing marker
 * parsed, so one comment from any account with comment access could complete a
 * stage, block a ticket, or run a counter up until the triggers went ambiguous.
 * The trailing-marker rule does not help there: it stops a *quoted* example
 * being mistaken for a real one, not someone who deliberately puts one last.
 * Authorship is the check; syntax is not.
 */
export function entriesFromComments(comments: TrackerComment[], botLogin: string): Entry[] {
  // Fail closed, and loudly. An empty login would make every marker read as
  // human — the engine would believe no step had ever run and re-invoke paid
  // steps forever, which has cost real money on this project once.
  if (!botLogin.trim()) {
    throw new Error("entriesFromComments needs the login landrace posts as; refusing to read markers without it");
  }
  return comments.map((c) => {
    // sameLogin, as parseOrigin reads a child's author: an app is `myapp[bot]`
    // on its comments and may be configured as `myapp`, and reading our own
    // records as a person's re-runs every paid step it has already finished.
    const author = c.user?.login;
    const ours = typeof author === "string" && sameLogin(author, botLogin);
    const marker = ours ? parseMarker(c.body ?? "") : null;
    return marker
      ? {
          stage: marker.stage,
          kind: marker.kind,
          round: marker.round,
          data: payloadOf(marker),
          ...sessionOf(marker),
          at: c.created_at,
          byAgent: true,
        }
      : {
          stage: "-",
          kind: "human",
          round: 0,
          data: { body: c.body, author: author ?? "?", id: c.id },
          at: c.created_at,
          byAgent: false,
        };
  });
}
