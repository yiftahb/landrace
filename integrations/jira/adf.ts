/*
 * Markdown as the Atlassian Document Format REST v3 takes, and back.
 *
 * Not v2's wiki markup: there `{x}` opens a macro and `\\` is a line break,
 * and a marker's JSON is full of both, so the marker Jira kept would not be
 * the one we wrote. ADF text is verbatim. A step writes Markdown, so the
 * common set — headings, lists, fenced code, inline code, bold, italic,
 * links, paragraphs — is written as the nodes a person sees rendered, and
 * read back as the same Markdown, a person's own edits included: a spec's
 * code block reaches a build step as a code block, not as flattened text.
 *
 * The trailing `<!-- landrace … -->` marker is cut off before any of this
 * and written as its own plain-text paragraph, so no Markdown reading of the
 * body — an unclosed fence, a `*` in the JSON — can reach it, and it reads
 * back byte for byte.
 */

export interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: AdfMark[];
  content?: AdfNode[];
}

export interface AdfDoc {
  type: "doc";
  version: 1;
  content: AdfNode[];
}

/** One line, as `renderMarker` writes it: its JSON escapes every newline. */
const MARKER = /(?:^|\n)(<!--[ \t]*landrace[ \t][^\n]*-->)\s*$/;

/** As CommonMark: a backtick fence's info string holds no backtick, so ```` ```npm install``` ```` is a code span. */
const FENCE = /^(\s*)(`{3,}(?=[^`]*$)|~{3,})\s*([^\s`]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;

/**
 * Inline code (any run of backticks, closed by the same run), a link, bold,
 * then italic as `*x*` or `_x_` — `_` only at a word's edges, so `a_b_c` is
 * a name, not emphasis. Emphasis opens and closes on a non-space, so
 * `3 * 4 * 5` is arithmetic.
 */
const CODE = /(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)/g;
const INLINE = new RegExp(
  `${CODE.source}|\\[([^\\]\\n]+)\\]\\(([^()\\s]+)\\)|\\*\\*(\\S(?:.*?\\S)?)\\*\\*|\\*([^\\s*](?:.*?[^\\s*])?)\\*|(?<!\\w)_([^\\s_](?:.*?[^\\s_])?)_(?!\\w)`,
  "dg",
);

/**
 * The line with each code span's text blanked to a character no other syntax
 * reads, its length kept: as CommonMark, a code span binds before emphasis or
 * a link, so `*.md` before `` `docs/*.md` `` does not close on the `*` inside.
 */
const masked = (line: string): string => line.replace(CODE, (_, ticks: string, code: string) => ticks + "\u0001".repeat(code.length) + ticks);

const text = (value: string, marks: AdfMark[]): AdfNode =>
  marks.length ? { type: "text", text: value, marks } : { type: "text", text: value };

const withMark = (marks: AdfMark[], mark: AdfMark): AdfMark[] => (marks.some((m) => m.type === mark.type) ? marks : [...marks, mark]);

/** Only a link a person can safely follow is made one; anything else stays the text it was written as. */
const linkable = (url: string): boolean => /^(https?|mailto):/i.test(url) && URL.canParse(url);

/** One line's inline nodes; no empty text node, which Jira refuses. Jira takes code beside a link and no other mark. */
function inline(line: string, marks: AdfMark[] = []): AdfNode[] {
  const out: AdfNode[] = [];
  let at = 0;
  const plain = (s: string): void => {
    if (s) out.push(text(s, marks));
  };
  for (const m of masked(line).matchAll(INLINE)) {
    const group = (k: number): string | undefined => {
      const span = m.indices?.[k];
      return span ? line.slice(...span) : undefined;
    };
    const [whole, code, label, url, strong, star, under] = [0, 2, 3, 4, 5, 6, 7].map(group) as [string, ...Array<string | undefined>];
    if (label !== undefined && url !== undefined && !linkable(url)) continue;
    plain(line.slice(at, m.index));
    at = m.index + whole.length;
    if (code !== undefined) {
      // As CommonMark: one space either side is padding, so a code span can open or close on a backtick.
      const unpadded = /^ (.*[^ ].*) $/.exec(code)?.[1] ?? code;
      out.push(text(unpadded, [...marks.filter((k) => k.type === "link"), { type: "code" }]));
    } else if (label !== undefined) out.push(...inline(label, withMark(marks, { type: "link", attrs: { href: url } })));
    else if (strong !== undefined) out.push(...inline(strong, withMark(marks, { type: "strong" })));
    else out.push(...inline(star ?? under ?? "", withMark(marks, { type: "em" })));
  }
  plain(line.slice(at));
  return out;
}

/** Lines as a paragraph's content, a `hardBreak` between each two. */
const lines = (texts: string[]): AdfNode[] =>
  texts.flatMap((line, i) => [...(i > 0 ? [{ type: "hardBreak" }] : []), ...inline(line)]);

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** Whether a line begins a block of its own, ending a paragraph before it. */
const opens = (line: string): boolean => FENCE.test(line) || HEADING.test(line) || ITEM.test(line);

/** Jira's list item opens with a paragraph or code and holds no heading. */
function listItem(content: AdfNode[]): AdfNode {
  const held = content.map((n) => (n.type === "heading" ? { type: "paragraph", content: n.content ?? [] } : n));
  const first = held[0]?.type;
  return { type: "listItem", content: first === "paragraph" || first === "codeBlock" ? held : [{ type: "paragraph", content: [] }, ...held] };
}

/**
 * The list starting at `start`, and where it ends. Each item's own lines —
 * those indented to its text, and a lazy line straight after its text — are
 * read as blocks of their own, so a nested list or a code block inside an
 * item is the same Markdown as anywhere else.
 */
function list(source: string[], start: number): [AdfNode, number] {
  const first = ITEM.exec(source[start] ?? "");
  const base = first?.[1]?.length ?? 0;
  const ordered = /\d/.test(first?.[2] ?? "");
  const items: AdfNode[] = [];
  let i = start;
  for (;;) {
    const m = ITEM.exec(source[i] ?? "");
    if (!m) break;
    const [, indent = "", marker = "", rest = ""] = m;
    if (indent.length < base || indent.length >= base + 2 || /\d/.test(marker) !== ordered) break;
    const column = indent.length + marker.length + 1;
    const own = [rest];
    for (i++; i < source.length; i++) {
      const line = source[i] ?? "";
      if (!line.trim()) {
        let next = i + 1;
        while (next < source.length && !source[next]?.trim()) next++;
        if (next < source.length && indentOf(source[next] ?? "") >= column) {
          own.push("");
          continue;
        }
        break;
      }
      if (indentOf(line) >= column) own.push(line.slice(column));
      else if (own.at(-1) && !opens(line)) own.push(line.trim());
      else break;
    }
    items.push(listItem(blocks(own)));
    // A blank line between two items of the one list does not end it.
    let next = i;
    while (next < source.length && !source[next]?.trim()) next++;
    if (!ITEM.test(source[next] ?? "")) break;
    i = next;
  }
  const order = Number.parseInt(first?.[2] ?? "1", 10);
  return [{ type: ordered ? "orderedList" : "bulletList", ...(ordered && order !== 1 ? { attrs: { order } } : {}), content: items }, i];
}

/** Markdown lines as ADF blocks. */
function blocks(source: string[]): AdfNode[] {
  const out: AdfNode[] = [];
  let i = 0;
  while (i < source.length) {
    const line = source[i] ?? "";
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const [, indent = "", marks = "", language = ""] = fence;
      const close = new RegExp(`^\\s*${marks[0] === "~" ? "~" : "`"}{${marks.length},}\\s*$`);
      const body: string[] = [];
      for (i++; i < source.length && !close.test(source[i] ?? ""); i++) {
        const inner = source[i] ?? "";
        body.push(inner.slice(Math.min(indent.length, indentOf(inner))));
      }
      i++;
      const code = body.join("\n");
      out.push({
        type: "codeBlock",
        ...(language ? { attrs: { language } } : {}),
        content: code ? [{ type: "text", text: code }] : [],
      });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const [, marks = "", title = ""] = heading;
      out.push({ type: "heading", attrs: { level: marks.length }, content: inline(title) });
      i++;
      continue;
    }

    if (ITEM.test(line)) {
      const [node, next] = list(source, i);
      out.push(node);
      i = next;
      continue;
    }

    const paragraph = [line];
    for (i++; i < source.length && source[i]?.trim() && !opens(source[i] ?? ""); i++) paragraph.push(source[i] ?? "");
    out.push({ type: "paragraph", content: lines(paragraph) });
  }
  return out;
}

/** Markdown as a document, its trailing marker a plain-text paragraph of its own. */
export function toAdf(markdown: string): AdfDoc {
  const marker = MARKER.exec(markdown);
  const body = marker ? markdown.slice(0, marker.index) : markdown;
  const content = blocks(body.replace(/\r\n?/g, "\n").split("\n"));
  if (marker?.[1]) content.push({ type: "paragraph", content: [{ type: "text", text: marker[1] }] });
  return { type: "doc", version: 1, content: content.length ? content : [{ type: "paragraph", content: [] }] };
}

/**
 * Text as it was written, a paragraph per `\n\n` block and a `hardBreak` per
 * `\n` inside one, no Markdown read: several times smaller than `toAdf`'s
 * document, and `fromAdf` reads it back exactly, marker and all.
 */
export const plainAdf = (text: string): AdfDoc => ({
  type: "doc",
  version: 1,
  content: text.split("\n\n").map((block) => ({
    type: "paragraph",
    content: block.split("\n").flatMap((line, i): AdfNode[] => [
      ...(i > 0 ? [{ type: "hardBreak" }] : []),
      ...(line === "" ? [] : [{ type: "text", text: line }]),
    ]),
  })),
});

/** The node types that sit inside a line of text, rather than being a block of their own. */
const INLINE_TYPES = new Set(["text", "hardBreak", "mention", "emoji", "inlineCard", "date", "status", "mediaInline", "placeholder"]);

const nodeOf = (node: unknown): AdfNode | null => (node !== null && typeof node === "object" ? (node as AdfNode) : null);
const childrenOf = (node: AdfNode): unknown[] => (Array.isArray(node.content) ? node.content : []);

/**
 * Code in a run of backticks longer than any its text holds, padded where it
 * holds one or opens or closes on a space — never when it is all spaces,
 * which Markdown does not unpad.
 */
function codeSpan(value: string): string {
  const ticks = "`".repeat(Math.max(0, ...[...value.matchAll(/`+/g)].map((r) => r[0].length)) + 1);
  const pad = /`/.test(value) || (/^ | $/.test(value) && /[^ ]/.test(value)) ? " " : "";
  return `${ticks}${pad}${value}${pad}${ticks}`;
}

/**
 * A text node as Markdown. Spaces at the edges of bold or italic go outside
 * it, where Markdown needs them. Italic is `_x_`, so bold italic is
 * `**_x_**` and never a run of three `*` that reads back otherwise.
 *
 * ponytail: a person's literal `*` or `_` is not escaped, and `_x_` against
 * a letter reads back as plain; escape both if a step ever misreads one.
 */
function marked(node: AdfNode): string {
  const value = typeof node.text === "string" ? node.text : "";
  const marks = Array.isArray(node.marks) ? node.marks : [];
  const has = (type: string): boolean => marks.some((m) => m?.type === type);
  const href = marks.find((m) => m?.type === "link")?.attrs?.href;
  if (has("code")) return typeof href === "string" ? `[${codeSpan(value)}](${href})` : codeSpan(value);
  const [, lead = "", core = "", trail = ""] = /^(\s*)([\s\S]*?)(\s*)$/.exec(value) ?? [];
  if (!core) return value;
  let out = core;
  if (has("em")) out = `_${out}_`;
  if (has("strong")) out = `**${out}**`;
  if (typeof href === "string") out = `[${out}](${href})`;
  return `${lead}${out}${trail}`;
}

const inlineOf = (nodes: unknown[]): string =>
  nodes.map((n) => { const node = nodeOf(n); return node?.type === "text" ? marked(node) : fromAdf(n); }).join("");

/** Every line after the first indented by `width`, a blank line left blank. */
const indent = (block: string, width: number): string =>
  block.split("\n").map((line, i) => (i > 0 && line ? " ".repeat(width) + line : line)).join("\n");

function listOf(node: AdfNode, ordered: boolean): string {
  const order = node.attrs?.order;
  const start = ordered && typeof order === "number" && Number.isInteger(order) ? order : 1;
  return childrenOf(node).map((item, k) => {
    const bullet = ordered ? `${start + k}. ` : "- ";
    const parts = childrenOf(nodeOf(item) ?? { type: "" });
    // A nested list sits tight under its item's text; anything else after it is a block of its own.
    const body = parts.map((part, j) => (j === 0 ? "" : /List$/.test(nodeOf(part)?.type ?? "") ? "\n" : "\n\n") + fromAdf(part)).join("");
    return bullet + indent(body, bullet.length);
  }).join("\n");
}

function codeBlockOf(node: AdfNode): string {
  const code = childrenOf(node).map((n) => nodeOf(n)?.text ?? "").join("");
  const fence = "`".repeat(Math.max(2, ...[...code.matchAll(/`+/g)].map((r) => r[0].length)) + 1);
  const language = typeof node.attrs?.language === "string" ? node.attrs.language.replace(/[\s`]/g, "") : "";
  return `${fence}${language}\n${code}\n${fence}`;
}

/**
 * A document as Markdown: `toAdf`'s inverse for what it writes, and a
 * person's document in the same common set. Any other node is its text —
 * a mention its name, a card its URL, a panel or a table its blocks apart
 * by a blank line. Anything unreadable is no text, never a throw: a comment
 * Jira holds is a comment, whatever its shape.
 */
export function fromAdf(value: unknown): string {
  const node = nodeOf(value);
  if (!node) return "";
  const { type, attrs } = node;
  if (type === "text") return typeof node.text === "string" ? node.text : "";
  if (type === "hardBreak") return "\n";
  if (type === "inlineCard") return typeof attrs?.url === "string" ? attrs.url : "";
  if (type === "paragraph") return inlineOf(childrenOf(node));
  if (type === "heading") {
    const level = typeof attrs?.level === "number" ? Math.min(6, Math.max(1, Math.trunc(attrs.level))) : 1;
    return `${"#".repeat(level)} ${inlineOf(childrenOf(node))}`;
  }
  if (type === "bulletList" || type === "orderedList") return listOf(node, type === "orderedList");
  if (type === "codeBlock") return codeBlockOf(node);
  if (!Array.isArray(node.content)) return typeof attrs?.text === "string" ? attrs.text : "";
  const content = childrenOf(node);
  const inlineOnly = content.every((c) => INLINE_TYPES.has(nodeOf(c)?.type ?? ""));
  return inlineOnly ? inlineOf(content) : content.map(fromAdf).join("\n\n");
}
