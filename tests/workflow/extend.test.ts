import { mergeSteps, splitSections } from "#workflow/extend.js";

const parent = {
  front: { capabilities: ["repo:read", "repo:write"], model: "opus", effort: "xhigh", output: { discriminator: "kind" } },
  body: "Lead of the parent.\n\n## What to build\n\nThe spec.\n\n## Procedure\n\nDo it.\n\n## Rules\n\nBe careful.\n",
};

describe("mergeSteps", () => {
  it("replaces a section with the same heading and keeps the rest in the parent's order", () => {
    const child = { front: {}, body: "## What to build\n\nThe item.\n" };
    const merged = mergeSteps(parent, child);
    expect(merged.body).toBe("Lead of the parent.\n\n## What to build\n\nThe item.\n\n## Procedure\n\nDo it.\n\n## Rules\n\nBe careful.\n");
  });
  it("appends a new heading at the end", () => {
    const merged = mergeSteps(parent, { front: {}, body: "## Extra\n\nMore.\n" });
    expect(merged.body.endsWith("## Rules\n\nBe careful.\n\n## Extra\n\nMore.\n")).toBe(true);
  });
  it("replaces the lead only when the child's lead is non-empty", () => {
    expect(mergeSteps(parent, { front: {}, body: "## Rules\n\nX.\n" }).body.startsWith("Lead of the parent.")).toBe(true);
    expect(mergeSteps(parent, { front: {}, body: "New lead.\n\n## Rules\n\nX.\n" }).body.startsWith("New lead.")).toBe(true);
  });
  it("replaces a front-matter key whole and inherits the others", () => {
    const merged = mergeSteps(parent, { front: { effort: "high", output: { discriminator: "x" } }, body: "" });
    expect(merged.front).toEqual({ capabilities: ["repo:read", "repo:write"], model: "opus", effort: "high", output: { discriminator: "x" } });
  });
  it("never carries extends into the merged step", () => {
    expect(mergeSteps(parent, { front: { extends: "../p.md" }, body: "" }).front).not.toHaveProperty("extends");
  });
});

describe("splitSections", () => {
  it("does not take a ## line inside a fenced code block for a heading", () => {
    const body = "Lead.\n\n## Procedure\n\n```md\n## not a heading\n```\n\n## Rules\n\nR.\n";
    expect(splitSections(body).sections.map((s) => s.heading)).toEqual(["Procedure", "Rules"]);
  });
});

describe("CRLF, fences and duplicates", () => {
  const crlf = (s: string): string => s.replace(/\n/g, "\r\n");
  it("merges a CRLF parent and child exactly as their LF equivalents", () => {
    const child = { front: {}, body: "## What to build\n\nThe item.\n" };
    const want = mergeSteps(parent, child);
    const got = mergeSteps({ front: parent.front, body: crlf(parent.body) }, { front: {}, body: crlf(child.body) });
    expect(got).toEqual(want);
  });
  it("closes a fence only with the same character, at least as long", () => {
    const body = "~~~\n```\n## x\n~~~\n## Real\n";
    expect(splitSections(body).sections.map((s) => s.heading)).toEqual(["Real"]);
    const long = "````\n```\n## x\n````\n## Real\n";
    expect(splitSections(long).sections.map((s) => s.heading)).toEqual(["Real"]);
  });
  it("reports a heading that appears twice", () => {
    expect(splitSections("## Rules\n\na\n\n## Rules\n\nb\n").duplicates).toEqual(["Rules"]);
    expect(splitSections("## A\n## B\n").duplicates).toEqual([]);
  });
});
