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
  it.each(["https://github.com.evil.io/x", "https://evilgithub.com/x", "https://notatlassian.net/x"])(
    "does not mistake the lookalike %s for a known system",
    (link) => {
      expect(systemOf(link)?.icon).toBeNull();
    },
  );

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
