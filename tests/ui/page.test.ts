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
    expect(input).toMatch(/aria-label="Search tickets"/);
    expect(input).toMatch(/placeholder="Search tickets…"/);
  });

  // Two buttons side by side, one of which always did nothing: the tree was
  // already all open, or already all shut.
  it("has one Collapse all / Expand all button, reading Collapse all over a tree that starts open", () => {
    const filters = /<div id="filters"[\s\S]*?\n<\/div>\n/.exec(PAGE_HTML)?.[0] ?? "";
    expect(filters.match(/<button /g)).toHaveLength(1);
    expect(filters).toMatch(/<button id="toggle-all" type="button" class="[^"]*">Collapse all<\/button>/);
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
  const isOpen = (stored: [string, boolean][], row: Tree): boolean =>
    (runInNewContext(`const userExpanded = new Map(${JSON.stringify(stored)});${fnSource("isOpen")}isOpen`) as (r: Tree) => boolean)(row);

  // Everything starts open: the board is read top to bottom, and a branch that
  // arrives shut hides the very ticket someone came to look at.
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
    function ticketRowFor(row, depth, now, open) { return depth + ":" + row.id + (open ? "+" : ""); }
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
  it("names the system only on artifact rows — a ticket row carries no mark and no system name", () => {
    expect(fnSource("ticketRowFor")).not.toContain("systemMark(");
    expect(fnSource("artifactRowFor")).toContain("systemMark(row.system)");
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

/** A top-level `const NAME = { … };` of the page script that spans several lines, as source. */
const blockSource = (name: string): string => {
  const start = APP_JS.indexOf(`\nconst ${name} = `);
  if (start < 0) throw new Error(`APP_JS has no top-level const ${name}`);
  const end = /\n[}\]];\n/.exec(APP_JS.slice(start));
  if (!end) throw new Error(`APP_JS's const ${name} never closes`);
  return APP_JS.slice(start, start + end.index + end[0].length);
};

/**
 * The Retry on a stopped ticket's menu. It hands the ticket back, which
 * re-runs a paid step, so it is offered only where the server says so, asks
 * first, and posts to the path the server built — never one of its own.
 */
describe("a stopped ticket's Retry", () => {
  class Listening extends FakeElement {
    listeners = new Map<string, () => void>();
    disabled = false;
    hidden = false;
    override addEventListener(type?: string, f?: () => void): void { if (type && f) this.listeners.set(type, f); }
  }
  const doc = { createElement: (tag: string) => new Listening(tag), createElementNS: (_: string, tag: string) => new Listening(tag) };
  const row = (retry: string | null) => ({
    id: "19", chat: { prompt: "p", links: { claude: "a:", claudeCli: "b:", cursor: "c:", codex: "d:" } }, retry,
  });

  /** The menu for a row, with the world a click reaches stood in for and written down. */
  const menuFor = (r: ReturnType<typeof row>, world: { confirm?: boolean; response?: { ok: boolean; text: string } | "down" } = {}) => {
    const seen = { confirms: [] as string[], posts: [] as Array<[string, unknown]>, closed: [] as unknown[], polls: [] as number[], renders: 0 };
    const context = {
      ROW: r, document: doc, navigator: {}, seen, lastView: {},
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
      const retryNotes = new Map();
      const retrying = new Set();
      ${["el", "luminance", "faintOnDark", "markSvg", "chatIcon", "menuItem", "retryItem", "retry", "buildChatMenu"].map(fnSource).join("")}
      buildChatMenu(ROW)`, context) as Listening;
    return { menu, seen, context };
  };
  const items = (menu: Listening): string[] => menu.children.map((c) => (c.tag === "hr" ? "—" : c.textContent));
  const retryOf = (menu: Listening): Listening | undefined =>
    menu.children.find((c) => c.getAttribute("data-key") === "19:retry") as Listening | undefined;
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("comes last, after every chat item, and only on a row the server offered it for", () => {
    expect(items(menuFor(row("/tickets/19/retry")).menu)).toEqual([
      "Claude Code", "Claude Code (CLI)", "Cursor", "Codex", "—", "Copy prompt", "—", "Retry",
    ]);
    expect(items(menuFor(row(null)).menu)).toEqual(["Claude Code", "Claude Code (CLI)", "Cursor", "Codex", "—", "Copy prompt"]);
  });

  it("is a menu item, keyed so focus on it survives a poll", () => {
    const item = retryOf(menuFor(row("/tickets/19/retry")).menu);
    expect(item?.tag).toBe("button");
    expect(item?.getAttribute("role")).toBe("menuitem");
  });

  it("asks before it posts, and posts nothing when told no", async () => {
    const { menu, seen } = menuFor(row("/tickets/19/retry"), { confirm: false });
    retryOf(menu)?.listeners.get("click")?.();
    await settle();
    expect(seen.confirms).toHaveLength(1);
    expect(seen.confirms[0]).toMatch(/#19[\s\S]*paid step/);
    expect(seen.posts).toEqual([]);
  });

  it("posts once, to the server's own path, with the header the server asks for — then closes, returns focus and polls", async () => {
    const { menu, seen } = menuFor(row("/tickets/19/retry"));
    retryOf(menu)?.listeners.get("click")?.();
    await settle();
    expect(seen.posts).toEqual([["/tickets/19/retry", { method: "POST", headers: { "x-landrace-action": "retry" } }]]);
    expect(seen.closed).toEqual([{ returnFocus: true }]);
    expect(seen.polls).toEqual([0]);
  });

  it("keeps the menu open and says what the server said when it refuses", async () => {
    const { menu, seen, context } = menuFor(row("/tickets/19/retry"), {
      response: { ok: false, text: "#19 is not blocked or screened right now, so there is nothing to retry" },
    });
    retryOf(menu)?.listeners.get("click")?.();
    await settle();
    expect(seen.closed).toEqual([]);
    // Redrawn from state, so the sentence outlives the render every poll does.
    expect(seen.renders).toBeGreaterThan(0);
    const again = runInNewContext("buildChatMenu(ROW)", context) as Listening;
    expect(retryOf(again)?.textContent).toMatch(/not blocked or screened/);
  });

  it("says landrace is not answering when the post never lands", async () => {
    const { menu, context } = menuFor(row("/tickets/19/retry"), { response: "down" });
    retryOf(menu)?.listeners.get("click")?.();
    await settle();
    const again = runInNewContext("buildChatMenu(ROW)", context) as Listening;
    expect(retryOf(again)?.textContent).toMatch(/not responding/);
  });
});

describe("a ticket row stopped by a security check", () => {
  interface TicketRow extends Tree {
    kind: string; link: string; closed: null; badge: string; stage: string; priority: null; note: string;
    since: null; round: null; model: null; chat: null; screened: boolean;
  }
  const build = (row: TicketRow): FakeElement => runInNewContext(`
    ${constSource("SVG_NS")}${constSource("INDENT")}${constSource("indentOf")}${blockSource("BADGES")}
    ${["el", "elapsed", "external", "treeItem", "shieldMark", "ticketRowFor"].map(fnSource).join("")}
    ticketRowFor(ROW, 0, 0, false)`, { ROW: row, document: fakeDocument }) as FakeElement;
  const screened: TicketRow = {
    id: "19", kind: "ticket", title: "Payments revamp", link: "https://github.com/a/b/issues/19", closed: null,
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

describe("an artifact row", () => {
  interface Artifact extends Tree {
    kind: string; link: string; closed: null;
    system: { name: string; icon: { bg: string; glyph: string } | null } | null;
  }
  const build = (row: Artifact, depth = 1): FakeElement => runInNewContext(`
    ${constSource("SVG_NS")}${constSource("INDENT")}${constSource("indentOf")}
    ${["el", "luminance", "faintOnDark", "markSvg", "systemIcon", "systemMark", "external", "treeItem", "toggleFor", "artifactRowFor"].map(fnSource).join("")}
    artifactRowFor(ROW, ${depth}, ROW.children.length > 0)`, { ROW: row, document: fakeDocument }) as FakeElement;
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
    const mark = descendants(build(spec)).find((d) => d.getAttribute("role") === "img");
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

  it("puts the mark first and ↗ last, pushed to the row's far edge and hidden from a screen reader", () => {
    const a = link(build(spec));
    expect(a?.children[0]?.getAttribute("role")).toBe("img");
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

  // Same column as a ticket's number at this depth: the toggle is a column of
  // its own, and the mark opens the line after it.
  it("keeps the toggle in its own column ahead of the link, so the mark lines up with a ticket's number", () => {
    const leaf = build(spec, 2);
    expect(leaf.className.split(" ")).toContain("pl-16");
    expect(leaf.children.map((c) => c.tag)).toEqual(["a"]);
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

  it("renders a Chat action on needs-you rows and an inert one everywhere else", () => {
    expect(APP_JS).toContain('row.badge === "needs-you"');
    expect(APP_JS).toContain("Chat ▾");
  });

  it("wires exactly the tick button, the theme toggle, the search box, Collapse all / Expand all, the collapsible lanes' summaries, the row expand toggle, the row menu toggle, the four links, copy, retry, and the two document-level close listeners — no more, no less", () => {
    // Pins the count deliberately: the tick button and theme toggle, the
    // search box and the one Collapse all / Expand all button (each wired once, outside
    // anything a render rebuilds), the collapsible lanes' summary clicks
    // (defined once, in a loop over the two), the expand/collapse toggle
    // (defined once, in toggleFor, not once per row), and for the Chat/… menu
    // one toggle-button listener, one close-on-choose listener (defined once
    // inside the per-target loop), one Copy-prompt listener, one Retry
    // listener (defined once, in retryItem, and built only on a stopped
    // ticket's menu), and one document listener each for outside-click and
    // Escape (both defined once, so re-rendering never multiplies them).
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
