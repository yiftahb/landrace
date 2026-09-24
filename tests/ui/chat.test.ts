import { chatFor } from "#ui/chat.js";

describe("chatFor", () => {
  it("builds the exact prompt from the ticket number, nothing else", () => {
    expect(chatFor(41, "/repo/landrace").prompt).toBe(
      "I want to chat about issue #41 using the landrace MCP, pull it now and show me the latest status and what requires my attention",
    );
  });

  it("builds the Claude desktop app's Code deep link with an encoded prompt and folder", () => {
    const { links, prompt } = chatFor(41, "/repo/landrace");
    expect(links.claude).toBe(
      `claude://code/new?q=${encodeURIComponent(prompt)}&folder=${encodeURIComponent("/repo/landrace")}`,
    );
  });

  it("builds the Claude Code CLI deep link with an encoded cwd and prompt", () => {
    const { links, prompt } = chatFor(41, "/repo/landrace");
    expect(links.claudeCli).toBe(
      `claude-cli://open?cwd=${encodeURIComponent("/repo/landrace")}&q=${encodeURIComponent(prompt)}`,
    );
  });

  it("builds the Cursor deep link with only the prompt — Cursor has no workspace parameter", () => {
    const { links, prompt } = chatFor(41, "/repo/some-other-workspace");
    expect(links.cursor).toBe(`cursor://anysphere.cursor-deeplink/prompt?text=${encodeURIComponent(prompt)}`);
    expect(links.cursor).not.toContain("some-other-workspace");
    expect(links.cursor).not.toContain("path=");
  });

  it("builds the Codex deep link with an encoded prompt and path", () => {
    const { links, prompt } = chatFor(41, "/repo/landrace");
    expect(links.codex).toBe(
      `codex://threads/new?prompt=${encodeURIComponent(prompt)}&path=${encodeURIComponent("/repo/landrace")}`,
    );
  });

  it("encodes a workspace path with a space and a non-ASCII character", () => {
    const workspace = "/Users/me/café project";
    const { links } = chatFor(41, workspace);
    expect(links.claude).toContain(encodeURIComponent(workspace));
    expect(links.claudeCli).toContain(encodeURIComponent(workspace));
    expect(links.codex).toContain(encodeURIComponent(workspace));
    expect(links.claude).not.toContain(" ");
    expect(links.claude).not.toContain("é");
  });

  it("puts only the integer ticket number in the prompt, never a title or note", () => {
    expect(chatFor(7, "/repo/x").prompt).toContain("#7");
    expect(chatFor(7, "/repo/x").prompt).not.toContain("title");
  });

  it("refuses a non-integer ticket rather than embed a fractional one in a URL", () => {
    expect(() => chatFor(7.5, "/repo/x")).toThrow(/integer/);
  });
});
