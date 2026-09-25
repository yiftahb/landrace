import type { BoardSystem, SystemMark } from "#namespace.js";

/*
 * The one file under src/ that names vendors, and only as labels for a URL a
 * hook already handed us — tests/boundaries.test.ts allowlists it by exact
 * path and pins that it imports nothing and calls nothing. No icons are
 * fetched: the page's CSP forbids remote images, and a favicon request would
 * send every private link's hostname out through the browser.
 *
 * Keys are hostnames, `*.` for "any subdomain of", and `/wiki` appended for
 * Confluence, which shares Jira's hosts and differs only by path.
 */
export const SYSTEMS: Readonly<Record<string, SystemMark>> = {
  "github.com": { name: "GitHub", bg: "#24292f", glyph: "GH" },
  // A project site, where a published spec lives: GitHub's mark, its own name,
  // so a row says the page is on Pages rather than in the repository.
  "*.github.io": { name: "GitHub Pages", bg: "#24292f", glyph: "GH" },
  "gitlab.com": { name: "GitLab", bg: "#fc6d26", glyph: "GL" },
  "bitbucket.org": { name: "Bitbucket", bg: "#2684ff", glyph: "B" },
  "*.atlassian.net": { name: "Jira", bg: "#0052cc", glyph: "J" },
  "*.atlassian.net/wiki": { name: "Confluence", bg: "#1868db", glyph: "C" },
  "notion.so": { name: "Notion", bg: "#191919", glyph: "N" },
  "*.notion.site": { name: "Notion", bg: "#191919", glyph: "N" },
  "linear.app": { name: "Linear", bg: "#5e6ad2", glyph: "L" },
  "docs.google.com": { name: "Google Docs", bg: "#4285f4", glyph: "D" },
  "figma.com": { name: "Figma", bg: "#a259ff", glyph: "F" },
};

/**
 * The system a link belongs to. Exact host first, then each `*.` suffix from
 * the longest down — specificity, not table order, so two entries can never
 * both claim a host by being listed first. Matching is on whole dot-separated
 * labels: `github.com.evil.io` and `evilgithub.com` are not GitHub.
 */
export function systemOf(link: string): BoardSystem | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const wiki = url.pathname === "/wiki" || url.pathname.startsWith("/wiki/");
  const labels = host.split(".");
  const keys = [host, ...labels.slice(1).map((_, i) => `*.${labels.slice(i + 1).join(".")}`)];

  for (const key of keys) {
    const mark = (wiki ? SYSTEMS[`${key}/wiki`] : undefined) ?? SYSTEMS[key];
    if (mark) return { name: mark.name, icon: { bg: mark.bg, glyph: mark.glyph } };
  }
  return { name: host, icon: null };
}
