/*
 * Plain text as the Atlassian Document Format REST v3 takes, and back.
 *
 * Not v2's wiki markup: there `{x}` opens a macro and `\\` is a line break,
 * and a marker's JSON is full of both, so the marker Jira kept would not be
 * the one we wrote. ADF text is verbatim. The two directions are exact
 * inverses for anything `toAdf` writes — a paragraph per blank-line block, a
 * hard break per line — so a marker written last reads back last, unchanged.
 */

export interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
}

export interface AdfDoc {
  type: "doc";
  version: 1;
  content: AdfNode[];
}

/** A paragraph per `\n\n` block, a `hardBreak` per `\n` inside one; no empty text node, which Jira refuses. */
export const toAdf = (text: string): AdfDoc => ({
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
const INLINE = new Set(["text", "hardBreak", "mention", "emoji", "inlineCard", "date", "status", "mediaInline", "placeholder"]);

/**
 * A document as text: `toAdf`'s exact inverse, and a person's headings,
 * lists and mentions as their words — blocks apart by a blank line, inline
 * nodes run together. Anything unreadable is no text, never a throw: a
 * comment Jira holds is a comment, whatever its shape.
 */
export function fromAdf(node: unknown): string {
  if (node === null || typeof node !== "object") return "";
  const { type, text, attrs, content } = node as AdfNode;
  if (type === "text") return typeof text === "string" ? text : "";
  if (type === "hardBreak") return "\n";
  if (type === "inlineCard") return typeof attrs?.url === "string" ? attrs.url : "";
  if (!Array.isArray(content)) return typeof attrs?.text === "string" ? attrs.text : "";
  const inline = content.every((c) => INLINE.has((c as AdfNode | null)?.type ?? ""));
  return content.map(fromAdf).join(inline ? "" : "\n\n");
}
