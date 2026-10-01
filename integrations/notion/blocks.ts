/*
 * Markdown as Notion blocks: the body a person reads on a ticket's row.
 *
 * Only how the spec looks rides on this. Its text round-trips through the
 * row's `Source` property, cut by `pieces`, so a step is briefed exactly what
 * was published whatever this makes of it. What it does not know — a table,
 * a rule, HTML, bold — is shown as written, never dropped.
 */

/** The most one rich text object holds, in UTF-16 units — Notion's own count. */
export const MAX_TEXT = 2000;

export interface RichText {
  type: "text";
  text: { content: string; link?: { url: string } };
  annotations?: { code: true };
}

export interface Block {
  object: "block";
  type: string;
  [type: string]: unknown;
}

/**
 * `text` in pieces of at most `MAX_TEXT` UTF-16 units that join back to it
 * exactly. A cut between the two halves of a surrogate pair would leave each
 * piece half an emoji, which Notion stores as U+FFFD — so that cut moves one
 * unit earlier.
 */
export function pieces(text: string): string[] {
  const out: string[] = [];
  for (let at = 0; at < text.length;) {
    let end = Math.min(at + MAX_TEXT, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    out.push(text.slice(at, end));
    at = end;
  }
  return out;
}

const rich = (content: string, { link, code }: { link?: string; code?: boolean } = {}): RichText[] =>
  pieces(content).map((piece) => ({
    type: "text",
    text: { content: piece, ...(link === undefined ? {} : { link: { url: link } }) },
    ...(code ? { annotations: { code: true } } : {}),
  }));

const block = (type: string, richText: RichText[], extra: Record<string, unknown> = {}): Block =>
  ({ object: "block", type, [type]: { rich_text: richText, ...extra } });

/** Notion refuses a link that is not an absolute URL, so only http(s) ones are made links. */
const linkable = (url: string): boolean => /^https?:\/\//i.test(url) && URL.canParse(url);

const INLINE = /`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)/g;

/** A line's inline code and links; everything else is its literal text. */
function inline(line: string): RichText[] {
  const out: RichText[] = [];
  let plain = "";
  let at = 0;
  const flush = (): void => {
    out.push(...rich(plain));
    plain = "";
  };
  for (const m of line.matchAll(INLINE)) {
    const [whole, code, label, url] = m;
    plain += line.slice(at, m.index);
    at = m.index + whole.length;
    if (code !== undefined) {
      flush();
      out.push(...rich(code, { code: true }));
    } else if (label !== undefined && url !== undefined && linkable(url)) {
      flush();
      out.push(...rich(label, { link: url }));
    } else {
      plain += whole;
    }
  }
  plain += line.slice(at);
  flush();
  return out;
}

/** Every language Notion's code block takes; any other fence tag is plain text. */
const LANGUAGES = new Set([
  "abap", "abc", "agda", "arduino", "ascii art", "assembly", "bash", "basic", "bnf", "c", "c#", "c++", "clojure",
  "coffeescript", "coq", "css", "dart", "dhall", "diff", "docker", "ebnf", "elixir", "elm", "erlang", "f#", "flow",
  "fortran", "gherkin", "glsl", "go", "graphql", "groovy", "haskell", "hcl", "html", "idris", "java", "javascript",
  "json", "julia", "kotlin", "latex", "less", "lisp", "livescript", "llvm ir", "lua", "makefile", "markdown", "markup",
  "matlab", "mathematica", "mermaid", "nix", "notion formula", "objective-c", "ocaml", "pascal", "perl", "php",
  "plain text", "powershell", "prolog", "protobuf", "purescript", "python", "r", "racket", "reason", "ruby", "rust",
  "sass", "scala", "scheme", "scss", "shell", "smalltalk", "solidity", "sql", "swift", "toml", "typescript", "vb.net",
  "verilog", "vhdl", "visual basic", "webassembly", "xml", "yaml", "java/c/c++/c#",
]);

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
/** A table row, HTML, a rule, or an indented code line: shown as written. */
const VERBATIM = /^\s*[|<]|^ {0,3}([-*_])(\s*\1){2,}\s*$|^( {4}|\t)/;

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** Whether a line begins a block of its own, ending a paragraph or list before it. */
const opens = (line: string): boolean =>
  FENCE.test(line) || HEADING.test(line) || QUOTE.test(line) || ITEM.test(line) || (VERBATIM.test(line) && indentOf(line) < 4);

interface Item { type: string; text: string; children: Item[] }

const itemBlock = (item: Item): Block =>
  block(item.type, inline(item.text), item.children.length ? { children: item.children.map(itemBlock) } : {});

/**
 * The list starting at `start`, as items one level deep — an item indented
 * under another is its child, however far it is indented — and where the
 * list ends.
 */
function list(lines: string[], start: number): [Item[], number] {
  const base = indentOf(lines[start] ?? "");
  const items: Item[] = [];
  let last: Item | undefined;
  let i = start;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      // A blank line ends the list, unless an item or an indented line goes on after it.
      let next = i + 1;
      while (next < lines.length && !lines[next]?.trim()) next++;
      const after = lines[next] ?? "";
      if (next < lines.length && !FENCE.test(after) && (ITEM.test(after) || indentOf(after) >= base + 2)) {
        i = next - 1;
        continue;
      }
      break;
    }
    if (FENCE.test(line)) break;
    const item = ITEM.exec(line);
    if (item) {
      const [, indent = "", marker = "", text = ""] = item;
      last = { type: /\d/.test(marker) ? "numbered_list_item" : "bulleted_list_item", text, children: [] };
      const parent = items.at(-1);
      // ponytail: one level, as the spec says; deeper items flatten into it rather than becoming verbatim.
      if (parent && indent.length >= base + 2) parent.children.push(last);
      else items.push(last);
      continue;
    }
    if (indentOf(line) < base + 2 && opens(line)) break;
    if (last) last.text += ` ${line.trim()}`;
  }
  return [items, i];
}

/** A markdown document as the blocks Notion shows for it, top-level blocks first, each list item's children inside it. */
export function toBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const [, indent = "", marks = "", tag = ""] = fence;
      const close = new RegExp(`^\\s*${marks[0] ?? "`"}{${marks.length},}\\s*$`);
      const body: string[] = [];
      for (i++; i < lines.length && !close.test(lines[i] ?? ""); i++) {
        const inner = lines[i] ?? "";
        body.push(inner.slice(Math.min(indent.length, indentOf(inner))));
      }
      i++;
      const language = LANGUAGES.has(tag.toLowerCase()) ? tag.toLowerCase() : "plain text";
      out.push(block("code", rich(body.join("\n")), { language }));
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const [, marks = "", text = ""] = heading;
      out.push(block(`heading_${Math.min(marks.length, 3)}`, inline(text)));
      i++;
      continue;
    }

    if (VERBATIM.test(line)) {
      const verbatim: string[] = [];
      for (; i < lines.length && VERBATIM.test(lines[i] ?? ""); i++) verbatim.push(lines[i] ?? "");
      out.push(block("code", rich(verbatim.join("\n")), { language: "markdown" }));
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      for (let q = QUOTE.exec(line); q; q = QUOTE.exec(lines[++i] ?? "")) quoted.push(q[1] ?? "");
      out.push(block("quote", inline(quoted.join("\n"))));
      continue;
    }

    if (ITEM.test(line)) {
      const [items, next] = list(lines, i);
      out.push(...items.map(itemBlock));
      i = next;
      continue;
    }

    const paragraph = [line.trim()];
    for (i++; i < lines.length && (lines[i] ?? "").trim() && !opens(lines[i] ?? ""); i++) paragraph.push((lines[i] ?? "").trim());
    out.push(block("paragraph", inline(paragraph.join(" "))));
  }
  return out;
}
