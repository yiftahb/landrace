import type { Entry } from "../core/types.js";

/** What we stamp on everything we write, so we can recognise it later. */
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
 * Agent output must not be able to emit our control tokens. Escaped rather than
 * deleted: a document explaining the marker format should still show it, just
 * visibly and inertly.
 */
export const neutraliseMarkers = (body: string): string =>
  body.replace(markerRe(), (m) => `&lt;${m.slice(1, -1)}&gt;`);

export interface RawComment {
  id: number;
  body: string;
  created_at: string;
  user?: { login?: string } | null;
}

/**
 * Turn a tracker's comments into the engine's tracker-agnostic records. A
 * comment carrying a marker is ours; one without is a person's. This is the
 * only place GitHub's comment format is known — core never learns it.
 */
export function entriesFromComments(comments: RawComment[]): Entry[] {
  return comments.map((c) => {
    const marker = parseMarker(c.body ?? "");
    return marker
      ? { stage: marker.stage, kind: marker.kind, round: marker.round, data: marker, at: c.created_at, byAgent: true }
      : { stage: "-", kind: "human", round: 0, data: { body: c.body, author: c.user?.login ?? "?", id: c.id }, at: c.created_at, byAgent: false };
  });
}
