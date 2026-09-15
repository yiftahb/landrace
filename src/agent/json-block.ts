/**
 * One shared recognizer for both the screener (screen.ts) and the step
 * runner (runner/step.ts). Ambiguity halts either caller, so both need to
 * agree on what counts as *a candidate* block — two independent copies of
 * the same regex drift apart exactly the way they did here: both started
 * byte-identical, closed the "more than one ```json block" defect together,
 * and then quietly diverged on which fence *shapes* they could even see.
 *
 * Recognition (for counting) is deliberately permissive: any fence character
 * (``` or ~~~), any casing of "json", an unterminated fence, or a bare
 * top-level object carrying the caller's discriminator key all count as a
 * candidate. Parsing is not permissive: only a *strict* fence — exactly
 * ```json, nothing but whitespace before the content, and a genuine closing
 * fence — is ever obeyed as a sole answer.
 *
 * That split exists because "recognition only feeds the count, it never
 * loosens what gets parsed" is true going from one candidate to two, and
 * false going from zero to one: a lone unfenced or wrongly-fenced candidate
 * used to find *nothing* (kind: "none") and fail closed on its own — a
 * permissive recogniser that also parsed whatever it recognised turned that
 * into a real, obeyed answer. That is exactly how a screener quoting a
 * planted `{"verdict":"ok"}` while refusing in prose, or a bare object with
 * no fence at all, went from BLOCK to `{ok:true}`: the plant was never a
 * *second* candidate to be ambiguous with, it was the *only* one, and a
 * permissive parser has no candidate to disambiguate against — it just
 * obeys it. Keeping parsing narrow (strict fences only) while keeping
 * counting wide is what makes recognising more shapes strictly safer: a
 * shape that is not the first-class strict fence can now only ever push the
 * count from 1 to "many" (still refused) or itself resolve to
 * "not-strict-fence" (also refused) — never to a value some caller trusts.
 */
export type JsonBlockResult =
  | { kind: "none" }
  | { kind: "many"; count: number }
  /** Exactly one candidate overall, but it was not a strict ```json fence — a bare object, a ~~~ fence, wrong casing, unterminated, or json quoted inside an unrelated fence. Treated the same as "none" by every caller: fail closed, never obeyed. */
  | { kind: "not-strict-fence" }
  | { kind: "one"; value: Record<string, unknown> | null; span: [number, number] };

interface Candidate {
  start: number;
  end: number;
  content: string;
  strict: boolean;
  /** Set only for a bare candidate, whose json validity (and discriminator key) was already checked at detection time. */
  parsed?: unknown;
}

// `i` for casing ("json"/"JSON"/"Json"); the fence characters themselves have
// no case, so it is harmless there. The backreference \1 requires the same
// fence text to close it; `(?:\1|$)` falls back to end-of-string so an
// unterminated fence is still recognised as a candidate (its content will
// usually fail to parse on its own, but its mere presence must still count).
const FENCE_RE = /(`{3,}|~{3,})[ \t]*json[^\n]*\n([\s\S]*?)(?:\1|$)/gi;

/**
 * Byte-identical in spirit to the pattern this project safely parsed before
 * the permissive recogniser existed: exactly three backticks, lowercase
 * "json" with nothing but optional trailing horizontal whitespace before the
 * newline, and a genuine closing ``` — not the `$` fallback a permissive
 * match uses for an unterminated fence. Deliberately case-sensitive and
 * backtick-only: that is the entire point of the distinction.
 */
const STRICT_FENCE_RE = /^```json[ \t]*\n[\s\S]*```$/;

function fencedCandidates(text: string): Candidate[] {
  const found: Candidate[] = [];
  for (const m of text.matchAll(FENCE_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    found.push({ start, end, content: (m[2] ?? "").trim(), strict: STRICT_FENCE_RE.test(m[0]) });
  }
  return found;
}

/**
 * A bare `{...}` with no fence at all, depth- and string-aware so a nested
 * object or a brace inside a string literal does not end the span early.
 * Only scans text outside a fenced candidate's own span, so a fence's
 * content is never double-counted as a second, bare candidate.
 *
 * Counted only when it parses as json *and* carries `discriminatorKey` as an
 * own property. A fence marks intent even when its content is broken, so an
 * invalid fenced block still counts as a (failed) candidate above — but a
 * bare brace pair has no such marker, and prose is full of them (an error
 * object, a code snippet, a markdown table cell). Requiring the
 * discriminator key is what tells "this claims to be the answer" apart from
 * "this is an unrelated object that happens to parse" — `{"code":"ENOENT"}`
 * is never a candidate; `{"kind":"spec"}` always is, because it genuinely
 * claims the same role the real answer does. The key is a parameter, not a
 * hard-coded pair of names: the screener's is "verdict", a step's is
 * whatever its own front matter declares.
 *
 * A single pass with a monotonically advancing exclusion pointer, not
 * `exclude.find()` per character — the previous version re-scanned the
 * (sorted) exclusion list from the start at every position, which is
 * quadratic in (text length x fence count): 1MB of adversarial input took
 * over 20 seconds. `exclude` never overlaps itself (fenced spans are
 * disjoint), so once a range falls behind the scan it can never matter
 * again, and the pointer only ever moves forward.
 */
function bareCandidates(text: string, exclude: Candidate[], discriminatorKey: string): Candidate[] {
  const found: Candidate[] = [];
  const ranges = [...exclude].sort((a, b) => a.start - b.start);
  let rangeIdx = 0;

  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    while (rangeIdx < ranges.length && i >= (ranges[rangeIdx] as Candidate).end) rangeIdx++;
    const current = ranges[rangeIdx];
    if (current && i >= current.start && i < current.end) {
      i = current.end - 1;
      depth = 0;
      start = -1;
      inString = false;
      escaped = false;
      continue;
    }

    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      // JSON strings are only ever double-quoted; treating `'` as a
      // delimiter too made brace-depth tracking depend on apostrophe parity
      // in the surrounding prose ("don't ... won't" toggling in and out of
      // a fake string).
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
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
          const parsed = JSON.parse(content) as unknown;
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && Object.hasOwn(parsed, discriminatorKey)) {
            found.push({ start, end: i + 1, content, strict: false, parsed });
          }
        } catch {
          // Not valid json: not a candidate, just a brace pair in prose.
        }
        start = -1;
      }
    }
  }
  return found;
}

export function extractJsonBlock(text: string, discriminatorKey: string): JsonBlockResult {
  const fenced = fencedCandidates(text);
  const bare = bareCandidates(text, fenced, discriminatorKey);
  const all = [...fenced, ...bare].sort((a, b) => a.start - b.start);

  if (all.length === 0) return { kind: "none" };
  if (all.length > 1) return { kind: "many", count: all.length };

  const only = all[0] as Candidate;
  if (!only.strict) return { kind: "not-strict-fence" };

  const span: [number, number] = [only.start, only.end];
  if (!only.content) return { kind: "one", value: null, span };
  try {
    return { kind: "one", value: JSON.parse(only.content) as Record<string, unknown>, span };
  } catch {
    return { kind: "one", value: null, span };
  }
}
