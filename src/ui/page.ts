/*
 * The triage page. Strings rather than files so the build ships them with no
 * copy step. Script and style are served as their own routes so the CSP can
 * forbid anything inline.
 */
export { APP_CSS } from "#ui/styles.generated.js";

/**
 * One <section> lane: a coloured left border, a mono heading, a count badge.
 * No overflow clipping — a row's Chat menu is absolutely positioned and has to
 * be free to hang past the card's bottom edge.
 */
const lane = (id: string, label: string, accent: string, dot = ""): string => `
<section data-lane="${id}" class="mb-4 rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900${accent}">
<div class="flex items-center gap-2 border-b border-neutral-100 px-4 py-3 dark:border-neutral-800">
${dot}<h2 class="font-mono text-xs font-semibold uppercase tracking-wider">${label}</h2>
<span class="lane-count inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1.5 py-0.5 text-xs font-medium">0</span>
</div>
<ul role="tree" aria-label="${label}" class="divide-y divide-neutral-100 dark:divide-neutral-800"></ul>
</section>`;

/** not-admitted / discharged: same card, collapsible, no colour accent, a rotating chevron. */
const collapsedLane = (id: string, label: string): string => `
<details data-lane="${id}" class="group mb-4 rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
<summary class="flex cursor-pointer list-none items-center gap-2 px-4 py-3 [&::-webkit-details-marker]:hidden">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-3 w-3 shrink-0 text-neutral-400 transition-transform group-open:rotate-90" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>
<h2 class="font-mono text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">${label}</h2>
<span class="lane-count inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-neutral-100 px-1.5 py-0.5 text-xs font-medium text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">0</span>
</summary>
<ul role="tree" aria-label="${label}" class="divide-y divide-neutral-100 dark:divide-neutral-800"></ul>
</details>`;

const RUNNING_DOT =
  '<span class="h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-500" aria-hidden="true"></span>';

const BUTTON =
  "rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800";

export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Landrace</title>
<script src="/theme.js"></script>
<link rel="stylesheet" href="/app.css">
<script src="/app.js" defer></script>
</head>
<body class="min-h-screen bg-neutral-50 font-sans text-sm text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
<header class="border-b border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
<div class="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
<div class="flex min-w-0 flex-wrap items-center gap-2">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="h-5 w-5 shrink-0" aria-hidden="true"><line x1="4" y1="4" x2="4" y2="20"></line><line x1="9" y1="7" x2="20" y2="7"></line><line x1="9" y1="12" x2="20" y2="12"></line><line x1="9" y1="17" x2="16" y2="17"></line></svg>
<h1 class="text-sm font-semibold">Landrace</h1>
<span id="folder" class="min-w-0 truncate rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1 font-mono text-xs text-neutral-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-400"></span>
<span id="meta" class="hidden text-xs text-neutral-400 dark:text-neutral-500 sm:inline"></span>
</div>
<div class="flex flex-wrap items-center gap-2">
<div id="schedule" class="flex flex-wrap items-center gap-2">
<span id="next" class="rounded-full border border-neutral-200 px-3 py-1 font-mono text-xs text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">No tick scheduled</span>
<button id="tick" type="button" class="${BUTTON}">Run next tick now</button>
</div>
<button id="theme-toggle" type="button" aria-label="Switch to dark mode" class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4 dark:hidden" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="hidden h-4 w-4 dark:block" aria-hidden="true"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>
</button>
</div>
</div>
</header>
<main class="mx-auto max-w-5xl px-4 py-6 sm:px-6">
<div id="filters" class="mb-4 flex flex-wrap items-center justify-between gap-2">
<input id="search" type="search" placeholder="Search tickets…" aria-label="Search tickets" autocomplete="off" spellcheck="false" class="w-full rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-sm text-neutral-900 placeholder:text-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500 sm:w-72">
<button id="toggle-all" type="button" class="${BUTTON}">Collapse all</button>
</div>
<p id="no-match" role="status" aria-live="polite" class="mb-4 px-1 text-sm italic text-neutral-400 empty:hidden dark:text-neutral-500"></p>
${lane("needs-you", "Needs you", " border-l-4 border-l-rose-500 [&_h2]:text-rose-600 dark:[&_h2]:text-rose-400 [&_.lane-count]:bg-rose-100 [&_.lane-count]:text-rose-700 dark:[&_.lane-count]:bg-rose-950 dark:[&_.lane-count]:text-rose-300")}
${lane("running", "Agent running", " border-l-4 border-l-emerald-500 [&_h2]:text-emerald-600 dark:[&_h2]:text-emerald-400 [&_.lane-count]:bg-emerald-100 [&_.lane-count]:text-emerald-700 dark:[&_.lane-count]:bg-emerald-950 dark:[&_.lane-count]:text-emerald-300", RUNNING_DOT)}
${lane("elsewhere", "Held elsewhere", " border-l-4 border-l-amber-500 [&_h2]:text-amber-600 dark:[&_h2]:text-amber-400 [&_.lane-count]:bg-amber-100 [&_.lane-count]:text-amber-700 dark:[&_.lane-count]:bg-amber-950 dark:[&_.lane-count]:text-amber-300")}
${lane("waiting", "Waiting", " border-l-4 border-l-neutral-300 dark:border-l-neutral-700 [&_h2]:text-neutral-500 dark:[&_h2]:text-neutral-400 [&_.lane-count]:bg-neutral-100 [&_.lane-count]:text-neutral-600 dark:[&_.lane-count]:bg-neutral-800 dark:[&_.lane-count]:text-neutral-300")}
${collapsedLane("not-admitted", "Not admitted")}
${collapsedLane("discharged", "Done")}
</main>
</body>
</html>
`;

const THEME_KEY = "landrace-theme";

/**
 * Blocking, in <head>, before /app.css and /app.js: this has to run and set
 * the class before the browser paints anything, or the page flashes light
 * before switching to dark. Every localStorage access is wrapped — a private
 * window or blocked site data throws on read *and* write, and a themed page
 * beats no page over a storage exception.
 */
export const THEME_JS = `
"use strict";
(function () {
  var stored = null;
  try { stored = localStorage.getItem("${THEME_KEY}"); } catch (e) {}
  var dark = stored === null ? matchMedia("(prefers-color-scheme: dark)").matches : stored === "dark";
  document.documentElement.classList.toggle("dark", dark);
})();
`;

export const APP_JS = `
"use strict";
const POLL_MS = 2000;
const THEME_KEY = ${JSON.stringify(THEME_KEY)};

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function elapsed(since, now) {
  if (typeof since !== "number") return "";
  const s = Math.max(0, Math.floor((now - since) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? h + "h " + m + "m" : m + "m " + String(r).padStart(2, "0") + "s";
}

const SVG_NS = "http://www.w3.org/2000/svg";

// WCAG relative luminance of "#rrggbb".
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Under WCAG's 3:1 for a non-text mark against the dark card: the near-black
// squares in src/ui/systems.ts vanished there, leaving a floating letter.
function faintOnDark(hex) {
  // The dark card, neutral-900 (#171717) — a menu on it too.
  const card = 0.0086;
  return (luminance(hex) + 0.05) / (card + 0.05) < 3;
}

// The coloured rounded square every mark is drawn on. One too dark to see on
// the dark card gets a light hairline ring in dark mode only — a dark:
// class, so switching theme needs no redraw and light mode is untouched.
function markSvg(bg) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("shrink-0", "rounded-sm");
  if (faintOnDark(bg)) svg.classList.add("dark:ring-1", "dark:ring-neutral-500");
  const rect = document.createElementNS(SVG_NS, "rect");
  rect.setAttribute("width", "16");
  rect.setAttribute("height", "16");
  rect.setAttribute("rx", "4");
  rect.setAttribute("fill", bg);
  svg.append(rect);
  return svg;
}

// A small coloured mark per vendor — colour and shape only, not a
// reproduction of any vendor's logotype, just enough to tell the three
// deep-link targets apart at a glance, the way the design's small icons do.
function chatIcon(bg, glyphAttrs) {
  const svg = markSvg(bg);
  const glyph = document.createElementNS(SVG_NS, "path");
  for (const k in glyphAttrs) glyph.setAttribute(k, glyphAttrs[k]);
  svg.append(glyph);
  return svg;
}

// A known system's mark: a coloured square and one or two white letters.
// Built from row.system.icon, which the server only ever fills from its own
// table (src/ui/systems.ts) — colour and letters, never a URL or an image.
function systemIcon(icon) {
  const svg = markSvg(icon.bg);
  const text = document.createElementNS(SVG_NS, "text");
  text.setAttribute("x", "8");
  text.setAttribute("y", "11.5");
  text.setAttribute("text-anchor", "middle");
  text.setAttribute("font-size", icon.glyph.length > 1 ? "7" : "9");
  text.setAttribute("font-weight", "700");
  text.setAttribute("fill", "#fff");
  text.textContent = icon.glyph;
  svg.append(text);
  return svg;
}

// Each entry's "key" indexes row.chat.links — the only place a URL for that
// target exists; this script only ever reads it out, never builds one.
const CHAT_TARGETS = [
  { key: "claude", label: "Claude Code",
    icon: () => chatIcon("#D97757", { d: "M8 3.2l1.1 3.1 3.3.2-2.6 2 .9 3.2-2.7-1.9-2.7 1.9.9-3.2-2.6-2 3.3-.2z", fill: "#fff" }) },
  { key: "claudeCli", label: "Claude Code (CLI)",
    icon: () => chatIcon("#D97757", { d: "M4.5 5l3 3-3 3M8.5 11h3", fill: "none", stroke: "#fff", "stroke-width": "1.6", "stroke-linecap": "round", "stroke-linejoin": "round" }) },
  { key: "cursor", label: "Cursor",
    icon: () => chatIcon("#18181b", { d: "M4 3l9 4.5-3.6.9L8.5 12z", fill: "#fff" }) },
  { key: "codex", label: "Codex",
    icon: () => chatIcon("#10a37f", {
      d: "M6.5 4l-3.2 4 3.2 4M9.5 4l3.2 4-3.2 4",
      fill: "none", stroke: "#fff", "stroke-width": "1.6", "stroke-linecap": "round", "stroke-linejoin": "round",
    }) },
];

// At most one Chat/… menu open at a time, tracked by the node it belongs
// to — never by an element reference. A render() rebuilds every row from
// scratch, so any button/menu object captured before one would go stale the
// instant it ran; a node id doesn't, because row.id doesn't change just
// because its DOM did. Every trigger/menu pair carries
// data-key="<id>:trigger" / "<id>:menu" (see actionFor), so the live
// element for a key is always one fresh lookup away.
let openMenuKey = null;

function menuKeyOf(id) { return id + ":menu"; }
function triggerKeyOf(id) { return id + ":trigger"; }
// Escaped: a node id is whatever the source called it, and a quote in one
// would otherwise throw out of querySelector and take render() down with it.
function byKey(key) { return document.querySelector('[data-key="' + CSS.escape(key) + '"]'); }

// Shows openMenuKey's menu (if any) and hides previousId's (if it was
// something else) — both looked up fresh, so this is safe to call right
// after a render() replaced every element it might touch.
function applyMenuState(previousId) {
  if (previousId !== null && previousId !== openMenuKey) {
    const prevMenu = byKey(menuKeyOf(previousId));
    const prevTrigger = byKey(triggerKeyOf(previousId));
    if (prevMenu) prevMenu.hidden = true;
    if (prevTrigger) prevTrigger.setAttribute("aria-expanded", "false");
  }
  if (openMenuKey !== null) {
    const menu = byKey(menuKeyOf(openMenuKey));
    const trigger = byKey(triggerKeyOf(openMenuKey));
    if (menu) menu.hidden = false;
    if (trigger) trigger.setAttribute("aria-expanded", "true");
  }
}

// Walk-away safety net. render() (see below) is what stops a poll from
// destroying an open menu, so this isn't standing in for that — it just
// stops one lingering forever after whoever opened it has left: a menu
// nobody has touched in 20s closes itself. Reset on any click/keydown while
// one is open, so an attentive user is never interrupted mid-read.
const IDLE_MS = 20000;
let idleTimer = null;
function clearIdleTimer() {
  if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null; }
}
function resetIdleTimer() {
  clearIdleTimer();
  idleTimer = setTimeout(() => closeMenu(), IDLE_MS);
}

function toggleMenu(id) {
  const previous = openMenuKey;
  openMenuKey = openMenuKey === id ? null : id;
  applyMenuState(previous);
  if (openMenuKey === null) clearIdleTimer(); else resetIdleTimer();
}

// "returnFocus" moves focus back to the trigger — right for Escape (a
// keyboard user's focus was on the menu and has nowhere else to go), wrong
// for an outside click (the user's attention, and often their pointer, is
// already on whatever they clicked) or for choosing a link (a real
// navigation is about to happen). The trigger is looked up fresh, by key, at
// the moment this runs — never an object a click handler captured earlier,
// which a render() in between may already have discarded.
function closeMenu(opts) {
  if (openMenuKey === null) return;
  const previous = openMenuKey;
  openMenuKey = null;
  applyMenuState(previous);
  clearIdleTimer();
  if (opts && opts.returnFocus) {
    const trigger = byKey(triggerKeyOf(previous));
    if (trigger) trigger.focus();
  }
}

// Defined once, not per row: because these are module-level listeners
// rather than one pair per row, re-rendering never multiplies them.
document.addEventListener("click", (e) => {
  if (openMenuKey === null) return;
  const menu = byKey(menuKeyOf(openMenuKey));
  const trigger = byKey(triggerKeyOf(openMenuKey));
  const inside = (menu && menu.contains(e.target)) || (trigger && trigger.contains(e.target));
  if (!inside) { closeMenu(); return; }
  resetIdleTimer();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeMenu({ returnFocus: true }); return; }
  if (openMenuKey !== null) resetIdleTimer();
});

function menuItem(tag) {
  const node = el(tag, "flex w-full items-center gap-2 px-3 py-1.5 text-left text-neutral-700 hover:bg-neutral-50 dark:text-neutral-200 dark:hover:bg-neutral-800");
  node.setAttribute("role", "menuitem");
  return node;
}

// The Chat menu's contents never change per badge — only which button opens
// it does (see actionFor) — so both "Chat ▾" and "…" share this builder.
function buildChatMenu(row) {
  const menu = el("div", "absolute right-0 z-10 mt-1 w-44 overflow-hidden rounded-md border border-neutral-200 bg-white py-1 text-xs shadow-lg dark:border-neutral-700 dark:bg-neutral-900");
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  for (const target of CHAT_TARGETS) {
    const a = menuItem("a");
    // Keyed like the trigger/menu (see actionFor) — render()'s restore-by-key
    // already covers any data-key it finds, so this is the only change a
    // keyboard user focused on one of these items when a poll landed
    // needed: no new mechanism, just another key for byKey() to find.
    a.setAttribute("data-key", row.id + ":" + target.key);
    // The href comes straight from the server-built link — this script never
    // concatenates a URL of its own (see src/ui/chat.ts).
    a.href = row.chat.links[target.key];
    a.rel = "noreferrer";
    a.append(target.icon(), el("span", null, target.label));
    // Choosing a target closes the menu — the navigation itself still
    // happens, since this is a real href, not prevented here.
    a.addEventListener("click", () => closeMenu());
    menu.append(a);
  }
  menu.append(el("hr", "my-1 border-neutral-100 dark:border-neutral-800"));
  const copy = menuItem("button");
  copy.type = "button";
  copy.textContent = "Copy prompt";
  copy.setAttribute("data-key", row.id + ":copy");
  // Its own label is what changes ("Copied"/"Copy failed"), so that's what a
  // screen reader needs told to announce it.
  copy.setAttribute("aria-live", "polite");
  const COPY_LABEL = "Copy prompt";
  let copyRestoreTimer = null;
  copy.addEventListener("click", () => {
    if (copyRestoreTimer !== null) clearTimeout(copyRestoreTimer);
    const restore = () => { copyRestoreTimer = setTimeout(() => { copy.textContent = COPY_LABEL; copyRestoreTimer = null; }, 2000); };
    const clipboard = navigator.clipboard;
    (clipboard ? clipboard.writeText(row.chat.prompt) : Promise.reject(new Error("no clipboard"))).then(
      () => { copy.textContent = "Copied"; restore(); },
      () => { copy.textContent = "Copy failed"; restore(); },
    );
  });
  menu.append(copy);
  return menu;
}

// The "..." / "Chat ▾" slot on the right of every row, both opening the same
// menu (Claude Code / Claude Code (CLI) / Cursor / Codex / a divider / Copy prompt).
function actionFor(row) {
  const needsYou = row.badge === "needs-you";
  const button = el(
    "button",
    needsYou
      ? "inline-flex items-center gap-1 rounded-md border border-neutral-200 px-2 py-1 text-xs font-medium text-neutral-700 dark:border-neutral-700 dark:text-neutral-300"
      : "inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 dark:text-neutral-500",
    needsYou ? "Chat ▾" : "⋯",
  );
  button.type = "button";
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("data-key", triggerKeyOf(row.id));
  if (!needsYou) button.setAttribute("aria-label", "Chat");

  const wrap = el("div", "relative shrink-0 self-start sm:self-auto");
  const menu = buildChatMenu(row);
  menu.setAttribute("data-key", menuKeyOf(row.id));
  button.addEventListener("click", () => toggleMenu(row.id));
  wrap.append(button, menu);
  return wrap;
}

const BADGES = {
  "needs-you": ["Needs you", "border-rose-300 text-rose-700 dark:border-rose-800 dark:text-rose-300"],
  "running": ["Running", "border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300"],
  "elsewhere": ["Held elsewhere", "border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-300"],
  "waiting": ["Waiting", "border-neutral-200 text-neutral-500 dark:border-neutral-700 dark:text-neutral-400"],
  "not-admitted": ["Not admitted", "border-neutral-200 text-neutral-400 dark:border-neutral-700 dark:text-neutral-500"],
  "discharged": ["Done", "border-neutral-200 text-neutral-400 dark:border-neutral-700 dark:text-neutral-500"],
};

// Indentation per depth, as whole classes Tailwind can see — capped, so a
// pathologically deep tree still fits the card. Each step is one toggle and
// its gap (1.5rem): with the toggle in a column of its own, a child's toggle —
// or a leaf child's number — starts right under its parent's number.
const INDENT = ["pl-4", "pl-10", "pl-16", "pl-22", "pl-28"];
const indentOf = (depth) => INDENT[Math.min(depth, INDENT.length - 1)];

// A person's own expand/collapse choices, by node id. Kept across every
// render: a poll landing every two seconds must never undo what someone just
// clicked. Every row starts open and stays so until someone closes it: the
// board is read top to bottom, and a branch that arrives shut hides the very
// ticket someone came to look at. An entry lives until its node leaves the
// view (see forgetGone), so a returning id starts open again rather than
// carrying a choice made about another node.
const userExpanded = new Map();
function isOpen(row) { return userExpanded.get(row.id) !== false; }

// Rows opened or closed by hand since the query last changed. A search holds
// the path to each match open without writing to userExpanded — clearing the
// box brings every stored choice back — but a row someone clicks mid-search
// must answer the click, not snap back open, so the hold lets go of these.
const touched = new Set();

// Whether a row is drawn open: held open while a search has a match beneath
// it, else open unless the person closed it.
function openOf(row, search) {
  if (search && search.below.has(row.id) && !touched.has(row.id)) return true;
  return isOpen(row);
}

function forgetGone(rows) {
  const present = new Set();
  const stack = [...rows];
  while (stack.length) {
    const row = stack.pop();
    if (present.has(row.id)) continue;
    present.add(row.id);
    stack.push(...row.children);
  }
  for (const id of userExpanded.keys()) if (!present.has(id)) userExpanded.delete(id);
  for (const id of touched) if (!present.has(id)) touched.delete(id);
}

// Collapse all / Expand all: stored exactly as a click on each row would be,
// so the choice outlives every poll. Not
// marked touched: a search still holds its matches' paths open, since hiding
// what someone just searched for is never what "Collapse all" meant.
function setAll(open) {
  if (!lastView) return;
  const seen = new Set();
  const stack = [...lastView.rows];
  while (stack.length) {
    const row = stack.pop();
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    if (row.children.length) userExpanded.set(row.id, open);
    stack.push(...row.children);
  }
  render(lastView);
}

// What the one Collapse all / Expand all button offers: Collapse all while a
// drawn row is open by the person's choice, else Expand all. Only \`drawn\`
// rows count: a row shut by hand keeps its children's state out of sight, and
// a Collapse all over a screen of shut rows would change nothing anyone could
// see. A shut Not admitted or Done lane's rows are drawn all the same — it
// opens natively, with no render to relabel the button. A row a search holds
// open counts by the person's choice, not by the hold, which setAll leaves be:
// read by the hold, a held path would keep the button on a Collapse all that
// no click could ever answer.
function anyOpen(rows, drawn) {
  const seen = new Set();
  const stack = [...rows];
  while (stack.length) {
    const row = stack.pop();
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    if (drawn.has(row.id) && row.children.length && isOpen(row)) return true;
    stack.push(...row.children);
  }
  return false;
}

// The button's text is its accessible name, so a screen reader hears the same
// offer a sighted person reads. Rewritten only on a change: the same words
// every poll could be re-announced on a focused button.
function labelToggleAll(open) {
  collapsesAll = open;
  const text = open ? "Collapse all" : "Expand all";
  if (toggleAll.textContent !== text) toggleAll.textContent = text;
}

// Title or id, ignoring case — the id also as "#12", the way every row prints it.
function matches(row, q) {
  return row.title.toLowerCase().includes(q) || ("#" + row.id).toLowerCase().includes(q);
}

// The query as the search reads it: blank-trimmed, case folded.
function normalise(query) {
  return query.trim().toLowerCase();
}

// Which rows the query matches, and which have a match somewhere beneath
// them; null when the box is blank. Worked out afresh from the view and the
// box on every render, so a poll redraws the same search over fresh data.
function searchOf(rows, query) {
  const q = normalise(query);
  if (!q) return null;
  const self = new Set();
  const below = new Set();
  const seen = new Set();
  const walk = (row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    let under = false;
    for (const child of row.children) if (walk(child)) under = true;
    if (under) below.add(row.id);
    if (matches(row, q)) self.add(row.id);
    return under || self.has(row.id);
  };
  for (const row of rows) walk(row);
  return { self, below };
}

function shows(row, search) { return !search || search.self.has(row.id) || search.below.has(row.id); }

// The open/closed state a person last gave each collapsible lane (Not
// admitted, Done). A search opens a lane holding a match without writing
// here, so when the search ends the lane goes back to exactly this.
const laneChoice = new Map();
// Collapsible lanes a person toggled since the query last changed: the search
// stops holding these open, so a click mid-search is answered, not undone by
// the next poll — the lane twin of \`touched\`.
const touchedLanes = new Set();

// A click (or Enter/Space) on a lane's summary, which runs before the browser
// flips \`open\`: the state being given is the opposite of the current one.
function chooseLane(lane) {
  laneChoice.set(lane.dataset.lane, !lane.open);
  touchedLanes.add(lane.dataset.lane);
}

// Whether a search was showing at the last render, so render() can tell a
// search starting or ending from one carrying on.
let searching = false;

// The query the last input event left, as the search reads it.
let lastQuery = "";

// A new query holds its own matches' paths open again — clicks made under the
// last query were about that query's results. Only a change the search can
// see counts: a trailing space or a change of case is the same search, and
// clearing on it would snap back open a row someone just closed.
function onQuery(value) {
  const q = normalise(value);
  if (q === lastQuery) return;
  lastQuery = q;
  touched.clear();
  touchedLanes.clear();
}

// \`holds\`: a search is on and this lane has a matching branch. When a search
// starts, the lane's current state is recorded as the person's — however it
// got that way — and it is put back when the search ends. Between searches
// the lane is never touched, so nothing here fights a person's own toggle.
function syncDetails(lane, holds, started, ended) {
  const id = lane.dataset.lane;
  if (started) laneChoice.set(id, lane.open);
  if (holds && !touchedLanes.has(id)) lane.open = true;
  else if (ended && laneChoice.has(id)) lane.open = laneChoice.get(id);
}

// Keyed like every other control, so render()'s restore-by-key keeps a
// keyboard user on this link across a poll instead of dropping them to <body>.
function external(a, row) {
  a.href = row.link;
  a.setAttribute("data-key", row.id + ":link");
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

// The mark with no name beside it: the name is the mark's tooltip and its
// accessible name instead, so the row reads mark, title, ↗ and still says
// whose it is to anyone who hovers or listens.
function systemMark(system) {
  const mark = el("span", "inline-flex shrink-0");
  mark.title = system.name;
  mark.setAttribute("role", "img");
  mark.setAttribute("aria-label", system.name);
  mark.append(systemIcon(system.icon));
  return mark;
}

function treeItem(row, depth, cls, open) {
  const li = el("li", cls + " " + indentOf(depth) + (row.closed === "dropped" ? " opacity-50" : ""));
  li.setAttribute("role", "treeitem");
  // The tree is drawn flat, one <li> per visible node, so depth is told to
  // assistive tech here rather than by nesting.
  li.setAttribute("aria-level", String(depth + 1));
  if (row.children.length) li.setAttribute("aria-expanded", open ? "true" : "false");
  return li;
}

// The ▸/▾ in front of any row with children — ticket or artifact, since a
// document can sit under a pull request too, and a row nobody can open would
// hide its children for good. A row with no children gets nothing, not a
// blank of the same size. Keyed like the menu, so render()'s restore-by-key
// keeps a keyboard user's focus on it across the re-render its own click causes.
function toggleFor(row, open) {
  const toggle = el("button", "inline-flex h-4 w-4 shrink-0 items-center justify-center text-neutral-400", open ? "▾" : "▸");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
  toggle.setAttribute("aria-label", (open ? "Collapse " : "Expand ") + row.title);
  toggle.setAttribute("data-key", row.id + ":toggle");
  // Redrawn at once from the view already on screen — render() reads
  // userExpanded, so there is no second drawing path — and never held on a
  // /board.json round trip that may be slow or fail. The poll it brings
  // forward then catches up whatever the server has changed since.
  toggle.addEventListener("click", () => {
    userExpanded.set(row.id, !open);
    touched.add(row.id);
    render(lastView);
    schedulePoll(0);
  });
  return toggle;
}

function ticketRowFor(row, depth, now, open) {
  // Stacked below the sm breakpoint, side-by-side above it — a breakpoint, not a
  // content-based flex-wrap. flex-wrap's own line-breaking runs on each
  // item's *hypothetical* (content) size: flex-1's 0% basis told the browser
  // this row needed no room at all and it never wrapped the action button
  // down, while flex-auto's content-sized basis wrapped the button down but
  // then sized the title/stage row itself off the unwrapped content width,
  // pushing the stage chip past the edge instead. Neither reliably fits
  // arbitrary ticket titles at 400px, so the breakpoint sidesteps both.
  const li = treeItem(row, depth, "flex flex-col gap-1 py-3 pr-4 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between sm:gap-x-3 sm:gap-y-1", open);
  // The toggle, when there is one, is a column of its own beside the body:
  // inside the title line it pushed the number right but not the note or a
  // wrapped chip, which then started under the toggle instead of the number.
  const main = el("div", "flex min-w-0 w-full items-baseline gap-2 sm:w-auto sm:flex-1");
  if (row.children.length) main.append(toggleFor(row, open));
  const body = el("div", "min-w-0 flex-1");

  const top = el("div", "flex flex-wrap items-baseline gap-x-2 gap-y-1");
  const num = el("span", "num shrink-0 font-mono text-sm text-blue-600 dark:text-blue-400");
  if (row.link) num.append(external(el("a", null, "#" + row.id + " ↗"), row));
  else num.textContent = "#" + row.id;
  // No flex-grow: title takes only the room its own text needs (shrinking,
  // via min-w-0, when that's not enough), so the stage chip sits right after
  // it — flex-1 here previously grew title to fill *all* of main's leftover
  // width, shoving the chip down to the row's far edge, next to the action
  // button, instead of next to the title it names.
  top.append(num, el("span", "title min-w-0 font-medium text-neutral-900 dark:text-neutral-100", row.title));
  // No stage at all (a halted ticket, say) shows no chip — not an empty or
  // placeholder one. A row with a round but no stage cannot happen (round is
  // only ever set alongside a running row's own stage), so this only ever
  // omits the chip, never leaves a lone "· r2" behind.
  if (row.stage) {
    const stage = row.round ? row.stage + " · r" + row.round : row.stage;
    top.append(el("span", "stage shrink-0 rounded border border-neutral-200 px-1.5 py-0.5 font-mono text-[11px] text-neutral-500 dark:border-neutral-700 dark:text-neutral-400", stage));
  }
  if (row.badge && BADGES[row.badge]) {
    const [label, cls] = BADGES[row.badge];
    top.append(el("span", "badge shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium " + cls, label));
  }
  // A ticket row names no system: its tracker is the whole board's, and the
  // mark earns its place only on an artifact row, where it tells a pull
  // request from a document. An unset priority shows nothing rather than a
  // placeholder chip on every row.
  if (typeof row.priority === "number") {
    top.append(el("span", "priority shrink-0 font-mono text-[11px] text-neutral-500 dark:text-neutral-400", "P" + row.priority));
  }

  const bottom = el("div", "mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-neutral-500 dark:text-neutral-400");
  bottom.append(el("span", "note", row.closed === "dropped" ? "dropped" : row.note));
  if (row.model) {
    bottom.append(el("span", "model rounded border border-neutral-200 px-1 font-mono dark:border-neutral-700", row.model));
  }
  if (typeof row.since === "number") {
    bottom.append(el("span", "clock font-mono tabular-nums", elapsed(row.since, now)));
  }

  body.append(top, bottom);
  main.append(body);
  li.append(main);
  if (row.chat) li.append(actionFor(row));
  return li;
}

// A pull request, a document — anything that is not a ticket — as one line:
// its system's mark, its title, and ↗ at the far edge, the whole line one link
// that opens in a new tab. The mark already tells a pull request from a
// published page and the title tells two of them apart; the system's name,
// the kind and the summary beside them only crowded the title out, so the
// name and kind live in the mark's tooltip and the link's accessible name.
// No link, no anchor: a row that goes nowhere must not look like it does.
function artifactRowFor(row, depth, open) {
  const li = treeItem(row, depth, "flex items-center gap-2 py-1 pr-4 text-sm", open);
  // The padding is the link's own, so the whole band it lights up on hover
  // is what a click lands on; the negative margin puts the mark back in the
  // column a ticket's number takes at this depth.
  const line = row.link
    ? external(el("a", "-mx-2 flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:bg-neutral-800 dark:focus-visible:outline-blue-400"), row)
    : el("span", "flex min-w-0 flex-1 items-center gap-2 py-1.5");
  if (row.system && row.system.icon) line.append(systemMark(row.system));
  line.append(el("span", "min-w-0 truncate text-neutral-700 dark:text-neutral-300", row.title));
  if (row.link) {
    const kind = row.kind.replace(/-/g, " ");
    line.setAttribute("aria-label", row.title + ", " + kind + (row.system ? " on " + row.system.name : "") + ", opens in a new tab");
    const arrow = el("span", "ml-auto shrink-0 text-neutral-400 dark:text-neutral-500", "↗");
    arrow.setAttribute("aria-hidden", "true");
    line.append(arrow);
  }
  if (row.children.length) li.append(toggleFor(row, open));
  li.append(line);
  return li;
}

// Depth-first, drawing a row's children only while it is open. \`seen\` is the
// cycle guard's second half: the server already draws each node once, and
// this makes sure a board.json that somehow did not still cannot hang the tab.
// Under a search, a row is drawn only if it matches, leads to a match, or
// sits inside a matched row — whose children are drawn whole, so a matched
// parent opens onto everything beneath it like any other row.
function treeRows(rows, depth, seen, now, out, search, inMatch) {
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    if (!inMatch && !shows(row, search)) continue;
    seen.add(row.id);
    const open = row.children.length > 0 && openOf(row, search);
    out.push(row.kind === "ticket" ? ticketRowFor(row, depth, now, open) : artifactRowFor(row, depth, open));
    if (open) treeRows(row.children, depth + 1, seen, now, out, search, inMatch || (search !== null && search.self.has(row.id)));
  }
  return out;
}

let nextTickAt = null;

function countdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + ":" + String(s).padStart(2, "0");
}

function renderNext() {
  document.getElementById("next").textContent =
    nextTickAt === null ? "No tick scheduled" : "Next tick in " + countdown(nextTickAt - Date.now());
}

// What the last poll drew, so a toggle can redraw without waiting on the next.
let lastView = null;

// The box sits outside every lane, so no render ever replaces it: its text,
// focus and caret survive each poll untouched, and render() reads the query
// back out of it every time.
const searchBox = document.getElementById("search");
searchBox.addEventListener("input", () => { onQuery(searchBox.value); if (lastView) render(lastView); });
// Outside every lane like the box, so a poll never replaces it and a keyboard
// user on it stays there. \`collapsesAll\` is what a click does right now,
// kept in step with the label by labelToggleAll.
const toggleAll = document.getElementById("toggle-all");
let collapsesAll = true;
toggleAll.addEventListener("click", () => setAll(!collapsesAll));
for (const lane of document.querySelectorAll("details[data-lane]")) {
  lane.querySelector("summary").addEventListener("click", () => chooseLane(lane));
}

function render(view) {
  lastView = view;
  const now = Date.now();
  // Every row's DOM (and any menu/focus it held) is about to be replaced
  // below — a fresh set of elements for the same nodes. Note what was
  // open/focused by key *before* that happens, so it can be restored by key
  // *after*: a poll landing mid-read must never cost the user their place.
  const activeKey = document.activeElement && typeof document.activeElement.getAttribute === "function"
    ? document.activeElement.getAttribute("data-key")
    : null;
  const wasOpen = openMenuKey;

  forgetGone(view.rows);
  const search = searchOf(view.rows, searchBox.value);
  const started = search !== null && !searching;
  const ended = search === null && searching;
  searching = search !== null;
  // One seen-set for the whole page: a node is drawn once, in one lane.
  const seen = new Set();
  let matched = 0;
  for (const lane of document.querySelectorAll("[data-lane]")) {
    // Whole branches, filed by their root's lane — the server's cascade — and
    // counted as branches, so a lane's number is how many things to look at.
    const roots = view.rows.filter((r) => r.lane === lane.dataset.lane && shows(r, search));
    const items = treeRows(roots, 0, seen, now, [], search, false);
    lane.querySelector("ul").replaceChildren(
      ...(items.length ? items : [el("li", "px-4 py-6 text-sm italic text-neutral-400 dark:text-neutral-600", "None")]),
    );
    lane.querySelector(".lane-count").textContent = String(roots.length);
    // Without a query every lane stays, saying "None" when empty — a lane that
    // vanished would read as a fault. With one, a lane nothing matched is noise.
    lane.hidden = search !== null && roots.length === 0;
    // A match inside a closed Not admitted / Done lane would show only as a count.
    if (lane.tagName === "DETAILS") syncDetails(lane, search !== null && roots.length > 0, started, ended);
    matched += roots.length;
  }
  // \`seen\` now holds every row just drawn, in every lane.
  labelToggleAll(anyOpen(view.rows, seen));
  // Only on a change: rewriting the same words every poll could re-announce them.
  const status = document.getElementById("no-match");
  const said = search !== null && matched === 0 ? "Nothing matches." : "";
  if (status.textContent !== said) status.textContent = said;
  document.getElementById("folder").textContent = view.folder;
  const listed = view.listedAt === null ? "waiting for the first tick" : "listed " + elapsed(view.listedAt, now) + " ago";
  document.getElementById("meta").textContent = listed;
  nextTickAt = view.nextTickAt;
  renderNext();

  // Restore the open menu by key, on the freshly built elements — or drop it
  // if that node is no longer in this view (nothing left to point at).
  if (wasOpen !== null) {
    if (byKey(menuKeyOf(wasOpen)) && byKey(triggerKeyOf(wasOpen))) {
      applyMenuState(null);
    } else {
      openMenuKey = null;
      clearIdleTimer();
    }
  }
  // Restore focus by key too, independently of any open menu — a keyboard
  // user tabbed onto a trigger doesn't need a menu open to have earned this.
  if (activeKey) {
    const toFocus = byKey(activeKey);
    if (toFocus) toFocus.focus();
  }
}

// Between polls, the countdown still moves: the board only reports
// nextTickAt every POLL_MS, and a number that jumped in two-second steps
// would read as a bug rather than a clock.
setInterval(renderNext, 1000);

// A single self-rescheduling timer, so the button's "202 -> re-poll now"
// cancels whatever poll was already pending rather than layering a second
// chain of them on top of it.
let pollTimer = null;

async function pollOnce() {
  try {
    const res = await fetch("/board.json", { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    // Renders unconditionally, menu open or not: render() itself restores
    // the open menu and the focused control by key (see its own comment),
    // so a poll landing mid-read costs nothing — no held view, no freeze.
    render(await res.json());
  } catch {
    document.getElementById("meta").textContent = "landrace is not responding";
  }
}

function schedulePoll(delay) {
  if (pollTimer !== null) clearTimeout(pollTimer);
  pollTimer = setTimeout(() => { pollOnce().then(() => schedulePoll(POLL_MS)); }, delay);
}

const tickButton = document.getElementById("tick");
const TICK_LABEL = tickButton.textContent;
let restoreTimer = null;

function setTickButton(text, disabled) {
  tickButton.textContent = text;
  tickButton.disabled = disabled;
}

function restoreAfter(ms) {
  if (restoreTimer !== null) clearTimeout(restoreTimer);
  restoreTimer = setTimeout(() => setTickButton(TICK_LABEL, false), ms);
}

tickButton.addEventListener("click", () => {
  if (restoreTimer !== null) clearTimeout(restoreTimer);
  setTickButton("starting…", true);
  fetch("/tick", { method: "POST", headers: { "x-landrace-action": "tick" } }).then(
    (res) => {
      if (res.status === 202) {
        setTickButton(TICK_LABEL, false);
        schedulePoll(0);
      } else if (res.status === 409) {
        setTickButton("tick running", true);
        restoreAfter(3000);
      } else {
        setTickButton("failed", true);
        restoreAfter(3000);
      }
    },
    () => {
      setTickButton("failed", true);
      restoreAfter(3000);
    },
  );
});

pollOnce().then(() => schedulePoll(POLL_MS));

const themeToggle = document.getElementById("theme-toggle");

function isDark() {
  return document.documentElement.classList.contains("dark");
}

// /theme.js already set the class before this script even ran (it loads
// first, with no defer, for exactly that reason) — this only ever syncs the
// label to whatever that decided, never the other way round.
function syncThemeLabel() {
  themeToggle.setAttribute("aria-label", isDark() ? "Switch to light mode" : "Switch to dark mode");
}

themeToggle.addEventListener("click", () => {
  const dark = !isDark();
  document.documentElement.classList.toggle("dark", dark);
  try { localStorage.setItem(THEME_KEY, dark ? "dark" : "light"); } catch (e) {}
  syncThemeLabel();
});

syncThemeLabel();
`;
