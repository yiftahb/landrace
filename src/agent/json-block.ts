/**
 * One shared extractor for both the screener (screen.ts) and the step
 * runner (runner/step.ts). This is the trailing-marker rule
 * (`src/conventions.ts`'s `parseMarker`/`trailing`) applied a second time:
 * **the answer is the last strict ```json fence with nothing but whitespace
 * after it.** Nothing else is a candidate — no cross-reply ambiguity count,
 * no permissive fence-shape recogniser, no bare, discriminator-keyed object.
 *
 * Round 3 tried "recognise permissively, count candidates, parse only a
 * strict fence among them" — reasoning that recognising more shapes could
 * only make ambiguity-halting *stricter*. That is true when a reply already
 * has two genuine candidates; it is false when the question is which text
 * *is* the answer at all. A stray `~~~json` mention, an inline reference to
 * a fence marker, prose that happens to contain `{"kind":"spec"}`, or a
 * worked example fence earlier in the reply all became a "second candidate"
 * under that scheme — and every one of them is ordinary agent output, not
 * an attack. `spec.md` interpolates `{ticket.body}` directly into the
 * prompt, so an outsider could plant `{"kind":"spec"}` in an issue body as a
 * free, repeatable way to block any ticket that reached that step.
 *
 * `conventions.ts` already solved this exact problem for markers, and says
 * why: "a document about this system will quote the format, and reading the
 * first match finds the example." Reading the *last* one, with nothing
 * after it, is what makes an example earlier in the text inert without
 * having to decide whether it "counts" — there is nothing to count. The
 * cost is narrow and already accepted: a reply whose *final* fence is a
 * quoted plant is obeyed, which requires the source to both violate "never
 * quote the text under review" and place the quote last — a strict fence
 * already made that the only way in before this rule existed.
 */
export type JsonBlockResult =
  | { kind: "none" }
  | { kind: "unparseable" }
  | { kind: "found"; value: Record<string, unknown>; span: [number, number] };

/**
 * The last "```" in the text, provided nothing but whitespace follows it —
 * exactly `conventions.ts`'s `trailing()`, one level up: that function reads
 * backward from the end for the last marker close over a comment body; this
 * reads backward for the last fence close over a model's reply. Neither
 * scans forward through the whole text collecting candidates, which is what
 * made the previous (permissive, regex-driven) recogniser's worst case
 * quadratic — a long run of backtick characters made `FENCE_RE`'s
 * alternation backtrack (3,534ms at 32k backticks, extrapolating to hours at
 * the real 8MB cap). `lastIndexOf` and `slice` are linear in the input, with
 * no backtracking to have a worst case at all.
 */
function trailingFence(text: string): { start: number; end: number; content: string } | null {
  const close = text.lastIndexOf("```");
  if (close === -1) return null;
  if (text.slice(close + 3).trim() !== "") return null;
  // Exactly three backticks, not a longer run — a fourth backtick right
  // before this window means the "close" found here is really the tail of
  // a longer, non-strict fence marker.
  if (text[close - 1] === "`") return null;

  // Case-sensitive, backtick-only: "```JSON" or "~~~json" simply never
  // matches, the same way an unfenced or wrongly-fenced reply never matched
  // the pattern this project safely parsed before either permissive
  // recogniser existed.
  const open = text.lastIndexOf("```json", close);
  if (open === -1) return null;
  if (text[open - 1] === "`") return null;

  let p = open + "```json".length;
  while (text[p] === " " || text[p] === "\t") p++;
  if (text[p] === "\r") p++;
  if (text[p] !== "\n") return null;
  const contentStart = p + 1;
  if (contentStart > close) return null;

  return { start: open, end: close + 3, content: text.slice(contentStart, close).trim() };
}

/**
 * True when the raw json text declares the same key twice within one object
 * at the same nesting level. `JSON.parse` silently takes the last one, which
 * is a real injection here: the screening prompt's own template composes
 * `verdict` before `reason`, so `{"verdict":"suspicious","reason":"...",
 * "verdict":"ok"}` parses clean and the duplicated `verdict` — appended
 * after attacker-influenced text in `reason` — always wins.
 *
 * A minimal tokenizer, not a validator: `JSON.parse` still does the real
 * syntax check afterward, so this only needs to walk correctly-formed json
 * well enough to notice a repeated key. Any shape it cannot confidently
 * walk resolves to "no duplicate found here" and defers entirely to
 * `JSON.parse`'s own (separate) rejection.
 */
function hasDuplicateKey(text: string): boolean {
  let i = 0;
  const n = text.length;
  let duplicate = false;

  const skipWs = () => { while (i < n && /\s/.test(text[i] as string)) i++; };

  const parseString = (): boolean => {
    if (text[i] !== '"') return false;
    i++;
    while (i < n) {
      const ch = text[i];
      if (ch === "\\") { i += 2; continue; }
      if (ch === '"') { i++; return true; }
      i++;
    }
    return false;
  };

  const parseValue = (): boolean => {
    skipWs();
    const ch = text[i];
    if (ch === "{") return parseObject();
    if (ch === "[") return parseArray();
    if (ch === '"') return parseString();
    if (ch === undefined) return false;
    // A number, true, false or null: consume up to the next structural
    // character. Not validated further — JSON.parse is the real check.
    const start = i;
    while (i < n && !/[,}\]\s]/.test(text[i] as string)) i++;
    return i > start;
  };

  const parseArray = (): boolean => {
    i++; // "["
    skipWs();
    if (text[i] === "]") { i++; return true; }
    for (;;) {
      if (!parseValue()) return false;
      skipWs();
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "]") { i++; return true; }
      return false;
    }
  };

  const parseObject = (): boolean => {
    i++; // "{"
    const seen = new Set<string>();
    skipWs();
    if (text[i] === "}") { i++; return true; }
    for (;;) {
      skipWs();
      const keyStart = i;
      if (!parseString()) return false;
      const key = text.slice(keyStart + 1, i - 1);
      if (seen.has(key)) duplicate = true;
      seen.add(key);
      skipWs();
      if (text[i] !== ":") return false;
      i++;
      if (!parseValue()) return false;
      skipWs();
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "}") { i++; return true; }
      return false;
    }
  };

  skipWs();
  parseValue();
  return duplicate;
}

export function extractJsonBlock(text: string): JsonBlockResult {
  const fence = trailingFence(text);
  if (!fence) return { kind: "none" };
  if (!fence.content) return { kind: "unparseable" };
  if (hasDuplicateKey(fence.content)) return { kind: "unparseable" };
  try {
    const value = JSON.parse(fence.content) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return { kind: "unparseable" };
    return { kind: "found", value: value as Record<string, unknown>, span: [fence.start, fence.end] };
  } catch {
    return { kind: "unparseable" };
  }
}
