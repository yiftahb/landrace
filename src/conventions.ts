/**
 * Shared vocabulary: the labels the workflow uses to record position, and the
 * marker we stamp on everything we write. Neither belongs to a tracker — a Jira
 * adapter would use the same names — so neither lives in `src/adapters/`.
 */

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

/** GitHub label names are compared case-insensitively, so this is too. */
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

export interface Marker {
  stage: string;
  kind: string;
  round: number;
  [key: string]: unknown;
}

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
 * so a marker large enough to be accepted is always small enough to be seen.
 */
const MARKER_MAX_PAYLOAD = 8 * 1024;
const MARKER_MAX_DEPTH = 8;
const TAIL_WINDOW = MARKER_MAX_PAYLOAD + 256;

const markerRe = () => /<!--\s*landrace\s+(\{.*?\})\s*-->/gs;
const TRAILING_RE = /^<!--\s*landrace\s+(\{[\s\S]*\})\s*-->$/;

export const renderMarker = (m: Marker): string => `\n\n<!-- landrace ${JSON.stringify(m)} -->`;

interface Trailing {
  index: number;
  json: string;
}

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
  const m = trailing(body);
  if (!m || m.json.length > MARKER_MAX_PAYLOAD) return null;
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
 */
export const neutraliseMarkers = (body: string): string =>
  body.replace(markerRe(), (m) => `&lt;${m.slice(1, -1)}&gt;`);
