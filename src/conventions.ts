/**
 * Shared vocabulary: the labels the workflow uses to record position, the
 * marker we stamp on everything we write, and how a tracker's records read
 * back as the engine's. None of it belongs to a tracker — a Jira hook would
 * use the same names — so none of it lives in a hook.
 */
import type { Entry, Marker, TrackerComment, Trailing } from "#namespace.js";

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

/** Position is a label, so two of them means we cannot place the ticket. */
export function stageFromLabels(labels: string[]): { stage: string | null; ambiguous: boolean } {
  const found = labels.map((l) => STAGE_RE.exec(l)?.[1]).filter((s): s is string => Boolean(s));
  return { stage: found[0] ?? null, ambiguous: found.length > 1 };
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
 */
export const CAPABILITIES = ["repo:read", "repo:write"] as const;

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
  const bot = botLogin.trim().toLowerCase();

  return comments.map((c) => {
    // Logins are compared case-insensitively, the way trackers treat them.
    const author = c.user?.login;
    const ours = typeof author === "string" && author.toLowerCase() === bot;
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
