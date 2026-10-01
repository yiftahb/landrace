import type { ParsedStep } from "#namespace.js";

/**
 * A step body as its lead and its `## ` sections, in order. A `## ` inside a
 * fenced block is text, not a heading; a fence closes only with the character
 * that opened it, at least as long. CRLF files split the same as LF ones.
 * `duplicates` names each heading that appears more than once: a merge cannot
 * tell which of two it should replace, so the loader refuses the file.
 */
export function splitSections(body: string): {
  lead: string;
  sections: Array<{ heading: string; text: string }>;
  duplicates: string[];
} {
  const sections: Array<{ heading: string; lines: string[] }> = [];
  const lead: string[] = [];
  let fence: { char: string; length: number } | null = null;
  for (const line of body.split(/\r?\n/)) {
    const run = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (run !== undefined) {
      if (fence === null) fence = { char: run[0] as string, length: run.length };
      else if (run[0] === fence.char && run.length >= fence.length) fence = null;
    }
    const heading = fence === null && run === undefined && /^## (.+)$/.exec(line);
    if (heading) sections.push({ heading: (heading[1] ?? "").trim(), lines: [] });
    else (sections.at(-1)?.lines ?? lead).push(line);
  }
  const headings = sections.map((x) => x.heading);
  return {
    lead: lead.join("\n"),
    sections: sections.map((x) => ({ heading: x.heading, text: x.lines.join("\n") })),
    duplicates: [...new Set(headings.filter((h, i) => headings.indexOf(h) !== i))],
  };
}

const joinSections = (lead: string, sections: Array<{ heading: string; text: string }>): string =>
  [lead, ...sections.map((s) => `## ${s.heading}\n${s.text}`)].join("\n").replace(/^\n+/, "");

/**
 * A child step over its parent: each front-matter key the child gives replaces
 * the parent's whole; a `## ` section with the same heading replaces the
 * parent's in place, a new one goes at the end, and a non-empty lead replaces
 * the parent's lead. What the child does not mention, it inherits.
 */
export function mergeSteps(parent: ParsedStep, child: ParsedStep): ParsedStep {
  const parentFront = { ...parent.front };
  const childFront = { ...child.front };
  delete parentFront.extends;
  delete childFront.extends;
  const p = splitSections(parent.body);
  const c = splitSections(child.body);
  const replaced = new Map(c.sections.map((s) => [s.heading, s]));
  const sections = p.sections.map((s) => replaced.get(s.heading) ?? s);
  for (const s of c.sections) if (!p.sections.some((x) => x.heading === s.heading)) sections.push(s);
  return { front: { ...parentFront, ...childFront }, body: joinSections(c.lead.trim() ? c.lead : p.lead, sections) };
}
