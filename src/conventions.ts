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

const markerRe = () => /<!--\s*landrace\s+(\{.*?\})\s*-->/gs;

export const renderMarker = (m: Marker): string => `\n\n<!-- landrace ${JSON.stringify(m)} -->`;

function trailing(body: string): RegExpMatchArray | null {
  const all = [...body.matchAll(markerRe())];
  const last = all.at(-1);
  if (!last || last.index === undefined) return null;
  // Only a marker with nothing after it is ours. A body is free to *contain*
  // marker-shaped text — a document about this system quotes the format — and
  // taking the first match reads the example instead of the real one.
  return body.slice(last.index + last[0].length).trim() === "" ? last : null;
}

export function parseMarker(body: string): Marker | null {
  const m = trailing(body);
  if (!m) return null;
  try {
    const parsed: unknown = JSON.parse(m[1] as string);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { stage, kind, round } = parsed as Partial<Marker>;
    if (typeof stage !== "string" || typeof kind !== "string" || typeof round !== "number") return null;
    if (isReservedId(stage)) return null;
    return parsed as Marker;
  } catch {
    return null;
  }
}

export function stripMarker(body: string): string {
  const m = trailing(body);
  return (m && m.index !== undefined ? body.slice(0, m.index) : body).trim();
}

/**
 * Text we did not author must not be able to emit our control tokens. Escaped
 * rather than deleted: a document explaining the format should still show it,
 * just visibly and inertly.
 */
export const neutraliseMarkers = (body: string): string =>
  body.replace(markerRe(), (m) => `&lt;${m.slice(1, -1)}&gt;`);
