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

  it("wires exactly the tick button, the theme toggle, the row menu toggle, copy, and the two document-level close listeners — no more, no less", () => {
    // Pins the count deliberately, per row action now being real: the tick
    // button and theme toggle (Task 1) plus, for the Chat/… menu, one
    // toggle-button listener, one Copy-prompt listener, and one document
    // listener each for outside-click and Escape (both defined once, not
    // per row, so re-rendering never multiplies them).
    const listeners = APP_JS.match(/addEventListener/g) ?? [];
    expect(listeners).toHaveLength(6);
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

  it("has no inline event handlers anywhere in the markup", () => {
    expect(PAGE_HTML).not.toMatch(/\son[a-z]+=/i);
  });
});
