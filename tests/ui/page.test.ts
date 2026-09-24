import { APP_CSS, APP_JS, PAGE_HTML, THEME_JS } from "#ui/page.js";

describe("the page", () => {
  it("loads its script and style from the server, never inline, so CSP can forbid inline", () => {
    expect(PAGE_HTML).toContain('<script src="/app.js" defer></script>');
    expect(PAGE_HTML).toContain('<link rel="stylesheet" href="/app.css">');
    expect(PAGE_HTML).not.toMatch(/<script>(?!<\/script>)/);
    expect(PAGE_HTML).not.toMatch(/<style/);
    expect(PAGE_HTML).not.toMatch(/\son[a-z]+=/i);
  });

  it("declares a section for every lane, in display order", () => {
    const order = ["needs-you", "running", "elsewhere", "waiting", "not-admitted", "discharged"];
    const positions = order.map((lane) => PAGE_HTML.indexOf(`data-lane="${lane}"`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("collapses not-admitted and discharged", () => {
    expect(PAGE_HTML).toMatch(/<details[^>]*data-lane="not-admitted"/);
    expect(PAGE_HTML).toMatch(/<details[^>]*data-lane="discharged"/);
  });

  // The Chat menu is absolutely positioned inside a lane; a clipping lane cut
  // it off on the last row.
  it("never clips a lane's contents, so a row's menu can overflow the card", () => {
    const lanes = PAGE_HTML.match(/<(section|details) data-lane="[^"]+" class="[^"]*"/g) ?? [];
    expect(lanes).toHaveLength(6);
    for (const lane of lanes) expect(lane).not.toContain("overflow-hidden");
  });

  it("never parses a string as HTML", () => {
    for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"]) {
      expect(APP_JS).not.toContain(sink);
    }
  });

  it("polls the board and sets an href only from the server's already-checked url", () => {
    expect(APP_JS).toContain('fetch("/board.json"');
    expect(APP_JS).toContain("textContent");
  });

  it("has some style", () => {
    expect(APP_CSS.length).toBeGreaterThan(0);
  });

  it("puts the countdown and the tick button in the header, top right", () => {
    const header = /<header[^>]*>[\s\S]*?<\/header>/.exec(PAGE_HTML)?.[0] ?? "";
    expect(header).toContain('id="next"');
    expect(header).toMatch(/id="tick" type="button" class="[^"]*">Run next tick now<\/button>/);
    // "top right": the header's content is wrapped in a max-width container
    // (same one <main> uses) laid out with `justify-between` — branding on
    // the left, schedule + theme toggle on the right — see the CSS assertion
    // below. The <header> tag itself stays full-width for its border/background.
    expect(header).toMatch(/<header[^>]*>\s*<div class="[^"]*max-w-5xl[^"]*justify-between/);
  });

  it("attaches the tick button's listener in script, never as an inline handler", () => {
    expect(PAGE_HTML).not.toMatch(/\son[a-z]+=/i);
    expect(APP_JS).toContain('getElementById("tick")');
    expect(APP_JS).toContain("addEventListener");
  });

  it("posts /tick with the required custom header", () => {
    expect(APP_JS).toContain('fetch("/tick"');
    expect(APP_JS).toContain('"x-landrace-action": "tick"');
    expect(APP_JS).toMatch(/method:\s*"POST"/);
  });

  it("lays the header group out to the right", () => {
    expect(APP_CSS).toMatch(/justify-content:\s*space-between/);
  });

  it("loads /theme.js before /app.js, and without defer, so there is no flash of the wrong theme", () => {
    expect(PAGE_HTML).toContain('<script src="/theme.js"></script>');
    expect(PAGE_HTML.indexOf('<script src="/theme.js"></script>'))
      .toBeLessThan(PAGE_HTML.indexOf('<script src="/app.js" defer></script>'));
  });

  it("has a theme toggle in the header", () => {
    const header = /<header[^>]*>[\s\S]*?<\/header>/.exec(PAGE_HTML)?.[0] ?? "";
    expect(header).toContain('id="theme-toggle"');
    expect(header).toMatch(/aria-label="Switch to (dark|light) mode"/);
  });

  it("reads the stored theme, else the OS preference, and sets the class before paint — every localStorage access guarded", () => {
    expect(THEME_JS).toContain("localStorage.getItem(");
    expect(THEME_JS).toContain("prefers-color-scheme: dark");
    expect(THEME_JS).toContain("classList.toggle(\"dark\"");
    expect(THEME_JS).toMatch(/try\s*{[^}]*localStorage[^}]*}\s*catch/s);
  });

  it("never parses a string as HTML in the theme script either", () => {
    for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"]) {
      expect(THEME_JS).not.toContain(sink);
    }
  });

  it("wires the toggle in script, persists the choice, and guards every localStorage write", () => {
    expect(APP_JS).toContain('getElementById("theme-toggle")');
    expect(APP_JS).toContain("classList.toggle(\"dark\"");
    expect(APP_JS).toMatch(/try\s*{[^}]*localStorage\.setItem[^}]*}\s*catch/s);
  });

  it("has a folder chip in the header, set from the board view", () => {
    const header = /<header[^>]*>[\s\S]*?<\/header>/.exec(PAGE_HTML)?.[0] ?? "";
    expect(header).toContain('id="folder"');
    expect(APP_JS).toContain('getElementById("folder").textContent = view.folder');
  });

  it("shows a quiet empty state, through textContent, when a lane has no rows", () => {
    expect(APP_JS).toContain('"None"');
  });

  it("renders a Chat action on needs-you rows and an inert one everywhere else", () => {
    expect(APP_JS).toContain('row.lane === "needs-you"');
    expect(APP_JS).toContain("Chat ▾");
  });

  it("wires exactly the tick button, the theme toggle, the row menu toggle, the three links, copy, and the two document-level close listeners — no more, no less", () => {
    // Pins the count deliberately: the tick button and theme toggle (Task 1)
    // plus, for the Chat/… menu, one toggle-button listener, one
    // close-on-choose listener (defined once inside the per-target loop,
    // not once per row), one Copy-prompt listener, and one document listener
    // each for outside-click and Escape (both defined once, not per row, so
    // re-rendering never multiplies them).
    const listeners = APP_JS.match(/addEventListener/g) ?? [];
    expect(listeners).toHaveLength(7);
  });

  it("opens the same menu — Claude Code, Cursor, Codex, a divider, Copy prompt — from either action button", () => {
    expect(APP_JS).toContain("Claude Code");
    expect(APP_JS).toContain("Cursor");
    expect(APP_JS).toContain("Codex");
    expect(APP_JS).toContain("Copy prompt");
    expect(APP_JS).toMatch(/el\("hr"/);
  });

  it("gives the menu proper ARIA: haspopup/expanded on the trigger, menu/menuitem on the popup", () => {
    expect(APP_JS).toContain('"aria-haspopup", "menu"');
    expect(APP_JS).toContain('"aria-expanded"');
    expect(APP_JS).toContain('"role", "menu"');
    expect(APP_JS).toContain('"role", "menuitem"');
  });

  it("sets each link's href straight from row.chat.links, and never concatenates a URL itself", () => {
    expect(APP_JS).toMatch(/row\.chat\.links\[[^\]]+\]/);
    expect(APP_JS).not.toMatch(/claude-cli:|cursor:\/\/anysphere|codex:\/\/threads/);
  });

  it("copies row.chat.prompt to the clipboard, reporting Copied or Copy failed", () => {
    expect(APP_JS).toContain("navigator.clipboard");
    expect(APP_JS).toContain("row.chat.prompt");
    expect(APP_JS).toContain("Copied");
    expect(APP_JS).toContain("Copy failed");
  });

  it("closes the menu on Escape and on an outside click, via two listeners defined once (not per row)", () => {
    expect(APP_JS).toMatch(/document\.addEventListener\(\s*"keydown"/);
    expect(APP_JS).toMatch(/document\.addEventListener\(\s*"click"/);
    expect(APP_JS).toContain('"Escape"');
  });

  it("returns focus to the trigger only when Escape closes the menu, never on an outside click", () => {
    expect(APP_JS).toMatch(/closeMenu\(\{\s*returnFocus:\s*true\s*\}\)/);
    // The outside-click handler calls the no-args form.
    expect(APP_JS).toMatch(/if \(!inside\) \{ closeMenu\(\); return; \}/);
    expect(APP_JS).toContain("trigger.focus()");
  });

  it("closes the menu when a Claude/Cursor/Codex link is chosen, so a menu never outlives a handoff to another app", () => {
    expect(APP_JS).toMatch(/a\.addEventListener\(\s*"click",\s*\(\)\s*=>\s*closeMenu\(\)\s*\)/);
  });

  it("makes the Copy prompt feedback an aria-live region, so a screen reader announces Copied/Copy failed", () => {
    expect(APP_JS).toContain('"aria-live", "polite"');
  });

  it("tracks the open menu by ticket, never by an element reference, so a render() in between can't leave it stale", () => {
    expect(APP_JS).toContain("let openMenuKey = null;");
    expect(APP_JS).not.toContain("pendingView");
    // No stashed view: pollOnce() renders unconditionally now.
    expect(APP_JS).toMatch(/render\(await res\.json\(\)\)/);
  });

  it("keys every trigger and its menu by ticket (data-key), so the live element is always one lookup away", () => {
    expect(APP_JS).toMatch(/function triggerKeyOf\(ticket\)/);
    expect(APP_JS).toMatch(/function menuKeyOf\(ticket\)/);
    expect(APP_JS).toContain('"data-key", triggerKeyOf(row.ticket)');
    expect(APP_JS).toContain('"data-key", menuKeyOf(row.ticket)');
    expect(APP_JS).toMatch(/document\.querySelector\(/);
  });

  it("render() restores the open menu and the focused control by key, after rebuilding every row", () => {
    // Captured before the rebuild...
    expect(APP_JS).toMatch(/document\.activeElement/);
    expect(APP_JS).toContain("getAttribute(\"data-key\")");
    // ...and re-applied after it, by a fresh lookup, never a stale reference.
    expect(APP_JS).toMatch(/if \(wasOpen !== null\)/);
    expect(APP_JS).toMatch(/if \(activeKey\)/);
  });

  it("closes an idle menu after 20s so one is never left open forever, without depending on it for the poll fix", () => {
    expect(APP_JS).toContain("const IDLE_MS = 20000;");
    expect(APP_JS).toMatch(/setTimeout\(\(\)\s*=>\s*closeMenu\(\),\s*IDLE_MS\)/);
  });

  it("keys every menu item too (<ticket>:claude/cursor/codex/copy), so render()'s existing restore-by-key also covers a keyboard user focused inside the menu", () => {
    expect(APP_JS).toContain('"data-key", row.ticket + ":" + target.key');
    expect(APP_JS).toContain('"data-key", row.ticket + ":copy"');
  });

  it("has no inline event handlers anywhere in the markup", () => {
    expect(PAGE_HTML).not.toMatch(/\son[a-z]+=/i);
  });
});
