/**
 * One shared recognizer for both the screener (screen.ts) and the step
 * runner (runner/step.ts). Ambiguity halts either caller, so both need to
 * agree on what counts as *a candidate* block — two independent copies of
 * the same regex drift apart exactly the way they did here: both started
 * byte-identical, closed the "more than one ```json block" defect together,
 * and then quietly diverged on which fence *shapes* they could even see.
 *
 * The recognizer is deliberately permissive: any fence character (``` or
 * ~~~), any casing of "json", an unterminated fence, or a bare top-level
 * object with no fence at all all count as a candidate. That is a *stricter*
 * policy than a narrow one, not a looser one — recognition only feeds the
 * ambiguity count, it never loosens what gets parsed. A restated example in
 * one fence style plus a real answer in a style a narrow regex could not see
 * used to look like exactly one candidate to both callers; now it looks like
 * two, and both callers already refuse to guess between two.
 */
export type JsonBlockResult =
  | { kind: "none" }
  | { kind: "many"; count: number }
  | { kind: "one"; value: Record<string, unknown> | null; span: [number, number] };

interface Candidate {
  start: number;
  end: number;
  content: string;
  /** Set only for a bare candidate, whose json validity was already checked at detection time. */
  parsed?: unknown;
}

// `i` for casing ("json"/"JSON"/"Json"); the fence characters themselves have
// no case, so it is harmless there. The backreference \1 requires the same
// fence text to close it; `(?:\1|$)` falls back to end-of-string so an
// unterminated fence is still recognised as a candidate (its content will
// usually fail to parse on its own, but its mere presence must still count).
const FENCE_RE = /(`{3,}|~{3,})[ \t]*json[^\n]*\n([\s\S]*?)(?:\1|$)/gi;

function fencedCandidates(text: string): Candidate[] {
  const found: Candidate[] = [];
  for (const m of text.matchAll(FENCE_RE)) {
    const start = m.index ?? 0;
    found.push({ start, end: start + m[0].length, content: (m[2] ?? "").trim() });
  }
  return found;
}

/**
 * A bare `{...}` with no fence at all, depth- and string-aware so a nested
 * object or a brace inside a string literal does not end the span early.
 * Only scans text outside a fenced candidate's own span, so a fence's
 * content is never double-counted as a second, bare candidate.
 *
 * Only a candidate that actually parses as json is counted. A fence marks
 * intent even when its content is broken, so an invalid fenced block still
 * counts as a (failed) candidate above — but a bare brace pair has no such
 * marker, and prose routinely contains one (a code snippet, say). Syntactic
 * validity is the only signal left to tell "an answer" from unrelated prose.
 */
function bareCandidates(text: string, exclude: Candidate[]): Candidate[] {
  const found: Candidate[] = [];
  let depth = 0;
  let start = -1;
  let inString: string | null = null;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const region = exclude.find((c) => i >= c.start && i < c.end);
    if (region) {
      i = region.end - 1;
      depth = 0;
      start = -1;
      inString = null;
      escaped = false;
      continue;
    }

    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) {
        const content = text.slice(start, i + 1);
        try {
          found.push({ start, end: i + 1, content, parsed: JSON.parse(content) as unknown });
        } catch {
          // Not valid json: not a candidate, just a brace pair in prose.
        }
        start = -1;
      }
    }
  }
  return found;
}

export function extractJsonBlock(text: string): JsonBlockResult {
  const fenced = fencedCandidates(text);
  const bare = bareCandidates(text, fenced);
  const all = [...fenced, ...bare].sort((a, b) => a.start - b.start);

  if (all.length === 0) return { kind: "none" };
  if (all.length > 1) return { kind: "many", count: all.length };

  const only = all[0] as Candidate;
  const span: [number, number] = [only.start, only.end];
  if (only.parsed !== undefined) return { kind: "one", value: only.parsed as Record<string, unknown>, span };
  if (!only.content) return { kind: "one", value: null, span };
  try {
    return { kind: "one", value: JSON.parse(only.content) as Record<string, unknown>, span };
  } catch {
    return { kind: "one", value: null, span };
  }
}
