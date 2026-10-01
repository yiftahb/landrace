import type { ParsedStep } from "#namespace.js";

/** A step body as its lead and its `## ` sections, in order. A `## ` inside a fenced block is text, not a heading. */
export function splitSections(body: string): { lead: string; sections: Array<{ heading: string; text: string }> } {
  const lines = body.split("\n");
  const sections: Array<{ heading: string; lines: string[] }> = [];
  const lead: string[] = [];
  let fenced = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const heading = !fenced && /^## (.+)$/.exec(line);
    if (heading) sections.push({ heading: (heading[1] ?? "").trim(), lines: [] });
    else (sections.at(-1)?.lines ?? lead).push(line);
  }
  return {
    lead: lead.join("\n"),
    sections: sections.map((s) => ({ heading: s.heading, text: s.lines.join("\n") })),
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
