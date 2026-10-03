import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/*
 * The pages under docs/ are what the README links out to, so a link that
 * resolves nowhere, or an anchor GitHub slugs differently from the one
 * written, is a dead end a reader meets on the first click. And a code block
 * with no language tag is one GitHub renders unhighlighted, and one a reader
 * cannot tell is a shell command or a file.
 */
const DOCS = "docs";
const pages = readdirSync(DOCS).filter((f) => f.endsWith(".md")).map((f) => join(DOCS, f));
// The README links into docs/ and shows its images through <picture>, so it
// is held to the same checks.
const checked = ["README.md", ...pages];

/** Each line outside a fenced code block, and each fence's opening info string. */
function scan(text: string): { prose: string[]; fences: Array<{ line: number; info: string }> } {
  const prose: string[] = [];
  const fences: Array<{ line: number; info: string }> = [];
  let open: string | null = null;
  text.split("\n").forEach((line, i) => {
    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (open === null && fence) {
      open = fence[1] ?? "";
      fences.push({ line: i + 1, info: (fence[2] ?? "").trim() });
    } else if (open !== null && fence && (fence[1] ?? "").startsWith(open) && (fence[2] ?? "").trim() === "") {
      open = null;
    } else if (open === null) {
      prose.push(line);
    }
  });
  return { prose, fences };
}

/** GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens, repeats numbered. */
function anchors(file: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const line of scan(readFileSync(file, "utf8")).prose) {
    const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!h) continue;
    const base = (h[1] ?? "").toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

/** Markdown link targets, and an HTML tag's href, src or srcset — a <picture>'s images. */
function links(file: string): string[] {
  return scan(readFileSync(file, "utf8")).prose
    .map((line) => line.replace(/`[^`]*`/g, ""))
    .flatMap((line) => [
      ...[...line.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1] ?? ""),
      ...[...line.matchAll(/\b(?:href|src|srcset)="([^"\s]+)"/g)].map((m) => m[1] ?? ""),
    ])
    .filter((href) => !/^[a-z][a-z+.-]*:/i.test(href));
}

describe("docs/", () => {
  it("has the pages the README links out to", () => {
    expect(pages).toEqual(expect.arrayContaining([
      "README.md", "configuration.md", "workflows.md", "validate.md", "cli.md", "integrations.md",
      "hooks.md", "architecture.md", "security.md", "development.md",
    ].map((f) => join(DOCS, f))));
  });

  it.each(checked)("%s tags every code block with its language", (page) => {
    const untagged = scan(readFileSync(page, "utf8")).fences.filter((f) => f.info === "").map((f) => f.line);
    expect(untagged).toEqual([]);
  });

  it.each(checked)("%s links only to files and headings that exist", (page) => {
    const broken = links(page).filter((href) => {
      const [path = "", anchor] = href.split("#");
      const target = path === "" ? page : join(dirname(page), decodeURI(path));
      if (!existsSync(target)) return true;
      return anchor !== undefined && !(target.endsWith(".md") && anchors(target).has(anchor));
    });
    expect(broken).toEqual([]);
  });
});
