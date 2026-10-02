import { runInNewContext, Script } from "node:vm";
import { APP_CSS, APP_JS, PAGE_HTML, THEME_JS } from "#ui/page.js";

/**
 * One top-level function of the page script, as source. The page has no
 * build step and this suite no DOM, so the script's pure parts are run for
 * real in a bare context rather than asserted on as text.
 */
const fnSource = (name: string): string => {
  const plain = APP_JS.indexOf(`\nfunction ${name}(`);
  const start = plain >= 0 ? plain : APP_JS.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`APP_JS has no top-level function ${name}`);
  const line = APP_JS.slice(start, APP_JS.indexOf("\n", start + 1) + 1);
  // A one-liner ends on its own line; anything else at the first column-0 brace.
  if (line.trimEnd().endsWith("}")) return line;
  return APP_JS.slice(start, APP_JS.indexOf("\n}\n", start) + 3);
};

/** A one-line top-level `const` of the page script, as source. */
const constSource = (name: string): string => {
  const start = APP_JS.indexOf(`\nconst ${name} = `);
  if (start < 0) throw new Error(`APP_JS has no top-level const ${name}`);
  return APP_JS.slice(start, APP_JS.indexOf("\n", start + 1) + 1);
};

/**
 * Just enough of a DOM for one row builder to run against: elements that keep
 * their classes, attributes, properties, own text and children, so a test can
 * read back exactly what the page would put on screen.
 */
class FakeElement {
  className = "";
  text = "";
  children: FakeElement[] = [];
  attrs = new Map<string, string>();
  href?: string; target?: string; rel?: string; title?: string; type?: string;
  constructor(readonly tag: string) {}
  readonly classList = { add: (...cls: string[]) => { this.className = [this.className, ...cls].filter(Boolean).join(" "); } };
  set textContent(v: string) { this.text = v; this.children = []; }
  get textContent(): string { return this.text + this.children.map((c) => c.textContent).join(""); }
  setAttribute(k: string, v: string): void { this.attrs.set(k, String(v)); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  append(...nodes: FakeElement[]): void { this.children.push(...nodes); }
  addEventListener(): void {}
}
const fakeDocument = {
  createElement: (tag: string) => new FakeElement(tag),
  createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
};
const descendants = (e: FakeElement): FakeElement[] => [e, ...e.children.flatMap(descendants)];

interface Tree { id: string; title: string; children: Tree[] }
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
    expect(input).toMatch(/aria-label="Search items"/);
    expect(input).toMatch(/placeholder="Search items…"/);
  });

  // Two buttons side by side, one of which always did nothing: the tree was
  // already all open, or already all shut.
  it("has one Collapse all / Expand all button, reading Collapse all over a tree that starts open", () => {
    const filters = /<div id="filters"[\s\S]*?\n<\/div>\n/.exec(PAGE_HTML)?.[0] ?? "";
    expect(filters).toMatch(/<button id="toggle-all" type="button" aria-keyshortcuts="c" title="Collapse all \(c\)" class="[^"]*">Collapse all<\/button>/);
    expect(PAGE_HTML).not.toMatch(/id="(collapse|expand)-all"/);
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

  describe("the Refresh button, immediately right of Collapse all / Expand all", () => {
    it("sits right after toggle-all, with nothing but whitespace between them", () => {
      const toggleAt = PAGE_HTML.indexOf('<button id="toggle-all"');
      const refreshAt = PAGE_HTML.indexOf('<button id="refresh"');
      expect(toggleAt).toBeGreaterThan(-1);
      expect(refreshAt).toBeGreaterThan(toggleAt);
      const toggleCloseAt = PAGE_HTML.indexOf("</button>", toggleAt) + "</button>".length;
      expect(PAGE_HTML.slice(toggleCloseAt, refreshAt).trim()).toBe("");
    });

    it("is icon-only, named for a screen reader, and titled with what it does", () => {
      const button = /<button id="refresh"[\s\S]*?<\/button>/.exec(PAGE_HTML)?.[0] ?? "";
      expect(button).toMatch(/aria-label="Refresh"/);
      expect(button).toMatch(/title="Re-read the tracker"/);
      expect(button).toMatch(/type="button"/);
      // No text label: the icon alone, drawn inline — the page's CSP loads no images.
      expect(button.replace(/<[^>]+>/g, "").trim()).toBe("");
      expect(button).toContain("<svg");
      expect(button).not.toContain("<img");
    });

    it("looks disabled while disabled: dimmed, with a not-allowed cursor", () => {
      const button = /<button id="refresh"[^>]*class="([^"]*)"/.exec(PAGE_HTML)?.[1] ?? "";
      expect(button.split(" ")).toEqual(expect.arrayContaining(["disabled:opacity-50", "disabled:cursor-not-allowed"]));
    });

    it("shares the icon-button styling family the theme toggle already uses", () => {
      const button = /<button id="refresh"[^>]*class="([^"]*)"/.exec(PAGE_HTML)?.[1] ?? "";
      const themeToggle = /<button id="theme-toggle"[^>]*class="([^"]*)"/.exec(PAGE_HTML)?.[1] ?? "";
      expect(button).toBe(themeToggle);
    });
  });
});

describe("the Refresh button's behaviour", () => {
  it("posts /refresh with the required custom header", () => {
    expect(APP_JS).toContain('fetch("/refresh"');
    expect(APP_JS).toContain('"x-landrace-action": "refresh"');
    expect(APP_JS).toMatch(/method:\s*"POST"/);
  });

  it("wires its click listener in script, never as an inline handler", () => {
    expect(APP_JS).toContain('getElementById("refresh")');
    expect(PAGE_HTML).not.toMatch(/\son[a-z]+=/i);
  });

  describe("what it says once the server answers", () => {
    const answer = (status: number) => {
      const seen = { button: [] as Array<[string, string, boolean, boolean]>, restores: 0, polls: 0 };
      runInNewContext(`${fnSource("refreshAnswered")} refreshAnswered(STATUS);`, {
        STATUS: status, REFRESH_LABEL: "Refresh", REFRESH_TITLE: "Re-read the tracker",
        setRefreshButton: (label: string, title: string, disabled: boolean, busy: boolean) => seen.button.push([label, title, disabled, busy]),
        restoreRefreshAfter: () => { seen.restores += 1; },
        schedulePoll: () => { seen.polls += 1; },
      });
      return seen;
    };

    it("is itself again, and re-polls at once, on success", () => {
      expect(answer(200)).toEqual({ button: [["Refresh", "Re-read the tracker", false, false]], restores: 0, polls: 1 });
    });

    it("says failed, briefly, on anything else", () => {
      expect(answer(502)).toEqual({ button: [["failed", "failed", true, false]], restores: 1, polls: 0 });
    });
  });

  // A refresh is a tracker round trip — seconds on a slow link — and a still
  // button reads as a click that never landed.
  describe("while a refresh is in flight", () => {
    const toggles = () => {
      const on = new Set<string>();
      return { on, classList: { toggle: (c: string, force: boolean) => { if (force) on.add(c); else on.delete(c); } } };
    };
    const draw = (busy: boolean) => {
      const svg = toggles();
      const button = { ...toggles(), attrs: new Map<string, string>(), title: "", disabled: false,
        setAttribute(k: string, v: string) { this.attrs.set(k, v); }, querySelector: () => svg };
      runInNewContext(`${fnSource("setRefreshButton")} setRefreshButton("L", "T", BUSY, BUSY);`, { refreshButton: button, BUSY: busy });
      return { button, svg };
    };

    it("spins the icon, pulses the button, and disables it", () => {
      const { button, svg } = draw(true);
      expect(button.disabled).toBe(true);
      expect(svg.on.has("animate-spin")).toBe(true);
      expect(button.on.has("animate-pulse")).toBe(true);
      expect(button.attrs.get("aria-busy")).toBe("true");
    });

    it("stops both once it is not", () => {
      const { button, svg } = draw(false);
      expect(svg.on.has("animate-spin")).toBe(false);
      expect(button.on.has("animate-pulse")).toBe(false);
      expect(button.attrs.get("aria-busy")).toBe("false");
    });

    it("is what a click starts", () => {
      expect(APP_JS).toContain('setRefreshButton("Refreshing…", "Refreshing…", true, true);');
    });
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

  it("matches an id, with or without its #, and artifacts as well as items", () => {
    expect(found("#41")).toEqual({ self: ["41"], below: ["40"] });
    expect(found("41")).toEqual({ self: ["41"], below: ["40"] });
    expect(found("pr:118")).toEqual({ self: ["pr:118"], below: ["12", "31"] });
  });

  it("finds nothing for a query nothing matches", () => {
    expect(found("zzz")).toEqual({ self: [], below: [] });
  });
});

describe("the page's expand state", () => {
  const isOpen = (stored: [string, boolean][], row: Tree): boolean =>
    (runInNewContext(`const userExpanded = new Map(${JSON.stringify(stored)});${fnSource("isOpen")}isOpen`) as (r: Tree) => boolean)(row);

  // Everything starts open: the board is read top to bottom, and a branch that
  // arrives shut hides the very item someone came to look at.
  it("opens every row until the person closes it, whatever the row itself carries", () => {
    const row = { ...node("12", "Payments revamp", [node("31", "API endpoints")]), expanded: false };
    expect(isOpen([], row)).toBe(true);
    expect(isOpen([["12", false]], row)).toBe(false);
    expect(isOpen([["12", true]], row)).toBe(true);
    // Another row's choice is not this one's.
    expect(isOpen([["40", false]], row)).toBe(true);
  });

  it("holds a match's ancestors open during a search without storing it as anyone's choice", () => {
    const run = runInNewContext(`
      const userExpanded = new Map([["12", false]]);
      const touched = new Set();
      ${fnSource("isOpen")}${fnSource("openOf")}
      ({ userExpanded, touched, openOf })`) as {
      userExpanded: Map<string, boolean>; touched: Set<string>; openOf: (row: Tree, search: Search) => boolean;
    };
    const row = node("12", "Payments revamp");
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

  it("wires the search box and the one button to a redraw", () => {
    expect(APP_JS).toContain('const toggleAll = document.getElementById("toggle-all");');
    expect(APP_JS).toMatch(/searchBox\.addEventListener\("input"/);
    // Read from the box on every render, so a poll redraws the same search.
    expect(APP_JS).toContain("searchOf(view.rows, searchBox.value)");
  });
});

describe("the one Collapse all / Expand all button", () => {
  // The click handler as the page wires it, run for real below.
  const listener = /\ntoggleAll\.addEventListener\("click", .*\n/.exec(APP_JS)?.[0] ?? "";
  // render()'s tree-and-label half, stubbed down to exactly the calls the
  // real render() makes (pinned in the last test here); rows drawn as
  // "<depth>:<id>", "+" when open.
  const load = (rows: Tree[] = TREE) => runInNewContext(`
    const userExpanded = new Map();
    const touched = new Set();
    let lastView = { rows: ROWS };
    let query = "";
    let drawn = [];
    const toggleAll = { textContent: "Collapse all", clicks: [], addEventListener(type, f) { if (type === "click") this.clicks.push(f); } };
    let collapsesAll = true;
    function itemRowFor(row, depth, now, open) { return depth + ":" + row.id + (open ? "+" : ""); }
    function artifactRowFor(row, depth, open) { return depth + ":" + row.id + (open ? "+" : ""); }
    function render(view) {
      lastView = view;
      const search = searchOf(view.rows, query);
      const seen = new Set();
      drawn = treeRows(view.rows, 0, seen, 0, [], search, false);
      labelToggleAll(anyOpen(view.rows, seen));
    }
    ${["isOpen", "openOf", "shows", "normalise", "matches", "searchOf", "treeRows", "anyOpen", "labelToggleAll", "setAll"].map(fnSource).join("")}
    ${listener}
    render(lastView);
    ({
      label: () => toggleAll.textContent,
      drawn: () => drawn,
      stored: () => [...userExpanded].sort(),
      click: () => { for (const f of toggleAll.clicks) f(); },
      close: (id) => { userExpanded.set(id, false); touched.add(id); render(lastView); },
      search: (q) => { query = q; touched.clear(); render(lastView); },
      listeners: () => toggleAll.clicks.length,
    })`, { ROWS: rows }) as {
    label: () => string; drawn: () => string[]; stored: () => [string, boolean][]; click: () => void;
    close: (id: string) => void; search: (q: string) => void; listeners: () => number;
  };
  const ALL_OPEN = ["0:12+", "1:31+", "2:pr:118", "1:32", "0:40+", "1:41"];

  it("reads Collapse all over the tree as it first draws, and collapses every row that can open", () => {
    const run = load();
    expect(run.listeners()).toBe(1);
    expect(run.drawn()).toEqual(ALL_OPEN);
    expect(run.label()).toBe("Collapse all");
    run.click();
    expect(run.drawn()).toEqual(["0:12", "0:40"]);
    expect(run.stored()).toEqual([["12", false], ["31", false], ["40", false]]);
    expect(run.label()).toBe("Expand all");
  });

  it("then reads Expand all, and a second click opens every row again", () => {
    const run = load();
    run.click();
    run.click();
    expect(run.drawn()).toEqual(ALL_OPEN);
    expect(run.label()).toBe("Collapse all");
  });

  it("reads Collapse all while any row on screen is open, and Expand all once none is — hidden rows' state aside", () => {
    const run = load();
    run.close("12");
    expect(run.label()).toBe("Collapse all");
    run.close("40");
    // #31 is still open, out of sight under #12: a Collapse all would do nothing you could see.
    expect(run.drawn()).toEqual(["0:12", "0:40"]);
    expect(run.label()).toBe("Expand all");
    run.click();
    expect(run.drawn()).toEqual(ALL_OPEN);
  });

  it("counts only the rows a search leaves on screen", () => {
    const run = load();
    run.close("40");
    // #12 and #31 are open, but the search hides them; #40, held open for #41, is shut by choice.
    run.search("token");
    expect(run.drawn()).toEqual(["0:40+", "1:41"]);
    expect(run.label()).toBe("Expand all");
  });

  // Hiding what someone just searched for is never what Collapse all meant,
  // so a held path stays open — and the label still answers every click.
  it("reads a row a search holds open by the person's choice, so every click flips the label", () => {
    const run = load();
    run.search("token");
    expect(run.drawn()).toEqual(["0:40+", "1:41"]);
    expect(run.label()).toBe("Collapse all");
    run.click();
    expect(run.drawn()).toEqual(["0:40+", "1:41"]);
    expect(run.stored()).toEqual([["12", false], ["31", false], ["40", false]]);
    expect(run.label()).toBe("Expand all");
    run.click();
    expect(run.label()).toBe("Collapse all");
    run.search("api e");
    expect(run.drawn()).toEqual(["0:12+", "1:31+", "2:pr:118"]);
    run.click();
    expect(run.drawn()).toEqual(["0:12+", "1:31"]);
    expect(run.label()).toBe("Expand all");
  });

  it("reads Expand all over a board where nothing can open", () => {
    expect(load([node("1", "a"), node("2", "b")]).label()).toBe("Expand all");
  });

  it("is relabelled by the real render(), from the rows it has just drawn", () => {
    expect(fnSource("render")).toContain("labelToggleAll(anyOpen(view.rows, seen));");
    expect(listener).toBe('\ntoggleAll.addEventListener("click", () => setAll(!collapsesAll));\n');
  });
});

describe("the toggle button's title, kept in step with its label", () => {
  it("names the shortcut in the title, and updates it whenever the label changes", () => {
    const toggleAll = { textContent: "", title: "" };
    const labelToggleAll = runInNewContext(`let collapsesAll;\n${fnSource("labelToggleAll")}labelToggleAll`, { toggleAll }) as (
      open: boolean,
    ) => void;
    labelToggleAll(true);
    expect(toggleAll.textContent).toBe("Collapse all");
    expect(toggleAll.title).toBe("Collapse all (c)");
    labelToggleAll(false);
    expect(toggleAll.textContent).toBe("Expand all");
    expect(toggleAll.title).toBe("Expand all (c)");
  });

  it("names the shortcut for assistive tech through aria-keyshortcuts, on the button itself", () => {
    expect(PAGE_HTML).toMatch(/<button id="toggle-all"[^>]*\saria-keyshortcuts="c"[^>]*>/);
  });
});

describe("the 'c' keyboard shortcut for Collapse all / Expand all", () => {
  const run = (opts: {
    key?: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean;
    active?: { tagName?: string; isContentEditable?: boolean } | null; menuOpen?: boolean;
  } = {}) => {
    const seen = { clicks: 0, closes: 0, resets: 0 };
    const context = {
      openMenuKey: opts.menuOpen ? "19:menu" : null,
      toggleAll: { click: () => { seen.clicks++; } },
      closeMenu: () => { seen.closes++; },
      resetIdleTimer: () => { seen.resets++; },
      document: { activeElement: opts.active ?? null },
      EVENT: { key: opts.key ?? "c", ctrlKey: opts.ctrlKey ?? false, metaKey: opts.metaKey ?? false, altKey: opts.altKey ?? false },
    };
    runInNewContext(`${fnSource("isTypingTarget")}${fnSource("onKeydown")}onKeydown(EVENT)`, context);
    return seen;
  };

  it("clicks Collapse all / Expand all on a plain, unmodified c", () => {
    expect(run().clicks).toBe(1);
  });

  it("does nothing while the search box, or any other field, has focus", () => {
    expect(run({ active: { tagName: "INPUT" } }).clicks).toBe(0);
    expect(run({ active: { tagName: "TEXTAREA" } }).clicks).toBe(0);
    expect(run({ active: { tagName: "SELECT" } }).clicks).toBe(0);
    expect(run({ active: { isContentEditable: true } }).clicks).toBe(0);
  });

  it("does nothing on a modified c — Ctrl, Meta or Alt", () => {
    expect(run({ ctrlKey: true }).clicks).toBe(0);
    expect(run({ metaKey: true }).clicks).toBe(0);
    expect(run({ altKey: true }).clicks).toBe(0);
  });

  it("does nothing while a row's menu is open", () => {
    expect(run({ menuOpen: true }).clicks).toBe(0);
  });

  it("still closes an open menu on Escape, and still resets its idle timer on any other key while one is open", () => {
    expect(run({ key: "Escape", menuOpen: true }).closes).toBe(1);
    expect(run({ key: "x", menuOpen: true }).resets).toBe(1);
  });
});

describe("the arrow keys on the board", () => {
  type Active = { tagName?: string; inMain?: boolean } | "body" | null;
  const press = (key: string, opts: { active?: Active; menuOpen?: boolean; altKey?: boolean; metaKey?: boolean } = {}) => {
    const seen = { steps: [] as number[], prevented: 0 };
    const body = { tagName: "BODY" };
    const active = opts.active === "body" ? body : opts.active === undefined || opts.active === null ? null
      : { tagName: opts.active.tagName ?? "BUTTON", closest: (sel: string) => (sel === "main" && opts.active !== "body" && opts.active?.inMain ? {} : null) };
    runInNewContext(`${fnSource("isTypingTarget")}${fnSource("onBoard")}${fnSource("onKeydown")}onKeydown(EVENT)`, {
      openMenuKey: opts.menuOpen ? "19:menu" : null, panelId: null,
      toggleAll: { click: () => {} }, closeMenu: () => {}, closePanel: () => {}, resetIdleTimer: () => {},
      stepFocus: (by: number) => { seen.steps.push(by); },
      document: { activeElement: active, body },
      EVENT: { key, ctrlKey: false, metaKey: opts.metaKey ?? false, altKey: opts.altKey ?? false, preventDefault: () => { seen.prevented++; } },
    });
    return seen;
  };

  it("moves focus an item down or up from the board, and keeps the page from scrolling", () => {
    expect(press("ArrowDown", { active: "body" })).toEqual({ steps: [1], prevented: 1 });
    expect(press("ArrowUp", { active: { inMain: true } })).toEqual({ steps: [-1], prevented: 1 });
  });

  it("leaves a field, the panel, an open menu and a modified arrow alone", () => {
    expect(press("ArrowDown", { active: { tagName: "INPUT", inMain: true } }).steps).toEqual([]);
    expect(press("ArrowDown", { active: { inMain: false } }).steps).toEqual([]);
    expect(press("ArrowDown", { active: "body", menuOpen: true }).steps).toEqual([]);
    expect(press("ArrowDown", { active: "body", altKey: true }).steps).toEqual([]);
    expect(press("ArrowDown", { active: "body", metaKey: true }).steps).toEqual([]);
  });

  /*
   * Only titles on screen: a closed lane's or a search-hidden one's take no
   * focus. Chromium still lays out a closed <details>' content — boxes and
   * all — and refuses focus there without a word: with every item in a
   * collapsed Done, the arrows walked into it and nothing moved.
   */
  describe("stepping between item titles", () => {
    const title = (id: string, shown = true) => {
      const li = { id };
      return { id, li, focused: 0, getClientRects: () => [{}], checkVisibility: () => shown, closest: () => li, focus() { this.focused++; }, scrollIntoView: () => {} };
    };
    const step = (by: number, titles: Array<ReturnType<typeof title>>, active: unknown) => {
      runInNewContext(`${fnSource("stepFocus")} stepFocus(BY)`, {
        BY: by, document: { activeElement: active, querySelectorAll: () => titles },
      });
      return titles.filter((t) => t.focused > 0).map((t) => t.id);
    };

    it("starts at the first title going down and the last going up, from nowhere on the list", () => {
      expect(step(1, [title("1"), title("2"), title("3")], null)).toEqual(["1"]);
      expect(step(-1, [title("1"), title("2"), title("3")], null)).toEqual(["3"]);
    });

    it("goes to the next or previous title from anywhere in a row, and stops at either end", () => {
      const t = [title("1"), title("2"), title("3")];
      const inRow = (n: number) => ({ closest: () => t[n]?.li });
      expect(step(1, t, inRow(1))).toEqual(["3"]);
      const u = [title("1"), title("2"), title("3")];
      expect(step(1, u, { closest: () => u[2]?.li })).toEqual(["3"]);
      const v = [title("1"), title("2"), title("3")];
      expect(step(-1, v, { closest: () => v[0]?.li })).toEqual(["1"]);
    });

    it("skips a title that is not on screen", () => {
      const t = [title("1"), title("2", false), title("3")];
      expect(step(1, t, { closest: () => t[0]?.li })).toEqual(["3"]);
    });

    it("focuses nothing when every title is in a closed lane", () => {
      expect(step(1, [title("1", false), title("2", false)], null)).toEqual([]);
    });
  });
});

describe("the chosen row", () => {
  it("has its own background while focused or open in the panel, in light and dark", () => {
    const li = runInNewContext(`${constSource("INDENT")}${constSource("indentOf")}${["el", "treeItem"].map(fnSource).join("")}
      treeItem({ children: [] }, 0, "", false)`, { document: fakeDocument }) as FakeElement;
    // A tint, not a grey: neutral-100 on a white card was there and unseen.
    for (const cls of ["focus-within:bg-blue-50", "dark:focus-within:bg-blue-950", "aria-selected:bg-blue-50", "dark:aria-selected:bg-blue-950"]) {
      expect(li.className.split(" ")).toContain(cls);
    }
  });

  it("is the panel's item, marked on its row alone", () => {
    const stale = { attrs: new Map([["aria-selected", "true"]]), removeAttribute(k: string) { this.attrs.delete(k); }, setAttribute(k: string, v: string) { this.attrs.set(k, v); } };
    const chosen = { attrs: new Map<string, string>(), removeAttribute(k: string) { this.attrs.delete(k); }, setAttribute(k: string, v: string) { this.attrs.set(k, v); } };
    const mark = (panelId: string | null) => runInNewContext(`${fnSource("markSelected")} markSelected()`, {
      panelId, document: { querySelectorAll: () => [stale] },
      byKey: (key: string) => (key === "12:open" ? { closest: () => chosen } : null),
    });
    mark("12");
    expect(stale.attrs.has("aria-selected")).toBe(false);
    expect(chosen.attrs.get("aria-selected")).toBe("true");
    chosen.attrs.clear();
    mark(null);
    expect(chosen.attrs.size).toBe(0);
  });

  it("is marked after every board render and every change of panel", () => {
    expect(fnSource("render")).toContain("markSelected();");
    expect(fnSource("showPanel")).toContain("markSelected();");
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
    function itemRowFor(row, depth, now, open) { return depth + ":" + row.id + (open ? "+" : ""); }
    function artifactRowFor(row, depth, open) { return depth + ":" + row.id + (open ? "+" : ""); }
    ${["isOpen", "openOf", "shows", "normalise", "matches", "searchOf", "treeRows"].map(fnSource).join("")}
    treeRows(ROWS, 0, new Set(), 0, [], searchOf(ROWS, ${JSON.stringify(query)}), false)`, { ROWS: TREE }) as string[])];

  it("draws the whole tree open with no query, and a row's children only while it is open", () => {
    expect(walk("")).toEqual(["0:12+", "1:31+", "2:pr:118", "1:32", "0:40+", "1:41"]);
    expect(walk("", { 12: false })).toEqual(["0:12", "0:40+", "1:41"]);
    expect(walk("", { 31: false, 40: false })).toEqual(["0:12+", "1:31", "1:32", "0:40"]);
  });

  it("holds a match's ancestors open and hides everything that neither matches nor leads to a match", () => {
    expect(walk("api e", { 31: false })).toEqual(["0:12+", "1:31"]);
  });

  it("holds the path open even against a stored collapse, without changing it", () => {
    expect(walk("token", { 40: false })).toEqual(["0:40+", "1:41"]);
  });

  it("draws a matched row's own subtree whole while it is open, matching or not", () => {
    expect(walk("api e")).toEqual(["0:12+", "1:31+", "2:pr:118"]);
    expect(walk("payments", { 31: false })).toEqual(["0:12+", "1:31", "1:32"]);
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
  it("names the system only on artifact rows — an item row carries no mark and no system name", () => {
    expect(fnSource("itemRowFor")).not.toContain("systemMark(");
    expect(fnSource("artifactRowFor")).toContain("systemMark(row.system)");
  });

  it("shows an item's priority only when it has one, never a placeholder", () => {
    expect(APP_JS).toMatch(/if \(typeof row\.priority === "number"\)/);
    expect(APP_JS).not.toContain('"–"');
  });

  // The toggle used to sit inside the title line, so a parent row's note
  // started under the toggle, a column left of its number.
  it("gives a parent row's toggle its own column, so the number, the note and wrapped chips share one edge", () => {
    const src = fnSource("itemRowFor");
    expect(src).not.toMatch(/top\.append\(toggleFor/);
    expect(src).toMatch(/main\.append\(toggleSlot\(row, open\)\);/);
    expect(src).toMatch(/body\.append\(top, bottom\);\s*main\.append\(body\);/);
  });

  it("indents one toggle-and-gap per level, so a child's toggle sits under its parent's number", () => {
    expect(APP_JS).toContain('const INDENT = ["pl-4", "pl-10", "pl-16", "pl-22", "pl-28"];');
  });
});

/** A top-level `const NAME = { … };` of the page script that spans several lines, as source. */
const blockSource = (name: string): string => {
  const start = APP_JS.indexOf(`\nconst ${name} = `);
  if (start < 0) throw new Error(`APP_JS has no top-level const ${name}`);
  const end = /\n[}\]];\n/.exec(APP_JS.slice(start));
  if (!end) throw new Error(`APP_JS's const ${name} never closes`);
  return APP_JS.slice(start, start + end.index + end[0].length);
};

/**
 * A row's actions menu: this item's writes — Retry, and Go to step… to
 * each stage the server offers — each offered only where the server put a
 * path in the row, asked before either posts, and posted to the path the
 * server built alone; the Chat caption and its targets follow, as before.
 */
describe("a stopped item's Retry", () => {
  class Listening extends FakeElement {
    listeners = new Map<string, () => void>();
    disabled = false;
    hidden = false;
    override addEventListener(type?: string, f?: () => void): void { if (type && f) this.listeners.set(type, f); }
  }
  const doc = { createElement: (tag: string) => new Listening(tag), createElementNS: (_: string, tag: string) => new Listening(tag) };
  const row = (retry: string | null, goto: Array<{ stage: string; path: string }> = [], clear: string | null = null) => ({
    id: "19", chat: { prompt: "p", links: { claude: "a:", claudeCli: "b:", cursor: "c:", codex: "d:" } }, retry, goto, clear,
  });

  /** The menu for a row, with the world a click reaches stood in for and written down. */
  const menuFor = (r: ReturnType<typeof row>, world: { confirm?: boolean; response?: { ok: boolean; text: string } | "down" } = {}) => {
    const seen = { confirms: [] as string[], posts: [] as Array<[string, unknown]>, closed: [] as unknown[], polls: [] as number[], renders: 0, moved: [] as string[] };
    const context = {
      ROW: r, document: doc, navigator: {}, seen, lastView: {},
      moved: (id: string) => { seen.moved.push(id); },
      confirm: (text: string) => { seen.confirms.push(text); return world.confirm ?? true; },
      fetch: (url: string, init: unknown) => {
        seen.posts.push([url, init]);
        const answer = world.response ?? { ok: true, text: "retry requested" };
        return answer === "down"
          ? Promise.reject(new TypeError("fetch failed"))
          : Promise.resolve({ ok: answer.ok, text: () => Promise.resolve(answer.text) });
      },
      closeMenu: (opts: unknown) => { seen.closed.push(opts); },
      schedulePoll: (ms: number) => { seen.polls.push(ms); },
      render: () => { seen.renders++; },
    };
    const menu = runInNewContext(`
      ${constSource("SVG_NS")}${blockSource("CHAT_TARGETS")}
      const writeNotes = new Map();
      const writing = new Set();
      ${["el", "luminance", "faintOnDark", "markSvg", "chatIcon", "menuItem", "writeItem", "send", "writesOf", "buildRowMenu"].map(fnSource).join("")}
      buildRowMenu(ROW)`, context) as Listening;
    return { menu, seen, context };
  };
  const items = (menu: Listening): string[] => menu.children.map((c) => (c.tag === "hr" ? "—" : c.textContent));
  const retryOf = (menu: Listening): Listening | undefined =>
    menu.children.find((c) => c.getAttribute("data-key") === "19:retry") as Listening | undefined;
  const gotoOf = (menu: Listening, stage: string): Listening | undefined =>
    menu.children.find((c) => c.getAttribute("data-key") === `19:goto:${stage}`) as Listening | undefined;
  const BACK = [{ stage: "spec", path: "/items/19/goto/spec" }, { stage: "build", path: "/items/19/goto/build" }];
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("comes first, before the Chat caption and every chat item, and only on a row the server offered it for", () => {
    expect(items(menuFor(row("/items/19/retry")).menu)).toEqual([
      "Retry", "—", "Chat", "Claude Code", "Claude Code (CLI)", "Cursor", "Codex", "—", "Copy prompt",
    ]);
    expect(items(menuFor(row(null)).menu)).toEqual(["Chat", "Claude Code", "Claude Code (CLI)", "Cursor", "Codex", "—", "Copy prompt"]);
  });

  it("lists the steps the server offered under Go to step…, before the writes' divider", () => {
    expect(items(menuFor(row("/items/19/retry", BACK)).menu)).toEqual([
      "Retry", "Go to step…", "spec", "build", "—", "Chat", "Claude Code", "Claude Code (CLI)", "Cursor", "Codex", "—", "Copy prompt",
    ]);
    expect(items(menuFor(row(null, BACK)).menu).slice(0, 3)).toEqual(["Go to step…", "spec", "build"]);
  });

  it("is a menu item, keyed so focus on it survives a poll", () => {
    const item = retryOf(menuFor(row("/items/19/retry")).menu);
    expect(item?.tag).toBe("button");
    expect(item?.getAttribute("role")).toBe("menuitem");
  });

  // A screened item's overrule: next to Retry, asked in words that say the
  // security check is skipped, and posted under its own header.
  it("offers Clear & retry right after Retry, only where the server put a path", () => {
    expect(items(menuFor(row("/items/19/retry", [], "/items/19/clear")).menu).slice(0, 3)).toEqual(["Retry", "Clear & retry", "—"]);
  });

  it("asks that the refused text was read, then posts with the clear header", async () => {
    const { menu, seen } = menuFor(row("/items/19/retry", [], "/items/19/clear"));
    const clear = menu.children.find((c) => c.getAttribute("data-key") === "19:clear") as Listening | undefined;
    clear?.listeners.get("click")?.();
    await settle();
    expect(seen.confirms[0]).toMatch(/#19[\s\S]*without the security check[\s\S]*read/);
    expect(seen.posts).toEqual([["/items/19/clear", { method: "POST", headers: { "x-landrace-action": "clear" } }]]);
  });

  it("asks before it posts, and posts nothing when told no", async () => {
    const { menu, seen } = menuFor(row("/items/19/retry"), { confirm: false });
    retryOf(menu)?.listeners.get("click")?.();
    await settle();
    expect(seen.confirms).toHaveLength(1);
    expect(seen.confirms[0]).toMatch(/#19[\s\S]*paid step/);
    expect(seen.posts).toEqual([]);
  });

  it("posts once, to the server's own path, with the header the server asks for — then closes, returns focus and polls", async () => {
    const { menu, seen } = menuFor(row("/items/19/retry"));
    retryOf(menu)?.listeners.get("click")?.();
    await settle();
    expect(seen.posts).toEqual([["/items/19/retry", { method: "POST", headers: { "x-landrace-action": "retry" } }]]);
    expect(seen.closed).toEqual([{ returnFocus: true }]);
    expect(seen.polls).toEqual([0]);
  });

  // The server moves it only when a tick lists the tracker again; until then the page shows it moving.
  it("marks the item moving once the server took the write, and not when it refused", async () => {
    const taken = menuFor(row("/items/19/retry", BACK));
    gotoOf(taken.menu, "build")?.listeners.get("click")?.();
    await settle();
    expect(taken.seen.moved).toEqual(["19"]);
    const refused = menuFor(row("/items/19/retry"), { response: { ok: false, text: "nope" } });
    retryOf(refused.menu)?.listeners.get("click")?.();
    await settle();
    expect(refused.seen.moved).toEqual([]);
  });

  it("keeps the menu open and says what the server said when it refuses", async () => {
    const { menu, seen, context } = menuFor(row("/items/19/retry"), {
      response: { ok: false, text: "#19 is not blocked or screened right now, so there is nothing to retry" },
    });
    retryOf(menu)?.listeners.get("click")?.();
    await settle();
    expect(seen.closed).toEqual([]);
    // Redrawn from state, so the sentence outlives the render every poll does.
    expect(seen.renders).toBeGreaterThan(0);
    const again = runInNewContext("buildRowMenu(ROW)", context) as Listening;
    expect(retryOf(again)?.textContent).toMatch(/not blocked or screened/);
  });

  it("says landrace is not answering when the post never lands", async () => {
    const { menu, context } = menuFor(row("/items/19/retry"), { response: "down" });
    retryOf(menu)?.listeners.get("click")?.();
    await settle();
    const again = runInNewContext("buildRowMenu(ROW)", context) as Listening;
    expect(retryOf(again)?.textContent).toMatch(/not responding/);
  });

  it("asks, then posts to the step's own path with the goto header", async () => {
    const { menu, seen } = menuFor(row(null, BACK));
    gotoOf(menu, "build")?.listeners.get("click")?.();
    await settle();
    expect(seen.confirms[0]).toMatch(/#19[\s\S]*build[\s\S]*paid step/);
    expect(seen.posts).toEqual([["/items/19/goto/build", { method: "POST", headers: { "x-landrace-action": "goto" } }]]);
  });

  it("shows a refusal on the menu entry that asked, and only there", async () => {
    const { menu, context } = menuFor(row("/items/19/retry", BACK), { response: { ok: false, text: "past its cap" } });
    gotoOf(menu, "build")?.listeners.get("click")?.();
    await settle();
    const again = runInNewContext("buildRowMenu(ROW)", context) as Listening;
    expect(gotoOf(again, "build")?.textContent).toBe("past its cap");
    expect(retryOf(again)?.textContent).toBe("Retry");
  });

  it("forgets a refusal once its menu closes", async () => {
    const { menu, context } = menuFor(row("/items/19/retry"), { response: { ok: false, text: "nope" } });
    retryOf(menu)?.listeners.get("click")?.();
    await settle();
    expect(runInNewContext("writeNotes.size", context)).toBe(1);
    // closeMenu reads openMenuKey and two helpers from the page's globals.
    Object.assign(context, { openMenuKey: "19:menu", applyMenuState: () => {}, clearIdleTimer: () => {} });
    runInNewContext(`${fnSource("closeMenu")} closeMenu();`, context);
    expect(runInNewContext("writeNotes.size", context)).toBe(0);
  });

  it("draws a needs-you row's action button as ⋯ too, bordered for emphasis, with an aria-label of Actions", () => {
    const context = { ROW: { ...row(null), badge: "needs-you" }, document: doc, navigator: {}, lastView: {} };
    const wrap = runInNewContext(`
      ${constSource("SVG_NS")}${blockSource("CHAT_TARGETS")}
      const writeNotes = new Map();
      const writing = new Set();
      function menuKeyOf(id) { return id + ":menu"; }
      function triggerKeyOf(id) { return id + ":trigger"; }
      ${["el", "luminance", "faintOnDark", "markSvg", "chatIcon", "menuItem", "writeItem", "send", "writesOf", "buildRowMenu", "actionFor"].map(fnSource).join("")}
      actionFor(ROW)`, context) as Listening;
    const trigger = wrap.children[0] as Listening;
    expect(trigger.textContent).toBe("⋯");
    expect(trigger.getAttribute("aria-label")).toBe("Actions");
    expect(trigger.className).toContain("border");
  });
});

describe("an item row stopped by a security check", () => {
  interface ItemRow extends Tree {
    kind: string; link: string; closed: null; badge: string; stage: string; priority: null; note: string;
    since: null; round: null; model: null; chat: null; screened: boolean;
  }
  const build = (row: ItemRow): FakeElement => runInNewContext(`
    ${constSource("SVG_NS")}${constSource("INDENT")}${constSource("indentOf")}${blockSource("BADGES")}
    ${["el", "elapsed", "external", "treeItem", "shieldMark", "toggleFor", "toggleSlot", "itemRowFor"].map(fnSource).join("")}
    itemRowFor(ROW, 0, 0, false)`, { ROW: row, document: fakeDocument }) as FakeElement;
  const screened: ItemRow = {
    id: "19", kind: "item", title: "Payments revamp", link: "https://github.com/a/b/issues/19", closed: null,
    badge: "needs-you", stage: "screened", priority: null, note: "blocked by a security check",
    since: null, round: null, model: null, chat: null, screened: true, children: [],
  };
  const shield = (li: FakeElement): FakeElement | undefined =>
    descendants(li).find((d) => d.getAttribute("aria-label") === "Blocked by a security check");

  it("carries a shield, named for a screen reader and a hover, drawn as inline SVG", () => {
    const mark = shield(build(screened));
    expect(mark?.getAttribute("role")).toBe("img");
    expect(mark?.title).toBe("Blocked by a security check");
    expect(mark?.children[0]?.tag).toBe("svg");
  });

  it("says what stopped it in the row's note", () => {
    expect(descendants(build(screened)).map((d) => d.text)).toContain("blocked by a security check");
  });

  it("draws no shield on a row blocked for any other reason", () => {
    expect(shield(build({ ...screened, stage: "blocked", note: "blocked: needs a human", screened: false }))).toBeUndefined();
  });

  it("never reaches for an image: the page's CSP loads none, and a mark is drawn, not fetched", () => {
    expect(APP_JS).not.toMatch(/createElement\("img"\)|<img/);
    expect(PAGE_HTML).not.toContain("<img");
  });
});

/*
 * One page over every workflow: an item's row says which workflow owns it,
 * small, beside its title. An item no one workflow owns names none — its
 * note says why.
 */
describe("an item row's workflow", () => {
  const row = (workflow: string | null, tag: string | null = null) => ({
    id: "12", kind: "item", title: "Add export", link: "", closed: null, badge: "waiting", stage: "build",
    priority: null, note: "queued", since: null, round: null, model: null, chat: null, screened: false, children: [], workflow, tag,
  });
  const build = (r: ReturnType<typeof row>, showTags = true): FakeElement => runInNewContext(`
    ${constSource("SVG_NS")}${constSource("INDENT")}${constSource("indentOf")}${blockSource("BADGES")}
    ${["routeOf", "pageOf", "pageNow", "tagsOn", "el", "elapsed", "external", "treeItem", "shieldMark", "toggleFor", "toggleSlot", "itemRowFor"].map(fnSource).join("")}
    itemRowFor(ROW, 0, 0, false)`, {
      ROW: r, document: fakeDocument,
      lastView: { workflows: [{ id: "fast", name: "Fastlane", needsYou: 0 }] }, location: { hash: showTags ? "#/" : "#/w/fast" },
    }) as FakeElement;
  const tagOf = (li: FakeElement): FakeElement | undefined => descendants(li).find((d) => d.className.split(" ").includes("workflow"));

  it("is named, by its name, in a small tag right after the title", () => {
    const li = build(row("fast", "Fastlane"));
    const tag = tagOf(li);
    expect(tag?.text).toBe("Fastlane");
    const line = descendants(li).find((d) => d.children.includes(tag as FakeElement));
    const at = line?.children.findIndex((c) => c.className.split(" ").includes("title")) ?? -1;
    expect(line?.children[at + 1]).toBe(tag);
  });

  it("is hidden on a workflow's own page, where it would repeat the page's name", () => {
    expect(tagOf(build(row("fast", "Fastlane"), false))).toBeUndefined();
  });

  it("is not drawn for an item no one workflow owns, nor in a workspace of one workflow", () => {
    expect(tagOf(build(row(null)))).toBeUndefined();
    expect(tagOf(build(row("main")))).toBeUndefined();
  });
});

// #20 above #21 in one lane: #21 had a document under it and so a toggle, #20
// had none, and #21's number sat exactly where a child of #20's would — the
// board read as #21 nested under #20.
describe("a row's toggle column", () => {
  const row = (children: unknown[]) => ({
    id: "20", kind: "item", title: "Retro stage", link: "", closed: null, badge: "waiting", stage: "spec",
    priority: null, note: "", since: null, round: null, model: null, chat: null, screened: false, children,
  });
  const build = (r: ReturnType<typeof row>): FakeElement => runInNewContext(`
    ${constSource("SVG_NS")}${constSource("INDENT")}${constSource("indentOf")}${blockSource("BADGES")}
    ${["el", "elapsed", "external", "treeItem", "shieldMark", "toggleFor", "toggleSlot", "itemRowFor"].map(fnSource).join("")}
    itemRowFor(ROW, 0, 0, ROW.children.length > 0)`, { ROW: r, document: fakeDocument }) as FakeElement;
  const slot = (li: FakeElement): FakeElement | undefined => li.children[0]?.children[0];
  const width = (e: FakeElement | undefined): string[] => (e?.className ?? "").split(" ").filter((c) => c.startsWith("w-"));

  it("is kept on a row with nothing to open, blank and the toggle's own width, so siblings' numbers share one edge", () => {
    const leaf = slot(build(row([])));
    const parent = slot(build(row([{ id: "spec-20" }])));
    expect(parent?.tag).toBe("button");
    expect(leaf?.tag).toBe("span");
    expect(leaf?.text).toBe("");
    expect(leaf?.getAttribute("aria-hidden")).toBe("true");
    expect(width(leaf)).toEqual(width(parent));
    expect(width(leaf)).not.toEqual([]);
  });
});

describe("an artifact row", () => {
  interface Artifact extends Tree {
    kind: string; link: string; closed: null | "done" | "dropped"; createdAt?: number | null;
    system: { name: string; icon: { bg: string; glyph: string } | null } | null;
  }
  const NOW = Date.parse("2026-09-28T12:00:00Z");
  const build = (row: Artifact, depth = 1): FakeElement => runInNewContext(`
    ${constSource("SVG_NS")}${constSource("INDENT")}${constSource("indentOf")}
    ${["el", "luminance", "faintOnDark", "markSvg", "systemIcon", "systemMark", "kindMark", "ago", "external", "treeItem", "toggleFor", "toggleSlot", "artifactRowFor"].map(fnSource).join("")}
    artifactRowFor(ROW, ${depth}, ROW.children.length > 0, NOW)`, { ROW: row, NOW, document: fakeDocument }) as FakeElement;
  const spec: Artifact = {
    id: "spec-19", kind: "document", title: "Spec: Payments revamp", link: "https://acme.github.io/widgets/specs/19/",
    system: { name: "GitHub Pages", icon: { bg: "#24292f", glyph: "GH" } }, closed: null, children: [],
  };
  const pr: Artifact = {
    ...spec, id: "pr:118", kind: "pull-request", title: "API endpoints for payments", link: "https://github.com/a/b/pull/118",
    system: { name: "GitHub", icon: { bg: "#24292f", glyph: "GH" } },
  };
  const texts = (e: FakeElement): string[] => descendants(e).map((d) => d.text).filter(Boolean);
  const link = (li: FakeElement): FakeElement | undefined => descendants(li).find((d) => d.tag === "a");

  it("shows only the system's mark, the title, and ↗ — no system name or kind on the line", () => {
    expect(texts(build(spec))).toEqual(["GH", "Spec: Payments revamp", "↗"]);
    expect(texts(build(pr))).toEqual(["GH", "API endpoints for payments", "↗"]);
  });

  it("keeps the system's name on the mark, as its tooltip and its accessible name", () => {
    const mark = descendants(build(spec)).find((d) => d.title === "GitHub Pages");
    expect(mark?.title).toBe("GitHub Pages");
    expect(mark?.getAttribute("aria-label")).toBe("GitHub Pages");
    expect(mark?.children[0]?.tag).toBe("svg");
  });

  it("is one link to the row's own url, opening in a new tab, keyed so focus survives a poll", () => {
    const a = link(build(spec));
    expect(a).toMatchObject({ href: spec.link, target: "_blank", rel: "noopener noreferrer" });
    expect(a?.getAttribute("data-key")).toBe("spec-19:link");
    expect(descendants(build(spec)).filter((d) => d.tag === "a")).toHaveLength(1);
  });

  it("names the link for a screen reader by its title, its kind and its system", () => {
    expect(link(build(spec))?.getAttribute("aria-label")).toBe("Spec: Payments revamp, document on GitHub Pages, opens in a new tab");
    expect(link(build(pr))?.getAttribute("aria-label")).toBe("API endpoints for payments, pull request on GitHub, opens in a new tab");
  });

  it("puts the kind's mark first, the system's second, and ↗ last, pushed to the row's far edge and hidden from a screen reader", () => {
    const a = link(build(spec));
    expect(a?.children.slice(0, 2).map((c) => c.getAttribute("aria-label"))).toEqual(["Document", "GitHub Pages"]);
    const arrow = a?.children.at(-1);
    expect(arrow?.text).toBe("↗");
    expect(arrow?.getAttribute("aria-hidden")).toBe("true");
    expect(arrow?.className.split(" ")).toContain("ml-auto");
  });

  it("is never underlined on hover, and shows a hover background and a keyboard focus ring instead", () => {
    const classes = descendants(build(spec)).flatMap((d) => d.className.split(" "));
    expect(classes.filter((c) => c.includes("underline"))).toEqual([]);
    const own = link(build(spec))?.className.split(" ") ?? [];
    expect(own).toEqual(expect.arrayContaining(["hover:bg-neutral-100", "dark:hover:bg-neutral-800", "focus-visible:outline-2"]));
  });

  const kindOf = (li: FakeElement): FakeElement | undefined => link(li)?.children[0];
  it.each([
    [null, "Open pull request", "green"],
    ["done", "Merged pull request", "purple"],
    ["dropped", "Closed pull request", "red"],
  ] as const)("marks a pull request closed=%s as %s, drawn inline in %s", (closed, name, colour) => {
    const mark = kindOf(build({ ...pr, closed }));
    expect(mark?.getAttribute("role")).toBe("img");
    expect(mark?.getAttribute("aria-label")).toBe(name);
    expect(mark?.title).toBe(name);
    expect(mark?.children[0]?.tag).toBe("svg");
    expect(mark?.className).toContain(`text-${colour}-`);
  });

  it("marks a document as a document", () => {
    const mark = kindOf(build(spec));
    expect(mark?.getAttribute("aria-label")).toBe("Document");
    expect(mark?.children[0]?.tag).toBe("svg");
  });

  it("draws no kind mark for a kind it has none for, so the system's mark leads the line", () => {
    expect(kindOf(build({ ...spec, kind: "design" }))?.getAttribute("aria-label")).toBe("GitHub Pages");
  });

  it("says how long ago it was created, just ahead of ↗, with the exact time on hover", () => {
    const at = NOW - 3 * 3_600_000;
    const li = build({ ...pr, createdAt: at });
    expect(texts(li)).toEqual(["GH", "API endpoints for payments", "3h", "↗"]);
    const stamp = descendants(li).find((d) => d.text === "3h");
    expect(stamp?.title).toBe(new Date(at).toLocaleString());
    // The link's accessible name replaces its children, so the age has to be in it too.
    expect(link(li)?.getAttribute("aria-label")).toBe("API endpoints for payments, pull request on GitHub, opened 3h ago, opens in a new tab");
  });

  it("says nothing about age when the source gave no creation time", () => {
    expect(texts(build({ ...pr, createdAt: null }))).toEqual(["GH", "API endpoints for payments", "↗"]);
  });

  it.each([
    [30_000, "now"],
    [5 * 60_000, "5m"],
    [3 * 3_600_000, "3h"],
    [47 * 3_600_000, "47h"],
    [49 * 3_600_000, "2d"],
    [400 * 86_400_000, "400d"],
    [-60_000, "now"],
  ])("words an age of %d ms as %s", (ms, words) => {
    expect(runInNewContext(`${fnSource("ago")} ago(NOW - ${ms}, NOW)`, { NOW })).toBe(words);
  });

  it("draws a row with nothing to open as plain text — no anchor, no ↗", () => {
    const li = build({ ...spec, link: "", system: null });
    expect(link(li)).toBeUndefined();
    expect(texts(li)).toEqual(["Spec: Payments revamp"]);
  });

  it("draws no mark for a system it has none for, rather than printing the host", () => {
    const li = build({ ...spec, link: "https://wiki.acme.internal/p/1", system: { name: "wiki.acme.internal", icon: null } });
    expect(texts(li)).toEqual(["Spec: Payments revamp", "↗"]);
    expect(link(li)?.getAttribute("aria-label")).toBe("Spec: Payments revamp, document on wiki.acme.internal, opens in a new tab");
  });

  // Same column as an item's number at this depth: the toggle is a column of
  // its own, and the mark opens the line after it.
  it("keeps the toggle in its own column ahead of the link, so the mark lines up with an item's number", () => {
    const leaf = build(spec, 2);
    expect(leaf.className.split(" ")).toContain("pl-16");
    expect(leaf.children.map((c) => c.tag)).toEqual(["span", "a"]);
    const parent = build({ ...pr, children: [spec] }, 2);
    expect(parent.children.map((c) => [c.tag, c.getAttribute("data-key")])).toEqual([["button", "pr:118:toggle"], ["a", "pr:118:link"]]);
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
    expect(header).toMatch(/<header[^>]*>\s*<div class="[^"]*max-w-6xl[^"]*justify-between/);
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

  describe("what the tick button says once the server answers", () => {
    const answer = (status: number, said: string) => {
      const seen = { button: [] as Array<[string, boolean]>, restores: 0, polls: 0 };
      runInNewContext(`${fnSource("tickAnswered")} tickAnswered(STATUS, SAID);`, {
        STATUS: status, SAID: said, TICK_LABEL: "Run next tick now",
        setTickButton: (text: string, disabled: boolean) => seen.button.push([text, disabled]),
        restoreAfter: () => { seen.restores += 1; },
        schedulePoll: () => { seen.polls += 1; },
      });
      return seen;
    };

    it("is itself again, and re-polls at once, when a tick started", () => {
      expect(answer(202, "tick started")).toEqual({ button: [["Run next tick now", false]], restores: 0, polls: 1 });
    });

    it("says queued, briefly, when the tick waits behind the one running", () => {
      expect(answer(202, "tick queued")).toEqual({ button: [["queued", true]], restores: 1, polls: 0 });
    });

    it("says failed, briefly, on anything else", () => {
      expect(answer(503, "landrace is stopping")).toEqual({ button: [["failed", true]], restores: 1, polls: 0 });
    });
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

  // Asked for by the person who reads it: a clock of when the tracker was
  // last listed told them nothing the countdown beside it did not.
  it("says nothing in the header about when the board was last listed", () => {
    expect(APP_JS).not.toMatch(/"listed "|listedAt/);
    expect(APP_JS).not.toContain("waiting for the first tick");
  });

  it("clears the not-responding note once a poll lands again", () => {
    expect(fnSource("render")).toContain('getElementById("meta").textContent = ""');
    expect(APP_JS).toContain('"landrace is not responding"');
  });

  it("has a folder chip in the header, set from the board view", () => {
    const header = /<header[^>]*>[\s\S]*?<\/header>/.exec(PAGE_HTML)?.[0] ?? "";
    expect(header).toContain('id="folder"');
    expect(APP_JS).toContain('getElementById("folder").textContent = view.folder');
  });

  it("shows a quiet empty state, through textContent, when there is nothing to show", () => {
    expect(APP_JS).toContain('"None"');
  });

  it("draws the same ⋯ action on every row, only its border marking a needs-you row", () => {
    expect(APP_JS).toContain('row.badge === "needs-you"');
    expect(APP_JS).not.toContain("Chat ▾");
    expect(APP_JS).toContain('"aria-label", "Actions"');
  });

  it("wires exactly the tick button, the refresh button, the theme toggle, the search box, Collapse all / Expand all, the collapsible lanes' summaries, the row expand toggle, the row menu toggle, the four links, copy, retry, the two document-level close listeners, the item panel's and pairing's, the message box's shortcut, and the bell's — no more, no less", () => {
    // Pins the count deliberately: the tick button, the refresh button and
    // the theme toggle, the search box and the one Collapse all / Expand all
    // button (each wired once, outside anything a render rebuilds), the
    // collapsible lanes' summary clicks (defined once, in a loop over the
    // two), the expand/collapse toggle (defined once, in toggleFor, not once
    // per row), and for the row's ⋯ menu one toggle-button listener, one
    // close-on-choose listener (defined once inside the per-target loop),
    // one Copy-prompt listener, one write listener (defined once, in
    // writeItem, shared by Retry and every Go to step… target, and built
    // only where the server offered one), and one document listener each for
    // outside-click and Escape (both defined once, so re-rendering never
    // multiplies them). And the item panel's: an item row's title button
    // and the row itself (each defined once, in itemRowFor), ✕, ⤢, Reply,
    // Ask the step, Resolve, and the window's hashchange. And pairing's: the
    // row menu's Pairing…, the panel header's ⋯ and its Pairing… item, and
    // one for every button of its Pairing section (defined once, in
    // pairingSectionOf). And the bell's: its own click, its note's ✕, the
    // browser's permission change (defined once, in followPermission), and a
    // notification's (defined once, in notifyOf). And the message box's
    // Ctrl/⌘+Enter.
    const listeners = APP_JS.match(/addEventListener/g) ?? [];
    expect(listeners).toHaveLength(30);
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

  it("tracks the open menu by item, never by an element reference, so a render() in between can't leave it stale", () => {
    expect(APP_JS).toContain("let openMenuKey = null;");
    expect(APP_JS).not.toContain("pendingView");
    // No stashed view: pollOnce() renders unconditionally now.
    expect(APP_JS).toContain("render(withMoves(await res.json(), moves));");
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

  it("keeps a person's own expand/collapse across every poll, and asks the server no opinion", () => {
    expect(APP_JS).toContain("const userExpanded = new Map();");
    expect(APP_JS).not.toContain("row.expanded");
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

/*
 * The item panel: a row opens it, the URL names it, and its bottom half
 * follows what the item is doing — live lines while an agent runs, a
 * composer while it waits on a person, the conversation otherwise.
 */
describe("the item panel's markup", () => {
  const aside = /<aside id="panel"[^>]*>/.exec(PAGE_HTML)?.[0] ?? "";

  it("starts closed, and takes the full width below sm", () => {
    expect(aside).toMatch(/\shidden[\s>]/);
    expect(aside).toMatch(/ w-full /);
    expect(aside).toMatch(/sm:w-\[28rem\]/);
  });

  it("names its close and full-width buttons for a screen reader", () => {
    expect(PAGE_HTML).toMatch(/<button id="panel-close" type="button" aria-label="Close"[^>]*>✕<\/button>/);
    expect(PAGE_HTML).toMatch(/<button id="panel-wide" type="button" aria-label="Full width" aria-pressed="false"[^>]*>⤢<\/button>/);
  });

  // The ⋯ once sat in the redrawn top section and, clicked, opened no menu
  // at all: a section appeared further down. It is the header's own menu
  // now, beside ⤢ and ✕, outside anything a poll redraws.
  it("puts the item's actions in a ⋯ menu in the header, anchored under it, with Pairing… in it", () => {
    const header = PAGE_HTML.slice(PAGE_HTML.indexOf('<aside id="panel"'), PAGE_HTML.indexOf('<div id="panel-top"'));
    const trigger = /<button id="panel-more"[^>]*>⋯<\/button>/.exec(header)?.[0] ?? "";
    expect(trigger).toContain('data-key="panel:trigger"');
    expect(trigger).toContain('aria-haspopup="menu"');
    expect(trigger).toContain('aria-expanded="false"');
    expect(trigger).toContain('aria-label="Item actions"');
    const menu = /<div id="panel-menu"[^>]*>/.exec(header)?.[0] ?? "";
    expect(menu).toContain('data-key="panel:menu"');
    expect(menu).toContain('role="menu"');
    expect(menu).toMatch(/\shidden[\s>]/);
    // Its trigger is at the panel's right edge: right-aligned at every width.
    const tokens = menu.split(/\s+/);
    expect(tokens).toContain("right-0");
    expect(tokens).not.toContain("left-0");
    expect(tokens).not.toContain("sm:left-auto");
    expect(header).toMatch(/<button id="panel-pairing-item" type="button" role="menuitem"[^>]*>Pairing…<\/button>/);
    expect(header.indexOf('id="panel-more"')).toBeLessThan(header.indexOf('id="panel-wide"'));
  });

  it("opens the header's menu as it opens a row's, and its Pairing… closes it and shows the section", () => {
    expect(APP_JS).toContain('toggleMenu("panel")');
    expect(APP_JS).toMatch(/pairingItem\.addEventListener\("click", \(\) => \{ closeMenu\(\); togglePairing\(\); \}\)/);
    expect(APP_JS).not.toContain("panel:more");
  });

  // Back, or another item's row, moves the panel without a click outside
  // the menu: left open, it would hold the one-open slot and the "c" key.
  it("closes the header's menu whenever the panel moves or shuts", () => {
    for (const to of [null, "8"]) {
      const closed: string[] = [];
      runInNewContext(`${fnSource("showPanel")} showPanel(TO)`, {
        TO: to, openMenuKey: "panel", closeMenu: () => closed.push("panel"),
        panelHeld: "7", pairingOnOpen: null, panelWide: false, messageBox: {}, setPanelNote: () => {},
        panelEl: {}, document: { body: { classList: { toggle: () => {} } } },
        stopPanelPoll: () => {}, renderPanel: () => {}, loadPairing: () => {}, markSelected: () => {},
      });
      expect(closed).toEqual(["panel"]);
    }
  });

  it("has a labelled message box and Reply, Ask the step and Resolve, outside anything a poll redraws", () => {
    expect(PAGE_HTML).toMatch(/<textarea id="panel-message"[^>]*aria-label="Message"/);
    for (const [id, label] of [["panel-reply", "Reply"], ["panel-ask", "Ask the step"], ["panel-resolve", "Resolve"]]) {
      expect(PAGE_HTML).toMatch(new RegExp(`<button id="${id}" type="button"[^>]*>${label}( <kbd[^>]*></kbd>)?</button>`));
    }
    // Not a <form>: the CSP's form-action 'none' would refuse a submit, and
    // Enter in a field must never try one.
    expect(PAGE_HTML).not.toMatch(/<form/);
  });

  it("pushes the board left while open, rather than covering it", () => {
    expect(APP_JS).toContain('document.body.classList.toggle("sm:pr-[28rem]", open && !panelWide)');
  });

  it("polls every 1.5s", () => {
    expect(APP_JS).toContain("const PANEL_POLL_MS = 1500;");
  });

  // The script is a template literal: a `\d` or a stray `${` in it is a
  // page that never runs, and nothing else here reads the whole of it.
  it("leaves a page script that parses, whole", () => {
    expect(() => new Script(APP_JS)).not.toThrow();
  });
});

describe("the item panel's address", () => {
  const itemOfHash = (hash: string): unknown => (runInNewContext(`${fnSource("routeOf")} routeOf(HASH)`, { HASH: hash }) as { item: string | null }).item;

  it("keeps reading the legacy #item=<id>, so an old bookmark or notification still opens the panel", () => {
    expect(itemOfHash("#item=12")).toBe("12");
    expect(itemOfHash("#item=PROJ-7")).toBe("PROJ-7");
    expect(itemOfHash("#/w/main?item=12")).toBe("12");
  });

  it("reads nothing from any other hash, or a malformed one", () => {
    expect(itemOfHash("")).toBeNull();
    expect(itemOfHash("#items")).toBeNull();
    expect(itemOfHash("#item=")).toBeNull();
    expect(itemOfHash("#item=%E0")).toBeNull();
  });

  it("finds an item anywhere in the tree", () => {
    const rows = [{ id: "1", children: [{ id: "2", children: [{ id: "3", children: [] }] }] }];
    const find = (id: string): unknown => runInNewContext(`${fnSource("findRow")} findRow(ROWS, ID)`, { ROWS: rows, ID: id });
    expect(find("3")).toEqual({ id: "3", children: [] });
    expect(find("9")).toBeNull();
  });

  it("opens on a row click by pushing the hash, so Back closes it", () => {
    expect(APP_JS).toContain('window.addEventListener("hashchange", onHashChange);');
    expect(fnSource("onHashChange")).toContain("showPanel(routeOf(location.hash).item)");
  });

  it("opens only from an item row with panel paths, and never from its links, toggle or menu", () => {
    const src = fnSource("itemRowFor");
    expect(src).toMatch(/if \(row\.panel\)/);
    expect(src).toContain('closest("a, button, [role=menu]")');
    expect(fnSource("artifactRowFor")).not.toContain("openPanel");
  });
});

describe("the Escape key and the panel", () => {
  const run = (opts: { menuOpen: boolean; panelId: string | null }) => {
    const seen = { menus: 0, panels: 0 };
    runInNewContext(`${fnSource("isTypingTarget")}${fnSource("onKeydown")}onKeydown({ key: "Escape" })`, {
      openMenuKey: opts.menuOpen ? "19:menu" : null, panelId: opts.panelId,
      closeMenu: () => { seen.menus++; }, closePanel: () => { seen.panels++; },
      resetIdleTimer: () => {}, toggleAll: { click: () => {} }, document: { activeElement: null },
    });
    return seen;
  };

  it("closes an open row menu first, and leaves the panel open", () => {
    expect(run({ menuOpen: true, panelId: "12" })).toEqual({ menus: 1, panels: 0 });
  });

  it("closes the panel when no menu is open", () => {
    expect(run({ menuOpen: false, panelId: "12" })).toEqual({ menus: 0, panels: 1 });
  });
});

describe("the item panel's facts", () => {
  const facts = (row: object): Record<string, string> => {
    const [, dl] = runInNewContext(`${["el", "relatedOf", "panelTopOf"].map(fnSource).join("")} panelTopOf(ROW, null, 0)`, {
      ROW: { id: "12", link: "", badge: null, screened: false, stage: "build", round: 2, createdAt: null, since: null, children: [], related: [], ...row },
      document: fakeDocument,
    }) as FakeElement[];
    const cells = dl?.children ?? [];
    return Object.fromEntries(cells.filter((_, i) => i % 2 === 0).map((dt, i) => [dt.text, cells[2 * i + 1]?.text ?? ""]));
  };

  it("names the running step's effort beside its model", () => {
    expect(facts({ model: "opus", effort: "high" })).toMatchObject({ Model: "opus", Effort: "high" });
  });

  it("draws a dash for a step that named no effort, as for no model", () => {
    expect(facts({ model: null, effort: null })).toMatchObject({ Model: "—", Effort: "—" });
  });
});

/*
 * Every relationship the item has, as the board row carries it: the other
 * item's number and title — text, whoever wrote it — its link where the
 * server gave one, and its state.
 */
describe("the item panel's relationships", () => {
  const draw = (related: object[]): FakeElement[] =>
    runInNewContext(`${["el", "panelLink", "relatedOf"].map(fnSource).join("")} relatedOf(RELATED)`, {
      RELATED: related, document: fakeDocument,
    }) as FakeElement[];

  it("lists each related item under Related, by type and way, number, title and state", () => {
    const [head, list] = draw([
      { type: "blocked-by", dir: "out", id: "10", title: "Auth", link: "https://x/10", state: "open" },
      { type: "x", dir: "in", id: "13", title: "<b>Later</b>", link: "", state: "dropped" },
    ]);
    expect(head?.text).toBe("Related");
    expect(list?.children.map((li) => li.children.map((c) => c.textContent))).toEqual([
      ["blocked-by →", "#10 Auth", "open"],
      ["x ←", "#13 <b>Later</b>", "dropped"],
    ]);
    const anchors = descendants(list as FakeElement).filter((e) => e.tag === "a");
    expect(anchors.map((a) => [a.href, a.target, a.textContent])).toEqual([["https://x/10", "_blank", "#10 Auth"]]);
  });

  it("draws text only, never markup", () => {
    expect(fnSource("relatedOf")).not.toMatch(/innerHTML|insertAdjacentHTML/);
  });

  it("draws nothing for an item nothing relates to", () => {
    expect(draw([])).toEqual([]);
  });

  it("is drawn in the panel's top half", () => {
    expect(fnSource("panelTopOf")).toContain("relatedOf(row.related)");
  });
});

describe("the item panel's live lines", () => {
  const lines = [{ kind: "tool", text: "Read a.ts", at: 1 }, { kind: "message", text: "Looks fine", at: 2 }];

  it("says which bottom an item gets from its badge", () => {
    const modeOf = (badge: string | null): unknown => runInNewContext(`${fnSource("modeOf")} modeOf(ROW)`, { ROW: { badge } });
    expect(modeOf("running")).toBe("running");
    expect(modeOf("needs-you")).toBe("needs-you");
    expect(modeOf("elsewhere")).toBe("elsewhere");
    expect(["waiting", "discharged", "not-admitted", null].map(modeOf)).toEqual(["other", "other", "other", "other"]);
  });

  // An Ask through `landrace mcp` holds the item from another process —
  // the reason activity is kept on disk at all — so it is read live too.
  it("keeps reading while an agent runs here or in another process, and not otherwise", () => {
    const live = (mode: string): unknown => runInNewContext(`${fnSource("readsLive")} readsLive(MODE)`, { MODE: mode });
    expect(["running", "elsewhere", "needs-you", "other"].map(live)).toEqual([true, true, false, false]);
  });

  it("reads a new run from its start at once, not a poll later", async () => {
    const asked: number[] = [];
    const line = { kind: "tool", text: "Read new.ts", at: 9 };
    const context: Record<string, unknown> = {
      panelId: "12", activity: { stage: "build", round: 1, lines: [{ kind: "tool", text: "Read old.ts", at: 1 }] },
      currentRow: () => ({ id: "12", panel: { activity: "/items/12/activity" } }),
      renderPanel: () => {},
      fetch: (url: string) => {
        const after = Number(url.split("after=")[1]);
        asked.push(after);
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ stage: "build", round: 2, lines: [line].slice(after), total: 1 }) });
      },
    };
    await runInNewContext(`${fnSource("mergeActivity")}${fnSource("readActivity")} readActivity()`, context);
    expect(asked).toEqual([1, 0]);
    expect(context.activity).toEqual({ stage: "build", round: 2, lines: [line] });
  });

  it("shows only the run the row is on now, never an earlier stage's or round's", () => {
    const live = (held: object, row: object): unknown => runInNewContext(`${fnSource("liveLines")} liveLines(HELD, ROW)`, { HELD: held, ROW: row });
    expect(live({ stage: "build", round: 2, lines }, { stage: "build", round: 2 })).toEqual(lines);
    expect(live({ stage: "build", round: 1, lines }, { stage: "build", round: 2 })).toEqual([]);
    expect(live({ stage: "spec", round: 2, lines }, { stage: "build", round: 2 })).toEqual([]);
  });

  describe("reading on from where it was", () => {
    const merge = (held: object, page: object, after: number): unknown =>
      runInNewContext(`${fnSource("mergeActivity")} mergeActivity(HELD, PAGE, AFTER)`, { HELD: held, PAGE: page, AFTER: after });
    const [first, second] = lines;

    it("adds what is new to the run it holds", () => {
      expect(merge({ stage: "build", round: 2, lines: [first] }, { stage: "build", round: 2, lines: [second], total: 2 }, 1))
        .toEqual({ stage: "build", round: 2, lines });
    });

    it("takes a run whole when it held nothing", () => {
      expect(merge({ stage: null, round: null, lines: [] }, { stage: "build", round: 2, lines, total: 2 }, 0))
        .toEqual({ stage: "build", round: 2, lines });
    });

    it("lets go of a run that is no longer the one written, so the next read takes the new one from its start", () => {
      expect(merge({ stage: "build", round: 1, lines: [first] }, { stage: "build", round: 2, lines: [], total: 1 }, 1))
        .toEqual({ stage: null, round: null, lines: [] });
      expect(merge({ stage: "build", round: 2, lines: [first, second] }, { stage: "build", round: 2, lines: [], total: 1 }, 2))
        .toEqual({ stage: null, round: null, lines: [] });
    });
  });

  it("counts as an Ask's progress only what was said since it was asked", () => {
    const progress = runInNewContext(`${fnSource("progressLines")} progressLines(LINES, 2000)`, {
      LINES: [{ kind: "tool", text: "old", at: 500 }, { kind: "tool", text: "new", at: 1800 }, { kind: "tool", text: "newer", at: 2600 }],
    }) as Array<{ text: string }>;
    expect(progress.map((l) => l.text)).toEqual(["new", "newer"]);
  });
});

describe("the item panel's bottom half", () => {
  const LINES = [{ kind: "tool", text: "Read a.ts", at: 1 }];
  const CONVERSATION = [
    { at: "2026-01-01T00:00:00Z", by: "landrace", byAgent: true, kind: "output", stage: "spec", round: 1, text: "Which markets?" },
    { at: "2026-01-01T00:01:00Z", by: "yiftahb", byAgent: false, kind: "human", stage: "-", round: 0, text: "EU only" },
  ];
  const state = (over: object = {}) => ({
    activity: { stage: "build", round: 2, lines: LINES }, conversation: { lines: CONVERSATION, error: "" },
    asking: null, answer: null, ...over,
  });
  const bottom = (row: object, mode: string, st: object): string[] =>
    (runInNewContext(`
      ${["el", "ago", "agoLabel", "liveLines", "progressLines", "activityItem", "conversationItem", "panelNote", "panelBottomOf"].map(fnSource).join("")}
      panelBottomOf(ROW, MODE, STATE, Date.parse("2026-01-01T00:05:00Z"))`,
    { document: fakeDocument, ROW: row, MODE: mode, STATE: st }) as FakeElement[]).map((e) => e.textContent);

  it("shows a running step's lines", () => {
    expect(bottom({ stage: "build", round: 2 }, "running", state()).join("\n")).toContain("Read a.ts");
  });

  it("says so when the agent reports nothing — an executor without onActivity", () => {
    expect(bottom({ stage: "build", round: 2 }, "running", state({ activity: { stage: null, round: null, lines: [] } })))
      .toEqual(["no live activity for this agent"]);
    expect(bottom({ stage: "build", round: 3 }, "running", state())).toEqual(["no live activity for this agent"]);
  });

  it("shows the conversation so far, who said it and the stage it was said in", () => {
    const text = bottom({ stage: "spec" }, "other", state()).join("\n");
    expect(text).toMatch(/landrace[\s\S]*spec r1[\s\S]*Which markets\?/);
    expect(text).toMatch(/yiftahb[\s\S]*EU only/);
  });

  it("says it is still reading the conversation, or that it could not", () => {
    expect(bottom({}, "other", state({ conversation: { lines: null, error: "" } }))).toEqual(["Reading the conversation…"]);
    expect(bottom({}, "other", state({ conversation: { lines: null, error: "could not read the conversation" } })))
      .toEqual(["could not read the conversation"]);
  });

  it("shows what another process's agent has done since the conversation's last word", () => {
    const st = state({ activity: { stage: "spec", round: 1, lines: [
      { kind: "tool", text: "Read step-era.ts", at: Date.parse("2026-01-01T00:00:30Z") },
      { kind: "tool", text: "Read ask-era.ts", at: Date.parse("2026-01-01T00:02:00Z") },
    ] } });
    const text = bottom({}, "elsewhere", st).join("\n");
    expect(text).toMatch(/EU only[\s\S]*Another process holds this item[\s\S]*Read ask-era\.ts/);
    expect(text).not.toContain("Read step-era.ts");
    expect(bottom({}, "elsewhere", state({ activity: { stage: null, round: null, lines: [] } })).join("\n"))
      .toMatch(/Another process holds this item; its agent has reported nothing yet/);
  });

  it("shows an Ask's progress under the conversation while it runs, then the step's answer", () => {
    const asking = bottom({}, "needs-you", state({ asking: { since: 0 } })).join("\n");
    expect(asking).toMatch(/EU only[\s\S]*Asking the step…[\s\S]*Read a\.ts/);
    const answered = bottom({}, "needs-you", state({ answer: { reply: "EU it is.", resolved: true } })).join("\n");
    expect(answered).toMatch(/EU it is\.[\s\S]*has what it needs/);
  });
});

// A poll every 1.5s that redrew the same text wiped any selection in it —
// copying the step's question lost it within seconds.
describe("redrawing the item panel", () => {
  const draws = (texts: string[][]) => {
    let replaced = 0;
    const target = { dataset: {} as Record<string, string>, replaceChildren: () => { replaced++; } };
    for (const t of texts) {
      runInNewContext(`${fnSource("replaceIfChanged")} replaceIfChanged(TARGET, NODES)`, {
        TARGET: target, NODES: t.map((text) => ({ textContent: text })),
      });
    }
    return replaced;
  };

  it("leaves what is on screen alone while its text is the same", () => {
    expect(draws([["Which markets?", "EU only"], ["Which markets?", "EU only"]])).toBe(1);
  });

  it("redraws once the text changes", () => {
    expect(draws([["Which markets?"], ["Which markets?", "EU only"], ["Which markets?"]])).toBe(3);
  });
});

describe("the item panel's writes", () => {
  class Box { value = ""; }
  const ROW = { id: "12", panel: { reply: "/items/12/reply", ask: "/items/12/ask", resolve: "/items/12/resolve" } };
  const OK: Record<string, string> = { ask: '{"reply":"EU it is.","resolved":true}', resolve: '{"alreadyResolved":false}', reply: "posted" };

  const write = async (kind: string, world: {
    text?: string; confirm?: boolean; response?: { ok: boolean; text: string } | "down";
    /** The person closes the panel while the post is in flight. */
    closes?: boolean;
  } = {}) => {
    const seen = { confirms: [] as string[], posts: [] as Array<[string, unknown]>, notes: [] as string[], conversations: 0, polls: [] as number[], moved: [] as string[] };
    const box = new Box();
    box.value = world.text ?? "EU only";
    const context: Record<string, unknown> = {
      KIND: kind, messageBox: box, panelId: "12", panelHeld: "12", panelBusy: false, asking: null, askAnswer: null, seen,
      currentRow: () => ROW,
      confirm: (t: string) => { seen.confirms.push(t); return world.confirm ?? true; },
      fetch: (url: string, init: unknown) => {
        seen.posts.push([url, init]);
        if (world.closes) context.panelId = null;
        const answer = world.response ?? { ok: true, text: OK[kind] ?? "" };
        return answer === "down" ? Promise.reject(new TypeError("fetch failed")) : Promise.resolve({ ok: answer.ok, text: () => Promise.resolve(answer.text) });
      },
      setPanelNote: (t: string) => { seen.notes.push(t); },
      syncComposer: () => {}, renderPanel: () => {}, pollPanel: () => {},
      loadConversation: () => { seen.conversations++; },
      schedulePoll: (ms: number) => { seen.polls.push(ms); },
      moved: (id: string) => { seen.moved.push(id); },
    };
    runInNewContext(`${fnSource("parseJson")}${fnSource("panelWrite")} panelWrite(KIND)`, context);
    await new Promise((r) => setTimeout(r, 0));
    return { seen, box, context };
  };

  it("posts a reply with the page's own header, then reads the conversation again", async () => {
    const { seen, box } = await write("reply");
    expect(seen.confirms).toEqual([]);
    expect(seen.posts).toEqual([["/items/12/reply", {
      method: "POST", headers: { "x-landrace-action": "reply", "content-type": "text/plain;charset=UTF-8" }, body: "EU only",
    }]]);
    expect(box.value).toBe("");
    expect(seen.conversations).toBe(1);
  });

  it("asks before an Ask, since it runs a paid turn, and posts nothing when told no", async () => {
    const { seen } = await write("ask", { confirm: false });
    expect(seen.confirms[0]).toMatch(/#12[\s\S]*paid/);
    expect(seen.posts).toEqual([]);
  });

  it("answers an Ask inline, from what the server said", async () => {
    const { seen, context } = await write("ask");
    expect(seen.posts[0]?.[0]).toBe("/items/12/ask");
    expect(context.askAnswer).toEqual({ reply: "EU it is.", resolved: true });
    expect(seen.polls).toEqual([0]);
  });

  // Escape or Back during a minutes-long Ask is the natural thing to do; the
  // answer still belongs to the item, and reopening it shows it rather
  // than "Asking the step…" for good — an invitation to pay for a second.
  it("keeps an Ask's answer for its item when the panel was closed while it ran", async () => {
    const { seen, box, context } = await write("ask", { closes: true });
    expect(context.askAnswer).toEqual({ reply: "EU it is.", resolved: true });
    expect(context.panelBusy).toBe(false);
    expect(context.asking).toBeNull();
    expect(seen.notes.at(-1)).toBe("");
    expect(box.value).toBe("");
  });

  it("says a refused Ask's reason for its item even when the panel was closed", async () => {
    const { seen } = await write("ask", { closes: true, response: { ok: false, text: "screening blocked this turn" } });
    expect(seen.notes.at(-1)).toBe("screening blocked this turn");
  });

  it("resolves without a message and without asking", async () => {
    const { seen } = await write("resolve", { text: "" });
    expect(seen.confirms).toEqual([]);
    expect(seen.posts[0]?.[0]).toBe("/items/12/resolve");
    expect(seen.notes.at(-1)).toMatch(/Handed back/);
  });

  it("sends nothing for an empty reply or question", async () => {
    expect((await write("reply", { text: "  " })).seen.posts).toEqual([]);
    expect((await write("ask", { text: "" })).seen.posts).toEqual([]);
  });

  it("keeps the words and says what the server said when it refuses", async () => {
    const { seen, box } = await write("ask", { response: { ok: false, text: "cannot ask: #12 has no session to join yet" } });
    expect(seen.notes.at(-1)).toBe("cannot ask: #12 has no session to join yet");
    expect(box.value).toBe("EU only");
  });

  it("says landrace is not responding when the post never lands", async () => {
    const { seen } = await write("reply", { response: "down" });
    expect(seen.notes.at(-1)).toMatch(/not responding/);
  });

  // A Reply or a Resolve hands the item on; an Ask is a turn beside it and moves nothing.
  it("marks the item moving after a Reply or a Resolve the server took, even from another item's panel", async () => {
    expect((await write("reply")).seen.moved).toEqual(["12"]);
    expect((await write("resolve", { text: "", closes: true })).seen.moved).toEqual(["12"]);
    expect((await write("ask")).seen.moved).toEqual([]);
    expect((await write("reply", { response: { ok: false, text: "nope" } })).seen.moved).toEqual([]);
  });
});

/*
 * The lag between a click and the board moving: the server moves an item
 * only when a tick lists the tracker again, up to a whole interval later, and
 * a Reply wakes no tick at all. So the page shows it in Waiting until then.
 */
describe("an item a write just went through for", () => {
  type Move = { lane: string; next: number | null; ticks: number; at: number };
  const move = (lane: string): Move => ({ lane, next: 1000, ticks: 0, at: 5 });
  const view = (lane: string, nextTickAt: number | null = 1000) => ({
    nextTickAt,
    rows: [
      { id: "19", lane, badge: lane, note: "blocked: needs a human", since: 1, retry: "/items/19/retry", clear: "/items/19/clear", goto: [{ stage: "spec", path: "/items/19/goto/spec" }], children: [] },
      { id: "20", lane: "needs-you", badge: "needs-you", note: "waiting on you", since: 1, retry: null, clear: null, goto: [], children: [] },
    ],
  });
  type Drawn = ReturnType<typeof view>;
  const drawn = (v: Drawn, moves: Map<string, Move>): Drawn =>
    runInNewContext(`${fnSource("withMoves")} withMoves(VIEW, MOVES)`, { VIEW: v, MOVES: moves }) as Drawn;

  it("shows it in Waiting, with nothing left to click, while the server still has it where it was", () => {
    const moves = new Map([["19", move("needs-you")]]);
    const [sent, other] = drawn(view("needs-you"), moves).rows;
    expect(sent).toMatchObject({ id: "19", lane: "waiting", badge: "waiting", since: 5, retry: null, clear: null });
    expect(sent?.goto).toHaveLength(0);
    expect(sent?.note).toMatch(/next tick/);
    expect(other).toMatchObject({ id: "20", lane: "needs-you", badge: "needs-you" });
  });

  it("lets go once the server moves it, and draws the server's own row", () => {
    const moves = new Map([["19", move("needs-you")]]);
    expect(drawn(view("running"), moves).rows[0]).toMatchObject({ lane: "running", retry: "/items/19/retry" });
    expect(moves.size).toBe(0);
  });

  // A tick came and went and nothing moved it: the server's word stands again.
  it("lets go once two ticks have been armed since, moved or not", () => {
    const moves = new Map([["19", move("needs-you")]]);
    expect(drawn(view("needs-you", 2000), moves).rows[0]?.lane).toBe("waiting");
    expect(drawn(view("needs-you", 3000), moves).rows[0]?.lane).toBe("needs-you");
    expect(moves.size).toBe(0);
  });

  it("lets go of an item gone from the board, and of any once no tick is scheduled", () => {
    const gone = new Map([["7", move("needs-you")]]);
    drawn(view("needs-you"), gone);
    expect(gone.size).toBe(0);
    const stopped = new Map([["19", move("needs-you")]]);
    expect(drawn(view("needs-you", null), stopped).rows[0]?.lane).toBe("needs-you");
    expect(stopped.size).toBe(0);
  });

  it("remembers where the server had it and when, and only on a board a tick will move", () => {
    const remember = (v: Drawn) => {
      const moves = new Map<string, Move>();
      runInNewContext(`${fnSource("moved")} moved("19"); moved("7");`, { lastView: v, moves, Date: { now: () => 5 } });
      return [...moves];
    };
    expect(remember(view("needs-you"))).toEqual([["19", { lane: "needs-you", next: 1000, ticks: 0, at: 5 }]]);
    expect(remember(view("needs-you", null))).toEqual([]);
  });
});

describe("the composer's Reply", () => {
  it("shows its shortcut on the button: ⌘↵ on a Mac, Ctrl ↵ elsewhere", () => {
    const label = (platform: string) => runInNewContext(`${fnSource("shortcutLabel")} shortcutLabel(P)`, { P: platform });
    expect([label("MacIntel"), label("macOS"), label("iPad")]).toEqual(["⌘↵", "⌘↵", "⌘↵"]);
    expect([label("Win32"), label("Windows"), label("Linux x86_64"), label("")]).toEqual(["Ctrl ↵", "Ctrl ↵", "Ctrl ↵", "Ctrl ↵"]);
    expect(PAGE_HTML).toMatch(/<button id="panel-reply"[^>]*>Reply <kbd id="panel-reply-keys" aria-hidden="true"[^>]*><\/kbd><\/button>/);
    expect(APP_JS).toContain('document.getElementById("panel-reply-keys").textContent = shortcutLabel(');
  });

  it("is the one filled, blue button, and says its shortcut", () => {
    const reply = /<button id="panel-reply"[^>]*>/.exec(PAGE_HTML)?.[0] ?? "";
    expect(reply).toMatch(/\bbg-blue-600\b/);
    expect(reply).toMatch(/\btext-white\b/);
    expect(reply).not.toMatch(/\bborder\b/);
    expect(reply).toContain('aria-keyshortcuts="Control+Enter Meta+Enter"');
    expect(/<button id="panel-ask"[^>]*>/.exec(PAGE_HTML)?.[0]).not.toMatch(/bg-blue-600/);
  });

  const press = (e: { key: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }) => {
    const seen = { writes: [] as string[], prevented: 0 };
    runInNewContext(`${fnSource("onMessageKey")} onMessageKey(EVENT)`, {
      EVENT: { ctrlKey: false, metaKey: false, shiftKey: false, ...e, preventDefault: () => { seen.prevented++; } },
      panelWrite: (kind: string) => { seen.writes.push(kind); },
    });
    return seen;
  };

  it("is sent by Ctrl+Enter or ⌘+Enter from the message box", () => {
    expect(press({ key: "Enter", ctrlKey: true })).toEqual({ writes: ["reply"], prevented: 1 });
    expect(press({ key: "Enter", metaKey: true })).toEqual({ writes: ["reply"], prevented: 1 });
    expect(APP_JS).toContain('messageBox.addEventListener("keydown", onMessageKey);');
  });

  it("leaves a plain or Shift+Enter a new line", () => {
    expect(press({ key: "Enter" })).toEqual({ writes: [], prevented: 0 });
    expect(press({ key: "Enter", shiftKey: true })).toEqual({ writes: [], prevented: 0 });
  });
});

/*
 * A read the server declines — an item two workflows claim, a closed id two
 * trackers list — comes back 409 with its own sentence, which says why far
 * better than a fixed line; anything else keeps the fixed one.
 */
describe("the panel's reads, when the server declines them", () => {
  const read = async (fn: "loadConversation" | "loadPairing", status: number, body: string) => {
    const context: Record<string, unknown> = {
      panelId: "4", conversation: { lines: null, error: "" }, pairing: { view: null, error: "", command: null },
      currentRow: () => ({ id: "4", panel: { conversation: "/items/4/conversation", pairing: "/items/4/pairing" } }),
      fetch: () => Promise.resolve({ ok: false, status, text: () => Promise.resolve(body), json: () => Promise.reject(new Error("not json")) }),
      renderPanel: () => {},
    };
    runInNewContext(`${fnSource("refusalOf")}${fnSource(fn)} ${fn}()`, context);
    await new Promise((r) => setTimeout(r, 0));
    return context;
  };
  const SAID = "#4 is claimed by fast and main; act on it after one workflow alone claims it";

  it("shows the server's sentence for the conversation it refused", async () => {
    expect(((await read("loadConversation", 409, SAID)).conversation as { error: string }).error).toBe(SAID);
    expect(((await read("loadConversation", 502, "upstream")).conversation as { error: string }).error).toBe("could not read the conversation");
  });

  it("shows the server's sentence for the pairing read it refused", async () => {
    expect(((await read("loadPairing", 409, SAID)).pairing as { error: string }).error).toBe(SAID);
    expect(((await read("loadPairing", 502, "upstream")).pairing as { error: string }).error).toBe("could not read what may be paired on");
  });
});

/*
 * The composer writes, so it is offered only where the server put write
 * paths: on an item waiting on you that one workflow owns.
 */
describe("the panel's composer", () => {
  const shown = (row: object, mode: string): boolean =>
    runInNewContext(`${fnSource("composerShown")} composerShown(ROW, MODE)`, { ROW: row, MODE: mode }) as boolean;

  it("is shown on an item waiting on you that it may write to, and not on one it may only read", () => {
    expect(shown({ panel: { reply: "/items/1/reply" } }, "needs-you")).toBe(true);
    expect(shown({ panel: { reply: null } }, "needs-you")).toBe(false);
    expect(shown({ panel: { reply: "/items/1/reply" } }, "other")).toBe(false);
  });
});

/*
 * The panel's Pairing section: built from the server's answer and the
 * panel's own state, and nothing the page puts together itself.
 */
describe("the panel's Pairing section", () => {
  class Clickable extends FakeElement {
    disabled = false;
    listeners = new Map<string, () => void>();
    override addEventListener(type?: string, f?: () => void): void { if (type && f) this.listeners.set(type, f); }
  }
  const doc = { createElement: (tag: string) => new Clickable(tag), createElementNS: (_: string, tag: string) => new Clickable(tag) };
  const section = (view: object | null, state: object = {}, row: object = {}) => {
    const seen: unknown[][] = [];
    const nodes = runInNewContext(
      `${["el", "panelNote", "offerLabel", "pairingSectionOf"].map(fnSource).join("")} pairingSectionOf(ROW, VIEW, STATE)`,
      {
        ROW: { id: "29", panel: { pair: "/items/29/pair" }, ...row }, VIEW: view,
        STATE: { command: null, note: "", busy: false, error: "", ...state }, document: doc,
        pairWrite: (...a: unknown[]) => seen.push(["write", ...a]), copyCommand: () => seen.push(["copy"]),
      },
    ) as Clickable[];
    const buttons = nodes.flatMap(descendants).filter((n) => n.tag === "button") as Clickable[];
    const click = (label: string) => buttons.find((b) => b.textContent === label)?.listeners.get("click")?.();
    return { text: nodes.map((n) => n.textContent), buttons: buttons.map((b) => b.textContent), click, seen };
  };

  it("offers each step as the server named it, a fresh pairing or the agent's session continued", () => {
    const s = section({ open: null, offers: [{ stage: "spec", round: 2, continue: true }, { stage: "build", round: 1, continue: false }] });
    expect(s.buttons).toEqual(["Continue spec together", "Pair on build"]);
    s.click("Pair on build");
    expect(s.seen).toEqual([["write", "pair", "build"]]);
  });

  it("says so when there is nothing to pair on", () => {
    expect(section({ open: null, offers: [] }).text.join(" ")).toMatch(/Nothing to pair on/);
  });

  it("shows the open pairing, with its command once it has one, and Finish… and Release", () => {
    const open = { open: { stage: "spec", round: 2, n: 1, at: "2026-01-01T00:00:00Z" }, offers: [] };
    const before = section(open);
    expect(before.text.join(" ")).toMatch(/Pairing on spec, round 2/);
    expect(before.buttons).toEqual(["Get command", "Finish…", "Release"]);
    before.click("Get command");
    expect(before.seen).toEqual([["write", "pair", "spec"]]);

    const after = section(open, { command: "cd /w/29.pair && agent" });
    expect(after.text.join(" ")).toContain("cd /w/29.pair && agent");
    expect(after.buttons).toEqual(["Copy command", "Finish…", "Release"]);
    after.click("Copy command");
    after.click("Finish…");
    after.click("Release");
    expect(after.seen).toEqual([["copy"], ["write", "finish"], ["write", "release"]]);
  });

  it("disables its buttons while a write is in flight, and shows what the server said", () => {
    const s = section({ open: null, offers: [{ stage: "spec", round: 1, continue: false }] }, { busy: true, note: "#29 is busy" });
    expect(s.text.join(" ")).toContain("#29 is busy");
    const b = runInNewContext(
      `${["el", "panelNote", "offerLabel", "pairingSectionOf"].map(fnSource).join("")} pairingSectionOf(ROW, VIEW, STATE)`,
      {
        ROW: { id: "29", panel: { pair: "/items/29/pair" } }, VIEW: { open: null, offers: [{ stage: "spec", round: 1, continue: false }] },
        STATE: { busy: true, note: "" }, document: doc,
      },
    ) as Clickable[];
    expect((b.flatMap(descendants).find((n) => n.tag === "button") as Clickable).disabled).toBe(true);
  });

  it("reads while it waits on the server's answer", () => {
    expect(section(null).text.join(" ")).toMatch(/Reading what may be paired on/);
  });

  // A closed item, or one no one workflow owns, carries no write paths: the
  // section says what is open, and offers nothing to do about it.
  it("offers no button on an item whose panel only reads", () => {
    const readOnly = { panel: { pair: null, finish: null, release: null } };
    const open = section({ open: { stage: "spec", round: 2, n: 1, at: "2026-01-01T00:00:00Z" }, offers: [] }, {}, readOnly);
    expect(open.text.join(" ")).toMatch(/Pairing on spec, round 2/);
    expect(open.buttons).toEqual([]);
    expect(section({ open: null, offers: [{ stage: "spec", round: 1, continue: false }] }, {}, readOnly).buttons).toEqual([]);
  });
});

/*
 * A pairing's command is right until it has been run: the seeded line then
 * refuses its own session id, and only the server's next answer resumes it.
 * So the panel hands it out once and asks again.
 */
describe("the pairing's command, once handed out", () => {
  const SEEDED = "cd /w/29.pair && claude 'seed' --session-id u";
  const run = async (source: string, clipboard?: object) => {
    const ctx = { navigator: { clipboard }, pairing: { shown: true, command: SEEDED, note: "" }, renderPanel: () => {}, loadPairing: () => {} };
    runInNewContext(`${fnSource(source)} ${source}()`, ctx);
    await new Promise((r) => setImmediate(r));
    return ctx.pairing;
  };

  it("is dropped once copied, so the section offers Get command again", async () => {
    const copied: string[] = [];
    const after = await run("copyCommand", { writeText: (t: string) => { copied.push(t); return Promise.resolve(); } });
    expect(copied).toEqual([SEEDED]);
    expect(after.command).toBeNull();
    expect(after.note).toMatch(/Copied/);
  });

  it("stays on screen to select when the copy fails", async () => {
    const after = await run("copyCommand");
    expect(after.command).toBe(SEEDED);
    expect(after.note).toMatch(/Could not copy/);
  });

  it("is dropped when the section is shut or opened again", async () => {
    expect((await run("togglePairing")).command).toBeNull();
  });
});

describe("an item row's Pairing… item", () => {
  class Listening extends FakeElement {
    listeners = new Map<string, () => void>();
    disabled = false;
    hidden = false;
    override addEventListener(type?: string, f?: () => void): void { if (type && f) this.listeners.set(type, f); }
  }
  const doc = { createElement: (tag: string) => new Listening(tag), createElementNS: (_: string, tag: string) => new Listening(tag) };
  const menuFor = (panel: object | null) => {
    const seen: unknown[][] = [];
    const menu = runInNewContext(`
      ${constSource("SVG_NS")}${blockSource("CHAT_TARGETS")}
      const writeNotes = new Map();
      const writing = new Set();
      ${["el", "luminance", "faintOnDark", "markSvg", "chatIcon", "menuItem", "writeItem", "send", "writesOf", "buildRowMenu"].map(fnSource).join("")}
      buildRowMenu(ROW)`, {
      ROW: { id: "19", chat: { prompt: "p", links: { claude: "a:", claudeCli: "b:", cursor: "c:", codex: "d:" } }, retry: null, goto: [], panel },
      document: doc, navigator: {}, lastView: {},
      closeMenu: () => seen.push(["close"]), openPairing: (id: string) => seen.push(["pairing", id]),
    }) as Listening;
    return { menu, seen };
  };

  it("comes first on an item with a panel, and opens its Pairing section", () => {
    const { menu, seen } = menuFor({ pairing: "/items/19/pairing" });
    expect(menu.children.slice(0, 2).map((c) => (c.tag === "hr" ? "—" : c.textContent))).toEqual(["Pairing…", "—"]);
    (menu.children[0] as Listening).listeners.get("click")?.();
    expect(seen).toEqual([["close"], ["pairing", "19"]]);
  });

  it("is not offered on a row with no panel", () => {
    expect(menuFor(null).menu.children[0]?.textContent).toBe("Chat");
  });
});

/**
 * The 🔔: with it on and the browser's leave, an item that has just come to
 * need you — since the last poll, never on the first — raises one system
 * notification, and a click on it opens that item's panel.
 */
describe("the notify bell", () => {
  it("sits in the header, wired in script", () => {
    const header = /<header[^>]*>[\s\S]*?<\/header>/.exec(PAGE_HTML)?.[0] ?? "";
    expect(header).toContain('id="notify-toggle"');
    expect(APP_JS).toContain('getElementById("notify-toggle")');
  });

  it("guards every localStorage access, as the theme's does", () => {
    expect(APP_JS).toMatch(/try\s*{[^}]*localStorage\.getItem\(NOTIFY_KEY\)[^}]*}\s*catch/s);
    expect(APP_JS).toMatch(/try\s*{[^}]*localStorage\.setItem\(NOTIFY_KEY[^}]*}\s*catch/s);
  });

  it("is asked after every poll that landed", () => {
    expect(fnSource("pollOnce")).toMatch(/bellStep\(lastView, neededYou\)/);
  });

  describe("the bell before the first listing", () => {
    type Row = { id: string; badge: string | null; stale: boolean; children: Row[] };
    const row = (id: string, badge: string | null): Row => ({ id, badge, stale: false, children: [] });
    /** What each poll in turn announces, carried the way pollOnce carries it. */
    const steps = (...views: Array<{ listed: boolean; rows: Row[] }>): string[][] =>
      runInNewContext(
        `${fnSource("viewListed")}${fnSource("needingYou")}${fnSource("arrived")}${fnSource("bellStep")}
         let before = null;
         const out = [];
         for (const view of VIEWS) {
           const step = bellStep(view, before);
           out.push(step.arrived.map((r) => r.id));
           before = step.now;
         }
         out`,
        { VIEWS: views },
      ) as string[][];
    const unlisted = { listed: false, rows: [] };
    const listed = (rows: Row[]) => ({ listed: true, rows });

    it("does not seed from a view nothing has listed yet, so a restart announces nothing already waiting", () => {
      expect(steps(unlisted, listed([row("1", "needs-you")]))).toEqual([[], []]);
    });

    it("announces what arrives after the first listing", () => {
      expect(steps(unlisted, listed([]), listed([row("1", "needs-you")]))).toEqual([[], [], ["1"]]);
    });

    it("counts a view as listed only when it says so", () => {
      const listedOf = (view: unknown): boolean => {
        const c: Record<string, unknown> = { view };
        runInNewContext(fnSource("viewListed"), c);
        return runInNewContext("viewListed(view)", c) as boolean;
      };
      expect([listedOf(null), listedOf({ listed: false }), listedOf({ listed: true })]).toEqual([false, false, true]);
    });
  });

  describe("which items have just come to need you", () => {
    type Row = { id: string; badge: string | null; stale: boolean; children: Row[] };
    const row = (id: string, badge: string | null, children: Row[] = [], stale = false): Row => ({ id, badge, stale, children });
    /** What each poll in turn announces, the way pollOnce carries one poll's answer into the next. */
    const polls = (...boards: Row[][]): string[][] =>
      runInNewContext(
        `${fnSource("needingYou")}${fnSource("arrived")}
         let before = null;
         const out = [];
         for (const rows of BOARDS) {
           const now = needingYou(rows, new Map(), before);
           out.push(arrived(before, now).map((r) => r.id));
           before = now;
         }
         out`,
        { BOARDS: boards },
      ) as string[][];

    const board = [row("1", "needs-you", [row("3", "needs-you")]), row("2", "running")];

    it("finds none on the first poll, which only seeds", () => {
      expect(polls(board)).toEqual([[]]);
    });

    it("finds an item newly badged needs-you, a child as well as a root", () => {
      expect(polls([row("1", "waiting", [row("3", "running")]), row("2", "running")], board)).toEqual([[], ["1", "3"]]);
    });

    it("finds none for an item that stays", () => {
      expect(polls(board, board)).toEqual([[], []]);
    });

    it("finds one again that left and came back", () => {
      const left = [row("1", "running", [row("3", "needs-you")]), row("2", "running")];
      expect(polls(board, left, board)).toEqual([[], [], ["1"]]);
    });

    // A conversation turn from the editor, or a pairing, holds the item's
    // lock: the board badges it elsewhere meanwhile, but it never left you.
    it("finds none for an item only held elsewhere a while, which never left", () => {
      const held = [row("1", "elsewhere", [row("3", "needs-you")]), row("2", "running")];
      expect(polls(board, held, held, board)).toEqual([[], [], [], []]);
    });

    it("still finds an item held elsewhere before it ever needed you", () => {
      expect(polls([row("1", "elsewhere")], [row("1", "needs-you")])).toEqual([[], ["1"]]);
    });

    // Between triage's step and the next list, a spec approval heading into
    // build still reads needs-you from the labels it is leaving.
    it("finds none for an item only passing through a step, while its labels are stale", () => {
      const running = [row("1", "running")];
      const stale = [row("1", "needs-you", [], true)];
      expect(polls([row("1", "needs-you")], running, stale, stale, running)).toEqual([[], [], [], [], []]);
    });

    it("finds one that came back once a fresh list says so", () => {
      expect(polls([row("1", "needs-you")], [row("1", "running")], [row("1", "needs-you", [], true)], [row("1", "needs-you")]))
        .toEqual([[], [], [], ["1"]]);
    });

    it("keeps one that needed you through stale labels, never announcing it again", () => {
      const stale = [row("1", "needs-you", [], true)];
      expect(polls([row("1", "needs-you")], stale, [row("1", "needs-you")])).toEqual([[], [], []]);
    });
  });

  describe("a notification", () => {
    const shown = (opts: { on: boolean; permission?: string }) => {
      const made: Array<{ title: string; body: string; tag: string; renotify: boolean; click?: () => void }> = [];
      const opened: string[] = [];
      class FakeNotification {
        static permission = opts.permission;
        constructor(title: string, o: { body: string; tag: string; renotify: boolean }) { made.push({ title, ...o }); }
        addEventListener(type: string, f: () => void): void { const last = made.at(-1); if (type === "click" && last) last.click = f; }
        close(): void {}
      }
      runInNewContext(`${fnSource("notifyOf")} notifyOf(ROW);`, {
        ROW: { id: "29", title: "Add export", note: "blocked by a security check" },
        notifyOn: opts.on,
        ...(opts.permission === undefined ? {} : { Notification: FakeNotification }),
        openPanel: (id: string) => opened.push(id),
        window: { focus: () => {} },
      });
      return { made, opened };
    };

    // renotify beside the tag: a return replaces the last one still listed
    // for that item, and has to alert again rather than swap in silently.
    it("is one per item, saying which and why, tagged by item, alerting again on a return", () => {
      expect(shown({ on: true, permission: "granted" }).made.map(({ title, body, tag, renotify }) => ({ title, body, tag, renotify }))).toEqual([
        { title: "#29 needs you", body: "Add export — blocked by a security check", tag: "landrace-29", renotify: true },
      ]);
    });

    it.each([
      ["the bell is off", { on: false, permission: "granted" }],
      ["the browser denied it", { on: true, permission: "denied" }],
      ["the browser has not been asked", { on: true, permission: "default" }],
      ["the browser has no notifications", { on: true }],
    ])("is not shown when %s", (_, opts) => {
      expect(shown(opts).made).toEqual([]);
    });

    it("opens the item's panel when clicked", () => {
      const { made, opened } = shown({ on: true, permission: "granted" });
      made[0]?.click?.();
      expect(opened).toEqual(["29"]);
    });
  });

  describe("what the bell says", () => {
    const state = (on: boolean, permission: string) =>
      runInNewContext(`${fnSource("bellState")} bellState(ON, PERMISSION)`, { ON: on, PERMISSION: permission }) as {
        icon: string; pressed: string; label: string;
      };

    it("says so when the browser has blocked notifications, whatever the toggle", () => {
      for (const on of [true, false]) {
        expect(state(on, "denied")).toEqual(expect.objectContaining({ icon: "🔕", pressed: "false", label: expect.stringMatching(/blocked/) }));
      }
      expect(state(true, "unsupported").label).toMatch(/this browser/);
    });

    it("is pressed only when on and allowed", () => {
      expect([state(true, "granted").pressed, state(false, "granted").pressed, state(true, "default").pressed])
        .toEqual(["true", "false", "false"]);
    });

    /*
     * Turned on, but the browser's prompt went unanswered: Arc anchors it to
     * a URL bar a hidden sidebar hides, and three went by unseen while the
     * bell read exactly as off. It says why nothing will arrive.
     */
    it("says the browser has not allowed it yet when turned on without an answer", () => {
      expect(state(true, "default")).toEqual(expect.objectContaining({ pressed: "false", label: expect.stringMatching(/not allowed[\s\S]*site settings[\s\S]*ask again/) }));
      expect(state(false, "default").label).toBe("Notify me when an item needs you");
    });

    // Toggled from what it shows: on, but with the browser's prompt dismissed,
    // it reads as off — and a click on it must turn it on and ask again, not
    // quietly turn off a bell that already looked off.
    it("turns on when clicked while it reads off, whatever was stored", () => {
      const next = (on: boolean, permission: string) =>
        runInNewContext(`${fnSource("bellState")}${fnSource("clickedBell")} clickedBell(ON, PERMISSION)`, { ON: on, PERMISSION: permission });
      expect([next(true, "default"), next(false, "granted"), next(true, "granted")]).toEqual([true, true, false]);
    });
  });

  /*
   * A page cannot ask again once the browser blocked it, and Chrome blocks a
   * site by itself after a few dismissed prompts, so a click that cannot get
   * notifications says why, on the page, beside the bell — never nothing.
   */
  describe("a click on the bell", () => {
    const BLOCKED = /blocked for this site[\s\S]*site settings \(the icon left of the address bar → Notifications → Allow\)[\s\S]*update by itself/;
    const UNANSWERED = /dismissed or blocked, or shown quietly in the address bar/;

    const decided = (on: boolean, permission: string) =>
      runInNewContext(`${["bellState", "clickedBell", "bellClick"].map(fnSource).join("")} bellClick(ON, PERMISSION)`, { ON: on, PERMISSION: permission }) as {
        on: boolean; ask: boolean;
      };
    const noted = (permission: string, asked: boolean) =>
      runInNewContext(`${fnSource("bellNote")} bellNote(PERMISSION, ASKED)`, { PERMISSION: permission, ASKED: asked }) as string;

    // The real click handler, against a browser whose permission starts at
    // `permission` (none: no Notification at all) and turns to `answer` once
    // asked. Its requestPermission resolves to nothing, so a handler that
    // trusted the promise's value over Notification.permission would fail.
    const clicked = async (opts: { on: boolean; permission?: string; answer?: string; refuses?: boolean }) => {
      let asked = 0;
      let synced = 0;
      const note = { textContent: "an earlier note" };
      class FakeNotification {
        static permission = opts.permission;
        static async requestPermission(): Promise<void> {
          asked++;
          if (opts.refuses) throw new Error("refused");
          if (opts.answer !== undefined) FakeNotification.permission = opts.answer;
        }
      }
      const context: Record<string, unknown> = {
        notifyOn: opts.on,
        NOTIFY_KEY: "landrace-notify",
        localStorage: { setItem: () => {} },
        bellNoteText: note,
        syncBell: () => { synced++; },
        ...(opts.permission === undefined ? {} : { Notification: FakeNotification }),
      };
      await runInNewContext(`${["bellState", "clickedBell", "bellClick", "bellNote", "permissionNow", "onBellClick"].map(fnSource).join("")} onBellClick()`, context);
      return { asked, on: context.notifyOn, says: note.textContent, synced };
    };

    it.each([
      [true, "granted", { on: false, ask: false }],
      [false, "granted", { on: true, ask: false }],
      [false, "default", { on: true, ask: true }],
      [true, "default", { on: true, ask: true }],
      [false, "denied", { on: true, ask: false }],
      [true, "denied", { on: true, ask: false }],
      [false, "unsupported", { on: true, ask: false }],
    ])("decides, on %s with the browser %s: %j", (on, permission, then) => {
      expect(decided(on, permission)).toEqual(then);
    });

    it.each([
      ["granted", false, /^$/],
      ["granted", true, /^$/],
      ["denied", false, BLOCKED],
      ["denied", true, UNANSWERED],
      ["default", true, UNANSWERED],
      ["unsupported", false, /cannot show notifications/],
    ])("notes, with the browser %s after a click that asked: %s, %s", (permission, asked, says) => {
      expect(noted(permission, asked)).toMatch(says);
    });

    it("turns it off when on and allowed, asking nothing and clearing the note", async () => {
      expect(await clicked({ on: true, permission: "granted" })).toEqual({ asked: 0, on: false, says: "", synced: 1 });
    });

    it("turns it on when off and allowed, asking nothing and saying nothing", async () => {
      expect(await clicked({ on: false, permission: "granted" })).toEqual({ asked: 0, on: true, says: "", synced: 1 });
    });

    it("asks when the browser has not answered, and says nothing once it allows", async () => {
      expect(await clicked({ on: false, permission: "default", answer: "granted" })).toEqual({ asked: 1, on: true, says: "", synced: 1 });
    });

    it.each([
      ["answered by blocking", { answer: "denied" }],
      ["left unanswered or shown quietly", { answer: "default" }],
      ["refused outright", { refuses: true }],
    ])("asks, and says so when the prompt was %s", async (_, opts) => {
      const after = await clicked({ on: false, permission: "default", ...opts });
      expect(after).toEqual(expect.objectContaining({ asked: 1, on: true, synced: 1 }));
      expect(after.says).toMatch(UNANSWERED);
    });

    it("never asks once the browser blocked the page, and says how to allow it instead", async () => {
      for (const on of [true, false]) {
        const after = await clicked({ on, permission: "denied" });
        expect(after).toEqual(expect.objectContaining({ asked: 0, on: true, synced: 1 }));
        expect(after.says).toMatch(BLOCKED);
      }
    });

    it("says so in a browser with no notifications", async () => {
      const after = await clicked({ on: false });
      expect(after).toEqual(expect.objectContaining({ asked: 0, on: true, synced: 1 }));
      expect(after.says).toMatch(/cannot show notifications/);
    });

    it("asks the browser only from the bell's own click", () => {
      expect(APP_JS.match(/requestPermission\(/g)).toHaveLength(1);
      expect(fnSource("onBellClick")).toContain("await Notification.requestPermission()");
      expect(APP_JS.match(/onBellClick\b/g)).toHaveLength(2);
      expect(APP_JS).toContain('bell.addEventListener("click", onBellClick);');
    });

    // A live region toggled in and out of display is not reliably announced:
    // this one stays put, and its box hides itself while it says nothing.
    it("says it beside the bell, in a status region that stays in place, which its ✕ empties", () => {
      const note = /<div class="([^"]*)"><p id="notify-note"([^>]*)><\/p><button id="notify-note-close"([^>]*)>✕<\/button><\/div>/.exec(PAGE_HTML);
      expect(note).not.toBeNull();
      const [, box = "", region = "", close = ""] = note ?? [];
      expect(box).toContain("has-[p:empty]:hidden");
      expect(region).toMatch(/role="status"/);
      expect(region).toMatch(/aria-live="polite"/);
      expect(region).not.toMatch(/\shidden[\s>]/);
      expect(close).toMatch(/type="button" aria-label="Dismiss"/);
      expect(PAGE_HTML.slice(PAGE_HTML.indexOf("</button>", PAGE_HTML.indexOf('<button id="notify-toggle"')) + "</button>".length, note?.index).trim()).toBe("");
      expect(APP_JS).toContain('const bellNoteText = document.getElementById("notify-note");');
      expect(APP_JS).toContain('getElementById("notify-note-close").addEventListener("click", () => { bellNoteText.textContent = ""; });');
    });
  });

  // Allowed in the site settings, as the note says: the bell updates by
  // itself, and the note that told them how goes with the old permission.
  describe("following the browser's permission", () => {
    const followed = async (navigator: unknown, Notification: { permission: string } = { permission: "default" }) => {
      let synced = 0;
      const note = { textContent: "Notifications are blocked for this site" };
      await runInNewContext(`${fnSource("permissionNow")}${fnSource("followPermission")} followPermission()`, {
        navigator, Notification, bellNoteText: note, syncBell: () => { synced++; },
      });
      return { note, synced: () => synced };
    };
    const changing = () => {
      const seen: { change?: () => void; queried?: unknown } = {};
      const status = { addEventListener: (type: string, f: () => void) => { if (type === "change") seen.change = f; } };
      return { seen, navigator: { permissions: { query: async (q: unknown) => { seen.queried = q; return status; } } } };
    };

    it("redraws the bell and drops its note once the browser allows it, without a reload", async () => {
      const { seen, navigator } = changing();
      const browser = { permission: "denied" };
      const { note, synced } = await followed(navigator, browser);
      expect(seen.queried).toEqual({ name: "notifications" });
      expect(synced()).toBe(0);
      browser.permission = "granted";
      seen.change?.();
      expect([synced(), note.textContent]).toEqual([1, ""]);
    });

    // The order of a prompt's answer and the change it makes is the
    // browser's: a change landing after the click wrote its note must not
    // wipe it, or blocking from the prompt says nothing again.
    it.each(["denied", "default"])("redraws the bell but keeps the note when the permission turns %s", async (permission) => {
      const { seen, navigator } = changing();
      const browser = { permission: "default" };
      const { note, synced } = await followed(navigator, browser);
      browser.permission = permission;
      seen.change?.();
      expect([synced(), note.textContent]).toEqual([1, "Notifications are blocked for this site"]);
    });

    it.each([
      ["has no permissions API", {}],
      ["has no query", { permissions: {} }],
      ["refuses to query notifications", { permissions: { query: async () => { throw new TypeError("notifications"); } } }],
    ])("still works in a browser that %s", async (_, navigator) => {
      await expect(followed(navigator)).resolves.toBeDefined();
    });

    it("is followed from load, and never asks", () => {
      expect(APP_JS).toContain("\nfollowPermission();\n");
      expect(fnSource("followPermission")).not.toContain("requestPermission");
    });
  });
});

describe("routing and the sidebar", () => {
  const ctx = (): Record<string, unknown> => {
    const c: Record<string, unknown> = { document: fakeDocument };
    for (const f of ["routeOf", "hashOf", "pageOf", "rootsOn", "titleOf", "el", "navItem"]) runInNewContext(fnSource(f), c);
    return c;
  };
  const call = <T>(name: string, ...args: unknown[]): T => {
    const c = ctx();
    c.args = args;
    return runInNewContext(`${name}(...args)`, c) as T;
  };

  it.each([
    ["", { workflow: null, item: null }],
    ["#", { workflow: null, item: null }],
    ["#/", { workflow: null, item: null }],
    ["#/w/main", { workflow: "main", item: null }],
    ["#/w/fast%20lane", { workflow: "fast lane", item: null }],
    ["#/w/main?item=12", { workflow: "main", item: "12" }],
    ["#/?item=12", { workflow: null, item: "12" }],
    ["#item=12", { workflow: null, item: "12" }],
    ["#/w/%E0%A4%A", { workflow: null, item: null }],
  ])("reads %j as %j", (hash, route) => {
    expect(call("routeOf", hash)).toEqual(route);
  });

  it("writes back what it reads", () => {
    for (const route of [{ workflow: null, item: null }, { workflow: "fast lane", item: "pr:7" }, { workflow: "main", item: null }]) {
      expect(call("routeOf", call<string>("hashOf", route))).toEqual(route);
    }
  });

  it("falls back to Needs You for a workflow the view does not have", () => {
    const view = { workflows: [{ id: "main", name: "main", needsYou: 0 }] };
    expect(call("pageOf", view, { workflow: "main", item: null })).toBe("main");
    expect(call("pageOf", view, { workflow: "gone", item: null })).toBeNull();
  });

  it("draws Needs You from every workflow's needing roots, and a workflow page from its own", () => {
    const rows = [
      { id: "1", lane: "needs-you", pages: ["a"] },
      { id: "2", lane: "running", pages: ["a"] },
      { id: "3", lane: "needs-you", pages: ["b"] },
      { id: "4", lane: "not-admitted", pages: ["a", "b"] },
    ];
    expect(call<{ id: string }[]>("rootsOn", rows, null).map((r) => r.id)).toEqual(["1", "3"]);
    expect(call<{ id: string }[]>("rootsOn", rows, "a").map((r) => r.id)).toEqual(["1", "2", "4"]);
  });

  it("counts Needs You in the tab title", () => {
    expect(call("titleOf", 0)).toBe("Landrace");
    expect(call("titleOf", 3)).toBe("(3) Landrace");
  });

  it("marks a workflow with a dot only while something in it needs you, and the selected entry as current", () => {
    const quiet = call<FakeElement>("navItem", { id: "main", name: "main", needsYou: 0 }, false);
    const busy = call<FakeElement>("navItem", { id: "fast", name: "fastlane", needsYou: 2 }, true);
    expect(quiet.href).toBe("#/w/main");
    expect(descendants(quiet).some((e) => e.className.includes("dot"))).toBe(false);
    expect(descendants(busy).some((e) => e.className.includes("dot"))).toBe(true);
    expect(busy.getAttribute("aria-current")).toBe("page");
    expect(quiet.getAttribute("aria-current")).toBeNull();
    expect(busy.textContent).toContain("fastlane");
  });

  it("gives the Needs You entry its count and the home link", () => {
    const home = call<FakeElement>("navItem", { id: null, name: "Needs You", needsYou: 4 }, true);
    expect(home.href).toBe("#/");
    expect(home.textContent).toContain("4");
  });

  it("shows no count on Needs You when nothing needs you, and keeps the entry", () => {
    const empty = call<FakeElement>("navItem", { id: null, name: "Needs You", needsYou: 0 }, true);
    expect(empty.href).toBe("#/");
    expect(empty.textContent).toBe("Needs You");
    expect(descendants(empty).some((e) => e.className.includes("rounded-full"))).toBe(false);
  });

  it("lays the sidebar out as a column from sm up and a row of chips below it", () => {
    expect(PAGE_HTML).toMatch(/<nav id="sidebar"[^>]*>/);
    expect(PAGE_HTML).toMatch(/id="nav" class="[^"]*\bflex-wrap\b[^"]*\bsm:flex-col\b/);
  });
});

describe("the render rules of the sidebar pages", () => {
  const load = (names: string[], extra: Record<string, unknown> = {}): Record<string, unknown> => {
    const c: Record<string, unknown> = { document: fakeDocument, ...extra };
    for (const f of names) runInNewContext(fnSource(f), c);
    return c;
  };
  const run = <T>(c: Record<string, unknown>, code: string): T => runInNewContext(code, c) as T;
  const ROWS = [
    { id: "1", lane: "needs-you", pages: ["a"] },
    { id: "2", lane: "running", pages: ["a"] },
    { id: "3", lane: "needs-you", pages: ["b"] },
  ];

  it("draws only the needs-you lane on Needs You, and every lane on a workflow page", () => {
    const c = load(["laneRoots", "rootsOn"]);
    c.ROWS = ROWS;
    const ids = (page: string | null, lane: string): string[] | null => {
      c.PAGE = page; c.LANE = lane;
      const r = run<{ id: string }[] | null>(c, "laneRoots(ROWS, PAGE, LANE, () => true)");
      return r === null ? null : r.map((x) => x.id);
    };
    expect(ids(null, "needs-you")).toEqual(["1", "3"]);
    expect(ids(null, "running")).toBeNull();
    expect(ids("a", "running")).toEqual(["2"]);
    expect(ids("a", "needs-you")).toEqual(["1"]);
    expect(ids("a", "waiting")).toEqual([]);
  });

  it("applies the search inside the page's roots", () => {
    const c = load(["laneRoots", "rootsOn"]);
    c.ROWS = ROWS;
    expect(run<{ id: string }[]>(c, `laneRoots(ROWS, null, "needs-you", (r) => r.id === "3")`).map((r) => r.id)).toEqual(["3"]);
  });

  it("hides a lane the page does not draw, and one a search emptied", () => {
    const c = load(["laneHidden"]);
    const h = (drawn: unknown[] | null, search: unknown): boolean => { c.D = drawn; c.S = search; return run(c, "laneHidden(D, S)"); };
    expect(h(null, null)).toBe(true);
    expect(h([], null)).toBe(false);
    expect(h([], {})).toBe(true);
    expect(h([{}], {})).toBe(false);
  });

  it("draws the workflow tag on Needs You only, read from the hash and the last view", () => {
    const c = load(["routeOf", "pageOf", "pageNow", "tagsOn"]);
    c.lastView = { workflows: [{ id: "a", name: "a", needsYou: 0 }] };
    c.location = { hash: "#/" };
    expect(run(c, "tagsOn(pageNow())")).toBe(true);
    c.location = { hash: "#/w/a" };
    expect(run(c, "tagsOn(pageNow())")).toBe(false);
    c.location = { hash: "#/w/gone" };
    expect(run(c, "tagsOn(pageNow())")).toBe(true);
  });

  it("hides an item row's tag on a workflow page, through itemRowFor itself", () => {
    const names = ["routeOf", "pageOf", "pageNow", "tagsOn", "el", "elapsed", "external", "treeItem", "shieldMark", "toggleFor", "toggleSlot", "itemRowFor"];
    const row = { id: "12", kind: "item", title: "t", link: "", closed: null, badge: null, stage: null, priority: null, note: "", since: null, round: null, model: null, chat: null, screened: false, children: [], workflow: "a", tag: "A", panel: null };
    const build = (hash: string): FakeElement => runInNewContext(`
      ${constSource("SVG_NS")}${constSource("INDENT")}${constSource("indentOf")}${blockSource("BADGES")}
      ${names.map(fnSource).join("")}
      itemRowFor(ROW, 0, 0, false)`, { ROW: row, document: fakeDocument, lastView: { workflows: [{ id: "a", name: "a", needsYou: 0 }] }, location: { hash } }) as FakeElement;
    const tagged = (li: FakeElement): boolean => descendants(li).some((d) => d.className.split(" ").includes("workflow"));
    expect(tagged(build("#/"))).toBe(true);
    expect(tagged(build("#/w/a"))).toBe(false);
  });

  describe("the sidebar's rebuild", () => {
    const setup = () => {
      const writes: FakeElement[][] = [];
      const ul = { replaceChildren: (...n: FakeElement[]) => { writes.push(n); } };
      const c = load(["el", "hashOf", "navItem", "renderNav"], { navKey: null });
      c.document = { createElement: fakeDocument.createElement, getElementById: () => ul };
      return { c, writes };
    };
    const view = (n: number, workflows = [{ id: "a", name: "a", needsYou: 0 }]) => ({ needsYou: n, workflows });

    it("is left alone when nothing it shows changed, and redone when a count, the page or a name does", () => {
      const { c, writes } = setup();
      const go = (v: unknown, page: string | null): void => { c.V = v; c.P = page; run(c, "renderNav(V, P)"); };
      go(view(1), null);
      go(view(1), null);
      expect(writes).toHaveLength(1);
      go(view(2), null);
      expect(writes).toHaveLength(2);
      go(view(2), "a");
      expect(writes).toHaveLength(3);
      go(view(2, [{ id: "a", name: "renamed", needsYou: 0 }]), "a");
      expect(writes).toHaveLength(4);
    });

    it("puts Needs You first, then a divider only when there are workflows", () => {
      const { c, writes } = setup();
      c.V = view(0); c.P = null;
      run(c, "renderNav(V, P)");
      expect(writes[0]?.map((n) => n.getAttribute("role") ?? n.tag)).toEqual(["li", "separator", "li"]);
      const none = setup();
      none.c.V = view(0, []); none.c.P = null;
      run(none.c, "renderNav(V, P)");
      expect(none.writes[0]).toHaveLength(1);
    });
  });

  it("keys each nav link, so render's restore-by-key keeps a link's focus across a rebuild", () => {
    const c = load(["el", "hashOf", "navItem"]);
    c.E = { id: "a", name: "a", needsYou: 0 };
    expect(run<FakeElement>(c, "navItem(E, false)").getAttribute("data-key")).toBe("nav:#/w/a");
  });

  it("writes the tab title only when it changed", () => {
    let writes = 0;
    let title = "Landrace";
    const doc = { get title() { return title; }, set title(v: string) { writes++; title = v; } };
    const c = load(["titleOf", "setTitle"], { document: doc });
    for (const n of [0, 0, 3, 3, 0]) { c.N = n; run(c, "setTitle(N)"); }
    expect(writes).toBe(2);
    expect(title).toBe("Landrace");
  });

  describe("opening and closing the panel", () => {
    const setup = (hash: string, view: unknown = { workflows: [{ id: "main", name: "main", needsYou: 0 }] }) => {
      const replaced: string[] = [];
      const location = { hash, pathname: "/", search: "" };
      const c = load(["routeOf", "hashOf", "pageOf", "pageNow", "openPanel", "closePanel"], {
        location, lastView: view,
        history: { replaceState: (_a: unknown, _b: string, url: string) => { replaced.push(url); } },
        showPanel: () => {},
      });
      return { c, location, replaced };
    };

    it("opens an item on the current workflow's page", () => {
      const { c, location } = setup("#/w/main");
      run(c, 'openPanel("12")');
      expect(location.hash).toBe("#/w/main?item=12");
    });

    it("closes by replacing the URL with the page alone", () => {
      const { c, replaced } = setup("#/w/main?item=12");
      run(c, "closePanel()");
      expect(replaced).toEqual(["/#/w/main"]);
    });

    it("falls back to Needs You on a workflow the view lacks, for both", () => {
      const a = setup("#/w/gone");
      run(a.c, 'openPanel("12")');
      expect(a.location.hash).toBe("#/?item=12");
      const b = setup("#/w/gone?item=12");
      run(b.c, "closePanel()");
      expect(b.replaced).toEqual(["/#/"]);
    });

    it("keeps the hash's own workflow before the first view has landed", () => {
      const { c, replaced } = setup("#/w/main?item=12", null);
      run(c, "closePanel()");
      expect(replaced).toEqual(["/#/w/main"]);
    });
  });

  describe("the panel of a row with no panel", () => {
    const title = (...args: unknown[]): string => {
      const c: Record<string, unknown> = { args };
      runInNewContext(fnSource("panelTitleOf"), c);
      return runInNewContext("panelTitleOf(...args)", c) as string;
    };
    const clash = { id: "17", kind: "item", title: "Two trackers", panel: null, note: "reported by the sources of a and b" };

    it("is titled by the row's own number and title, not 'not on the board'", () => {
      expect(title(clash, "17", true)).toBe("#17 Two trackers");
    });
    it("keeps 'not on the board' for an id the view lacks, and Loading… before a view", () => {
      expect(title(null, "17", true)).toBe("#17 is not on the board");
      expect(title(null, "17", false)).toBe("Loading…");
    });
    it("titles a row with a panel by its title alone", () => {
      expect(title({ ...clash, panel: {} }, "17", true)).toBe("Two trackers");
    });
    it("is found by a lookup that offers no reads or writes", () => {
      const src = fnSource("renderPanel");
      expect(src).toContain("panelTitleOf(");
      expect(src).toContain("bareRow()");
    });
  });
});

// Found in a 400px browser: a long unbroken title pushed the page sideways, and
// a row's menu, right-aligned to a button at the left edge, hung off-screen.
describe("a narrow screen", () => {
  it("lets a title and a note break anywhere, so no word widens the page", () => {
    const src = fnSource("itemRowFor");
    expect(src).toContain("title min-w-0 wrap-anywhere");
    expect(src).toContain("note min-w-0 wrap-anywhere");
    expect(APP_CSS).toContain(".wrap-anywhere{");
  });

  it("opens a row's menu from the left edge below sm, where its button sits, and from the right above", () => {
    const tokens = fnSource("buildRowMenu").match(/el\("div", "(absolute [^"]*)"/)?.[1]?.split(" ") ?? [];
    expect(tokens).toEqual(expect.arrayContaining(["left-0", "sm:left-auto", "sm:right-0"]));
    expect(tokens).not.toContain("right-0");
  });

  it("gives the header the sidebar's width, so the logo lines up", () => {
    expect(PAGE_HTML).toMatch(/<header[^>]*>\s*<div class="[^"]*max-w-6xl/);
  });
});

describe("the empty Needs You", () => {
  const allSet = (...args: unknown[]): boolean => {
    const c: Record<string, unknown> = { args };
    runInNewContext(fnSource("allSet"), c);
    return runInNewContext("allSet(...args)", c) as boolean;
  };

  it("is all set only on Needs You, with nothing there and no search", () => {
    expect(allSet(null, [], null, true)).toBe(true);
    expect(allSet(null, [{ id: "1" }], null, true)).toBe(false);
    expect(allSet("main", [], null, true)).toBe(false);
    expect(allSet(null, [], { self: new Set(), below: new Set() }, true)).toBe(false);
  });

  it("is not all set before anything has been listed: no data is not an all-clear", () => {
    expect(allSet(null, [], null, false)).toBe(false);
  });

  it("says Listing… on the home page until the first listing, and nowhere else", () => {
    const run = (args: unknown[]): boolean => {
      const c: Record<string, unknown> = { args };
      runInNewContext(fnSource("listingShown"), c);
      return runInNewContext("listingShown(...args)", c) as boolean;
    };
    expect(run([null, false])).toBe(true);
    expect(run([null, true])).toBe(false);
    expect(run(["main", false])).toBe(false);
    const block = /<p id="listing"[^>]*>[^<]*<\/p>/.exec(PAGE_HTML)?.[0] ?? "";
    expect(block).toContain("Listing…");
    expect(block).toContain("hidden");
    expect(block).not.toContain("rose");
  });

  it("draws every item checked off, in the page's own colour and one emerald accent", () => {
    const block = /<div id="all-set"[\s\S]*?<\/div>/.exec(PAGE_HTML)?.[0] ?? "";
    expect(block).toContain("You're all set!");
    expect(block).toContain("Nothing needs you. Landrace has it from here.");
    const svg = /<svg[\s\S]*?<\/svg>/.exec(block)?.[0] ?? "";
    expect(svg).toMatch(/role="img"/);
    expect(svg).toMatch(/aria-label="Every item checked off"/);
    // The page's own colour (currentColor) so light and dark both read, plus
    // the emerald the board's checks already use, and a faint white wash.
    for (const [, value] of svg.matchAll(/(?:fill|stroke)="([^"]*)"/g)) {
      expect(["currentColor", "none", "white", "#10b981"]).toContain(value);
    }
    // Inline markup: shapes only, nothing that runs, loads or links.
    expect(svg).not.toMatch(/<script|<foreignObject|<image|<use|href=|\son[a-z]+=|style=/i);
    expect(svg.length).toBeLessThan(4096);
  });

  it("hides the block unless all set, and the lane it replaces when it is", () => {
    const run = (expr: string, args: unknown[]): boolean => {
      const c: Record<string, unknown> = { args };
      runInNewContext(fnSource("allSet") + fnSource("allSetHidden") + fnSource("laneHidden"), c);
      return runInNewContext(expr, c) as boolean;
    };
    expect(run("allSetHidden(...args)", [null, [], null, true])).toBe(false);
    expect(run("allSetHidden(...args)", [null, [], null, false])).toBe(true);
    expect(run("allSetHidden(...args)", [null, [{}], null, true])).toBe(true);
    expect(run("laneHidden(...args)", [[], null, true])).toBe(true);
    expect(run("laneHidden(...args)", [[], null, false])).toBe(false);
    const render = fnSource("render");
    expect(render).toContain("allSet(page, rootsOn(view.rows, page), search, view.listed)");
    expect(render).toContain("hidden = allSetHidden(page, rootsOn(view.rows, page), search, view.listed)");
    expect(render).toContain("hidden = !listing");
    // The unlisted home replaces the empty lane too, as the beach does.
    expect(render).toContain("const listing = listingShown(page, view.listed)");
    expect(render).toContain("laneHidden(drawn, search, done || listing)");
  });
});
