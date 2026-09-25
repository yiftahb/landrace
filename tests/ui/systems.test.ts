import { SYSTEMS, systemOf } from "#ui/systems.js";

describe("systemOf", () => {
  it.each([
    ["https://github.com/acme/widgets/pull/118", "GitHub"],
    ["https://www.github.com/acme/widgets", "GitHub"],
    ["https://gitlab.com/acme/widgets/-/merge_requests/3", "GitLab"],
    ["https://bitbucket.org/acme/widgets", "Bitbucket"],
    ["https://acme.atlassian.net/browse/PROJ-7", "Jira"],
    ["https://acme.atlassian.net/wiki/spaces/ENG/pages/1", "Confluence"],
    ["https://www.notion.so/acme/Spec-123", "Notion"],
    ["https://acme.notion.site/Spec-123", "Notion"],
    ["https://linear.app/acme/issue/ENG-4", "Linear"],
    ["https://docs.google.com/document/d/abc", "Google Docs"],
    ["https://www.figma.com/file/abc", "Figma"],
  ])("%s is %s, with a mark", (link, name) => {
    const system = systemOf(link);
    expect(system?.name).toBe(name);
    expect(system?.icon).not.toBeNull();
  });

  it("names an unknown host by its hostname, with no mark", () => {
    expect(systemOf("https://git.internal.acme.io/x/y")).toEqual({ name: "git.internal.acme.io", icon: null });
  });

  // Lookalikes are the reason matching is on whole host labels, never a substring.
  it.each([
    "https://github.com.evil.io/x", "https://evilgithub.com/x", "https://notatlassian.net/x",
    "https://github.io.evil.io/x", "https://evilgithub.io/x",
  ])(
    "does not mistake the lookalike %s for a known system",
    (link) => {
      expect(systemOf(link)?.icon).toBeNull();
    },
  );

  /*
   * Where a published spec lives. Its own name, so the row says the page is on
   * Pages rather than in the repository — and GitHub's mark, because it is.
   */
  it("names a GitHub Pages site as GitHub Pages, with GitHub's own mark", () => {
    const pages = systemOf("https://acme.github.io/widgets/specs/19/");
    expect(pages?.name).toBe("GitHub Pages");
    expect(pages?.icon).not.toBeNull();
    expect(pages?.icon).toEqual(systemOf("https://github.com/acme/widgets")?.icon);
  });

  it("gives Pages only to a subdomain of github.io, at any depth, and leaves github.com GitHub", () => {
    expect(systemOf("https://a.b.github.io/x")?.name).toBe("GitHub Pages");
    expect(systemOf("https://github.io/x")).toEqual({ name: "github.io", icon: null });
    expect(systemOf("https://github.com/acme/widgets")?.name).toBe("GitHub");
  });

  it("refuses anything that is not an http(s) URL", () => {
    expect(systemOf("javascript:alert(1)")).toBeNull();
    expect(systemOf("not a url")).toBeNull();
    expect(systemOf("")).toBeNull();
  });

  it("keeps every mark to a colour and one or two plain letters, which is all the page will draw", () => {
    for (const mark of Object.values(SYSTEMS)) {
      expect(mark.bg).toMatch(/^#[0-9a-f]{6}$/i);
      expect(mark.glyph).toMatch(/^[A-Z]{1,2}$/);
    }
  });
});
