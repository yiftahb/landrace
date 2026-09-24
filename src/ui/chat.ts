import type { Chat } from "#namespace.js";

/**
 * The Chat menu's prompt and deep links — the only place any of them is
 * built. `boardView` calls this once per row and the page's own script never
 * concatenates a URL: it only ever assigns one of these straight to `href`.
 * Only the integer ticket number and the workspace path go in — no title,
 * note or other tracker text, so nothing an attacker put in a ticket body
 * can ride along into a link the browser is about to open.
 */
export function chatFor(ticket: number, workspace: string): Chat {
  // A fractional ticket could only come from a caller passing the wrong
  // value in — embedding "7.5" in a deep link a coding agent then acts on is
  // a worse failure than refusing up front.
  if (!Number.isInteger(ticket)) {
    throw new Error(`chatFor: ticket must be an integer, got ${ticket}`);
  }
  const prompt = `I want to chat about issue #${ticket} using the landrace MCP, pull it now and show me the latest status and what requires my attention`;
  const q = encodeURIComponent(prompt);
  const cwd = encodeURIComponent(workspace);
  return {
    prompt,
    links: {
      // The desktop app's Code tab. claude-cli:// below opens a terminal
      // running the CLI instead — a user who expected the app got Terminal.
      claude: `claude://code/new?q=${q}&folder=${cwd}`,
      claudeCli: `claude-cli://open?cwd=${cwd}&q=${q}`,
      // Cursor's deep link takes no workspace parameter — it opens the
      // prompt in whatever window is already active.
      cursor: `cursor://anysphere.cursor-deeplink/prompt?text=${q}`,
      codex: `codex://threads/new?prompt=${q}&path=${cwd}`,
    },
  };
}
