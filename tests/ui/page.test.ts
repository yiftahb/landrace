import { runInNewContext } from "node:vm";
import { APP_CSS, APP_JS, PAGE_HTML, THEME_JS } from "#ui/page.js";

/**
 * One top-level function of the page script, as source. The page has no
 * build step and this suite no DOM, so the script's pure parts are run for
 * real in a bare context rather than asserted on as text.
 */
const fnSource = (name: string): string => {
  const start = APP_JS.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`APP_JS has no top-level function ${name}`);
  const line = APP_JS.slice(start, APP_JS.indexOf("\n", start + 1) + 1);
  // A one-liner ends on its own line; anything else at the first column-0 brace.
  if (line.trimEnd().endsWith("}")) return line;
  return APP_JS.slice(start, APP_JS.indexOf("\n}\n", start) + 3);
};

interface Tree { id: string; title: string; expanded?: boolean; children: Tree[] }
type Search = { self: Set<string>; below: Set<string> } | null;
const node = (id: string, title: string, children: Tree[] = []): Tree => ({ id, title, children });
const TREE = [
  node("12", "Payments revamp", [node("31", "API endpoints", [node("pr:118", "PR #118 API")]), node("32", "UI wiring")]),
  node("40", "Rate limiter", [node("41", "Token bucket")]),
];

describe("the page's lanes", () => {
  it("draws the six lanes in order, the last two collapsible", () => {
    const lanes = [...PAGE_HTML.matchAll(/<(section|details) data-lane="([^"]+)"[\s\S]*?<h2[^>]*>([^<]+)<\/h2>/g)]
      .map((m) => [m[2], m[3], m[1]]);
    expect(lanes).toEqual([
      ["needs-you", "Needs you", "section"], ["running", "Agent running", "section"],
      ["elsewhere", "Held elsewhere", "section"], ["waiting", "Waiting", "section"],
      ["not-admitted", "Not admitted", "details"], ["discharged", "Done", "details"],
    ]);
  });

  // The Chat menu is absolutely positioned inside a row; a clipping card cut
  // it off on the last row.
  it("never clips a lane card, so a row's menu can overflow it", () => {
    const cards = PAGE_HTML.match(/<(section|details) data-lane="[^"]+" class="[^"]*"/g) ?? [];
    expect(cards).toHaveLength(6);
    for (const card of cards) expect(card).not.toContain("overflow-hidden");
  });

  it("gives each lane its own labelled tree and a count", () => {
    expect(PAGE_HTML.match(/<ul role="tree" aria-label="[^"]+"/g)).toHaveLength(6);
    expect(PAGE_HTML.match(/class="lane-count /g)).toHaveLength(6);
  });
});

describe("the filter row", () => {
  const input = /<input id="search" type="search"[^>]*>/.exec(PAGE_HTML)?.[0] ?? "";

  it("sits between the header and the lanes, outside anything a poll redraws", () => {
    const at = PAGE_HTML.indexOf('id="search"');
    expect(at).toBeGreaterThan(PAGE_HTML.indexOf("</header>"));
    expect(at).toBeLessThan(PAGE_HTML.indexOf("data-lane="));
  });

  it("has a search box with an accessible name", () => {
    expect(input).toMatch(/aria-label="Search tickets"/);
    expect(input).toMatch(/placeholder="Search tickets…"/);
  });

  it("has Collapse all and Expand all buttons", () => {
    expect(PAGE_HTML).toMatch(/<button id="collapse-all" type="button" class="[^"]*">Collapse all<\/button>/);
    expect(PAGE_HTML).toMatch(/<button id="expand-all" type="button" class="[^"]*">Expand all<\/button>/);
  });

  // A live region toggled in and out of display is not reliably announced;
  // one that stays put and changes its text is.
  it("says nothing matched through a polite status region that stays in place and changes its text", () => {
    const status = /<p id="no-match"[^>]*>/.exec(PAGE_HTML)?.[0] ?? "";
    expect(status).toMatch(/role="status"/);
    expect(status).toMatch(/aria-live="polite"/);
    expect(status).toMatch(/empty:hidden/);
    expect(status).not.toMatch(/\shidden[\s>]/);
    expect(APP_JS).not.toContain('getElementById("no-match").hidden');
  });
});

describe("the page's search", () => {
  const searchOf = (rows: Tree[], q: string): Search =>
    (runInNewContext(`${fnSource("normalise")}${fnSource("matches")}${fnSource("searchOf")}searchOf`) as (rows: Tree[], q: string) => Search)(rows, q);
  const found = (q: string) => {
    const s = searchOf(TREE, q);
    return s && { self: [...s.self].sort(), below: [...s.below].sort() };
  };

  it("is off while the box is empty or blank", () => {
    expect(searchOf(TREE, "")).toBeNull();
    expect(searchOf(TREE, "   ")).toBeNull();
  });

  it("matches titles ignoring case, and marks every ancestor of a match", () => {
    expect(found("  aPi E")).toEqual({ self: ["31"], below: ["12"] });
  });

  it("matches an id, with or without its #, and artifacts as well as tickets", () => {
    expect(found("#41")).toEqual({ self: ["41"], below: ["40"] });
    expect(found("41")).toEqual({ self: ["41"], below: ["40"] });
    expect(found("pr:118")).toEqual({ self: ["pr:118"], below: ["12", "31"] });
  });

  it("finds nothing for a query nothing matches", () => {
    expect(found("zzz")).toEqual({ self: [], below: [] });
  });
});

describe("the page's expand state", () => {
  it("holds a match's ancestors open during a search without storing it as anyone's choice", () => {
    const run = runInNewContext(`
      const userExpanded = new Map([["12", false]]);
      const touched = new Set();
      ${fnSource("isOpen")}${fnSource("openOf")}
      ({ userExpanded, touched, openOf })`) as {
      userExpanded: Map<string, boolean>; touched: Set<string>; openOf: (row: Tree, search: Search) => boolean;
    };
    const row = { ...node("12", "Payments revamp"), expanded: false };
    const search = { self: new Set(["31"]), below: new Set(["12"]) };
    expect(run.openOf(row, search)).toBe(true);
    expect(run.userExpanded.get("12")).toBe(false);
    // Off the search, the stored choice is back.
    expect(run.openOf(row, null)).toBe(false);
    // A row clicked mid-search answers the click rather than snapping open.
    run.touched.add("12");
    expect(run.openOf(row, search)).toBe(false);
  });

  it("Collapse all / Expand all store a choice for every row that can open, and redraw at once from the last view", () => {
    const run = runInNewContext(`
      const userExpanded = new Map();
      let lastView = { rows: ${JSON.stringify(TREE)} };
      let renders = 0;
      function render(view) { if (view === lastView) renders++; }
      ${fnSource("setAll")}
      ({ userExpanded, setAll, renders: () => renders })`) as {
      userExpanded: Map<string, boolean>; setAll: (open: boolean) => void; renders: () => number;
    };
    run.setAll(false);
    expect([...run.userExpanded].sort()).toEqual([["12", false], ["31", false], ["40", false]]);
    expect(run.renders()).toBe(1);
    run.setAll(true);
    expect([...run.userExpanded].sort()).toEqual([["12", true], ["31", true], ["40", true]]);
  });

  it("wires the search box and both buttons to a redraw", () => {
    expect(APP_JS).toMatch(/getElementById\("collapse-all"\)\.addEventListener\("click", \(\) => setAll\(false\)\)/);
    expect(APP_JS).toMatch(/getElementById\("expand-all"\)\.addEventListener\("click", \(\) => setAll\(true\)\)/);
    expect(APP_JS).toMatch(/searchBox\.addEventListener\("input"/);
    // Read from the box on every render, so a poll redraws the same search.
    expect(APP_JS).toContain("searchOf(view.rows, searchBox.value)");
  });
});

describe("a collapsible lane under a search", () => {
  interface Details { dataset: { lane: string }; open: boolean }
  const load = () => runInNewContext(`
    const laneChoice = new Map();
    const touchedLanes = new Set();
    ${fnSource("chooseLane")}${fnSource("syncDetails")}
    ({ chooseLane, syncDetails })`) as {
    // A person's click on the summary, before the browser flips `open`.
    chooseLane: (lane: Details) => void;
    syncDetails: (lane: Details, holds: boolean, started: boolean, ended: boolean) => void;
  };
  const done = (open: boolean): Details => ({ dataset: { lane: "discharged" }, open });
  const click = (run: ReturnType<typeof load>, lane: Details) => { run.chooseLane(lane); lane.open = !lane.open; };

  it("opens while a search has a match in it, and closes again once the search ends", () => {
    const run = load();
    const lane = done(false);
    run.syncDetails(lane, true, true, false);
    expect(lane.open).toBe(true);
    run.syncDetails(lane, true, false, false);
    expect(lane.open).toBe(true);
    run.syncDetails(lane, false, false, true);
    expect(lane.open).toBe(false);
  });

  it("leaves open a lane the person had open before the search", () => {
    const run = load();
    const lane = done(true);
    run.syncDetails(lane, true, true, false);
    run.syncDetails(lane, false, false, true);
    expect(lane.open).toBe(true);
  });

  it("answers a person's toggle mid-search, and keeps the last state they gave it once the search ends", () => {
    const run = load();
    const lane = done(false);
    run.syncDetails(lane, true, true, false);
    click(run, lane);
    run.syncDetails(lane, true, false, false);
    expect(lane.open).toBe(false);
    click(run, lane);
    run.syncDetails(lane, true, false, false);
    run.syncDetails(lane, false, false, true);
    expect(lane.open).toBe(true);
  });

  it("never touches a lane while there is no search", () => {
    const run = load();
    const open = done(true);
    const shut = done(false);
    click(run, shut);
    shut.open = false;
    run.syncDetails(open, false, false, false);
    run.syncDetails(shut, false, false, false);
    expect([open.open, shut.open]).toEqual([true, false]);
  });

  it("wires each collapsible lane's summary to chooseLane, and forgets mid-search toggles when the query changes", () => {
    expect(APP_JS).toMatch(/querySelector\("summary"\)\.addEventListener\("click", \(\) => chooseLane\(lane\)\)/);
    expect(APP_JS).toMatch(/searchBox\.addEventListener\("input", \(\) => \{ onQuery\(searchBox\.value\);/);
  });
});

describe("a change of query", () => {
  it("forgets mid-search clicks only when the query itself changes, not on a keystroke that leaves it the same", () => {
    const run = runInNewContext(`
      const touched = new Set(["12"]);
      const touchedLanes = new Set(["discharged"]);
      let lastQuery = "";
      ${fnSource("normalise")}${fnSource("onQuery")}
      ({ touched, touchedLanes, onQuery })`) as { touched: Set<string>; touchedLanes: Set<string>; onQuery: (v: string) => void };
    const held = () => [[...run.touched], [...run.touchedLanes]];
    run.onQuery("api");
    expect(held()).toEqual([[], []]);
    run.touched.add("12");
    run.touchedLanes.add("discharged");
    run.onQuery("  API ");
    expect(held()).toEqual([["12"], ["discharged"]]);
    run.onQuery("api e");
    expect(held()).toEqual([[], []]);
  });
});

describe("the tree walk", () => {
  // The row builders stubbed to "<depth>:<id>", "+" when drawn open.
  const walk = (query: string, expanded: Record<string, boolean> = {}): string[] => [...(runInNewContext(`
    const userExpanded = new Map(${JSON.stringify(Object.entries(expanded))});
    const touched = new Set();
    function ticketRowFor(row, depth, now, open) { return depth + ":" + row.id + (open ? "+" : ""); }
    function artifactRowFor(row, depth, open) { return depth + ":" + row.id + (open ? "+" : ""); }
    ${["isOpen", "openOf", "shows", "normalise", "matches", "searchOf", "treeRows"].map(fnSource).join("")}
    treeRows(ROWS, 0, new Set(), 0, [], searchOf(ROWS, ${JSON.stringify(query)}), false)`, { ROWS: TREE }) as string[])];

  it("draws every root, and a row's children only while it is open, with no query", () => {
    expect(walk("")).toEqual(["0:12", "0:40"]);
    expect(walk("", { 12: true })).toEqual(["0:12+", "1:31", "1:32", "0:40"]);
  });

  it("holds a match's ancestors open and hides everything that neither matches nor leads to a match", () => {
    expect(walk("api e")).toEqual(["0:12+", "1:31"]);
  });

  it("holds the path open even against a stored collapse, without changing it", () => {
    expect(walk("token", { 40: false })).toEqual(["0:40+", "1:41"]);
  });

  it("draws a matched row's own subtree whole once it is open, matching or not", () => {
    expect(walk("api e", { 31: true })).toEqual(["0:12+", "1:31+", "2:pr:118"]);
    expect(walk("payments", { 12: true })).toEqual(["0:12+", "1:31", "1:32"]);
  });
});

describe("a system's mark in dark mode", () => {
  const faintOnDark = (hex: string): boolean =>
    (runInNewContext(`${fnSource("luminance")}${fnSource("faintOnDark")}faintOnDark`) as (h: string) => boolean)(hex);

  it("finds the marks too dark to see on the dark card — GitHub, Notion, Cursor, Jira", () => {
    expect(["#24292f", "#191919", "#18181b", "#0052cc"].map(faintOnDark)).toEqual([true, true, true, true]);
  });

  it("leaves the marks that already read on it alone", () => {
    expect(["#fc6d26", "#D97757", "#10a37f", "#4285f4", "#1868db", "#ffffff"].map(faintOnDark))
      .toEqual([false, false, false, false, false, false]);
  });

  it("draws every mark — system and chat target alike — on the one square that knows to ring itself", () => {
    expect(fnSource("systemIcon")).toContain("markSvg(icon.bg)");
    expect(fnSource("chatIcon")).toContain("markSvg(bg)");
    expect(fnSource("markSvg")).toMatch(/if \(faintOnDark\(bg\)\) svg\.classList\.add\("dark:ring-1", "dark:ring-neutral-500"\)/);
  });

  it("ships the ring as dark-only CSS, so switching theme needs no redraw", () => {
    expect(APP_CSS).toMatch(/\.dark\\:ring-1:where\(\.dark, ?\.dark \*\)/);
    expect(APP_CSS).toMatch(/\.dark\\:ring-neutral-500:where\(\.dark, ?\.dark \*\)/);
  });
});

describe("a row's title line", () => {
  it("names the system only on artifact rows — a ticket row carries no mark and no system name", () => {
    expect(fnSource("ticketRowFor")).not.toContain("systemLabel(");
    expect(fnSource("artifactRowFor")).toContain("systemLabel(row)");
  });

  it("shows a ticket's priority only when it has one, never a placeholder", () => {
    expect(APP_JS).toMatch(/if \(typeof row\.priority === "number"\)/);
    expect(APP_JS).not.toContain('"–"');
  });

  it("reserves no toggle-sized gap on a row with nothing to open", () => {
    expect(APP_JS).not.toContain('el("span", "inline-block h-4 w-4 shrink-0")');
  });

  // The toggle used to sit inside the title line, so a parent row's note
  // started under the toggle, a column left of its number.
  it("gives a parent row's toggle its own column, so the number, the note and wrapped chips share one edge", () => {
    const src = fnSource("ticketRowFor");
    expect(src).not.toMatch(/top\.append\(toggleFor/);
    expect(src).toMatch(/if \(row\.children\.length\) main\.append\(toggleFor\(row, open\)\);/);
    expect(src).toMatch(/body\.append\(top, bottom\);\s*main\.append\(body\);/);
  });

  it("indents one toggle-and-gap per level, so a child's toggle sits under its parent's number", () => {
    expect(APP_JS).toContain('const INDENT = ["pl-4", "pl-10", "pl-16", "pl-22", "pl-28"];');
  });
});

describe("the page", () => {
  it("loads its script and style from the server, never inline, so CSP can forbid inline", () => {
    expect(PAGE_HTML).toContain('<script src="/app.js" defer></script>');
    expect(PAGE_HTML).toContain('<link rel="stylesheet" href="/app.css">');
    expect(PAGE_HTML).not.toMatch(/<script>(?!<\/script>)/);
    expect(PAGE_HTML).not.toMatch(/<style/);
    expect(PAGE_HTML).not.toMatch(/\son[a-z]+=/i);
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

  it("shows a quiet empty state, through textContent, when there is nothing to show", () => {
    expect(APP_JS).toContain('"None"');
  });

  it("renders a Chat action on needs-you rows and an inert one everywhere else", () => {
    expect(APP_JS).toContain('row.badge === "needs-you"');
    expect(APP_JS).toContain("Chat ▾");
  });

  it("wires exactly the tick button, the theme toggle, the search box, Collapse all, Expand all, the collapsible lanes' summaries, the row expand toggle, the row menu toggle, the four links, copy, and the two document-level close listeners — no more, no less", () => {
    // Pins the count deliberately: the tick button and theme toggle, the
    // search box and the two expand-all buttons (each wired once, outside
    // anything a render rebuilds), the collapsible lanes' summary clicks
    // (defined once, in a loop over the two), the expand/collapse toggle
    // (defined once, in toggleFor, not once per row), and for the Chat/… menu
    // one toggle-button listener, one close-on-choose listener (defined once
    // inside the per-target loop), one Copy-prompt listener, and one document
    // listener each for outside-click and Escape (both defined once, so
    // re-rendering never multiplies them).
    const listeners = APP_JS.match(/addEventListener/g) ?? [];
    expect(listeners).toHaveLength(12);
  });

  it("opens the same menu — Claude Code, Claude Code (CLI), Cursor, Codex, a divider, Copy prompt — from either action button", () => {
    expect(APP_JS).toContain('"Claude Code"');
    expect(APP_JS).toContain('"Claude Code (CLI)"');
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
    expect(APP_JS).not.toMatch(/claude-cli:|claude:\/\/code|cursor:\/\/anysphere|codex:\/\/threads/);
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

  it("keys every trigger and its menu by node id (data-key), so the live element is always one lookup away", () => {
    expect(APP_JS).toMatch(/function triggerKeyOf\(id\)/);
    expect(APP_JS).toMatch(/function menuKeyOf\(id\)/);
    expect(APP_JS).toContain('"data-key", triggerKeyOf(row.id)');
    expect(APP_JS).toContain('"data-key", menuKeyOf(row.id)');
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

  it("keys every menu item too (<id>:claude/cursor/codex/copy), so render()'s restore-by-key covers a keyboard user inside the menu", () => {
    expect(APP_JS).toContain('"data-key", row.id + ":" + target.key');
    expect(APP_JS).toContain('"data-key", row.id + ":copy"');
  });

  it("walks the tree with a seen-set, so a malformed graph can never hang the page", () => {
    expect(APP_JS).toMatch(/if \(seen\.has\(row\.id\)\) continue;/);
    expect(APP_JS).toContain("seen.add(row.id)");
  });

  it("lets a person's own expand/collapse beat the server's, across every poll", () => {
    expect(APP_JS).toContain("const userExpanded = new Map();");
    expect(APP_JS).toMatch(/userExpanded\.has\(row\.id\) \? userExpanded\.get\(row\.id\) : row\.expanded/);
  });

  it("opens every external link in a new tab without handing it window.opener", () => {
    const blanks = APP_JS.match(/\.target = "_blank";/g) ?? [];
    const safe = APP_JS.match(/\.rel = "noopener noreferrer";/g) ?? [];
    expect(blanks.length).toBeGreaterThan(0);
    expect(safe.length).toBe(blanks.length);
  });

  it("draws a system's mark as an SVG letter from row.system.icon, never an image", () => {
    expect(APP_JS).toContain("function systemIcon(");
    expect(APP_JS).toContain("row.system.icon");
    expect(APP_JS).not.toMatch(/createElement\("img"\)|\.src\s*=/);
  });

  it("keys every external link (<id>:link), so a keyboard user on one keeps their place across a poll", () => {
    expect(APP_JS).toContain('"data-key", row.id + ":link"');
  });

  it("redraws a toggle from the last view at once, not after a network round trip that may fail", () => {
    expect(APP_JS).toContain("lastView = view;");
    // `open` is what the row is drawn as — a search may be holding it open —
    // so a click always flips what the person sees.
    expect(APP_JS).toMatch(/userExpanded\.set\(row\.id, !open\);\s*touched\.add\(row\.id\);\s*render\(lastView\);/);
  });

  it("greys a dropped node", () => {
    expect(APP_JS).toContain('row.closed === "dropped"');
  });

  it("has no inline event handlers anywhere in the markup", () => {
    expect(PAGE_HTML).not.toMatch(/\son[a-z]+=/i);
  });
});
