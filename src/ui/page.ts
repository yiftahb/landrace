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
  "rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800";

// The composer's one primary action: filled, so Reply reads as the thing to do.
const PRIMARY_BUTTON =
  "rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-500 dark:hover:bg-blue-400";

const ICON_BUTTON =
  "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800";

/**
 * The item panel: fixed to the right, the board pushed left beside it from
 * `sm` up and covered by it below. A static skeleton the script fills with
 * textContent — the composer lives here, outside anything a poll redraws, so
 * what someone is typing survives every poll.
 */
const PANEL = `
<aside id="panel" hidden aria-label="Item" class="fixed inset-y-0 right-0 z-20 flex w-full flex-col border-l border-neutral-200 bg-white shadow-xl dark:border-neutral-800 dark:bg-neutral-900 sm:w-[28rem]">
<div class="flex items-start gap-2 border-b border-neutral-100 px-4 py-3 dark:border-neutral-800">
<h2 id="panel-title" class="min-w-0 flex-1 break-words text-sm font-semibold"></h2>
<div class="relative shrink-0">
<button id="panel-more" type="button" aria-label="Item actions" aria-haspopup="menu" aria-expanded="false" title="Item actions" data-key="panel:trigger" class="${ICON_BUTTON}">⋯</button>
<div id="panel-menu" data-key="panel:menu" role="menu" hidden class="absolute right-0 z-10 mt-1 w-44 overflow-hidden rounded-md border border-neutral-200 bg-white py-1 text-xs shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
<button id="panel-pairing-item" type="button" role="menuitem" class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-neutral-700 hover:bg-neutral-50 dark:text-neutral-200 dark:hover:bg-neutral-800">Pairing…</button>
</div>
</div>
<button id="panel-wide" type="button" aria-label="Full width" aria-pressed="false" title="Full width" class="${ICON_BUTTON}">⤢</button>
<button id="panel-close" type="button" aria-label="Close" title="Close (Esc)" class="${ICON_BUTTON}">✕</button>
</div>
<div id="panel-top" class="border-b border-neutral-100 px-4 py-3 text-xs dark:border-neutral-800"></div>
<div id="panel-pairing" hidden class="border-b border-neutral-100 px-4 py-3 text-xs dark:border-neutral-800"></div>
<div id="panel-bottom" class="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-xs"></div>
<div id="panel-composer" hidden class="border-t border-neutral-100 px-4 py-3 dark:border-neutral-800">
<textarea id="panel-message" rows="3" aria-label="Message" placeholder="Write to the step…" class="block w-full resize-y rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500"></textarea>
<div class="mt-2 flex flex-wrap items-center gap-2">
<button id="panel-reply" type="button" title="Reply (Ctrl+Enter or ⌘+Enter)" aria-keyshortcuts="Control+Enter Meta+Enter" class="${PRIMARY_BUTTON}">Reply <kbd id="panel-reply-keys" aria-hidden="true" class="ml-1 font-sans opacity-80"></kbd></button>
<button id="panel-ask" type="button" class="${BUTTON}">Ask the step</button>
<button id="panel-resolve" type="button" class="${BUTTON}">Resolve</button>
</div>
<p id="panel-status" role="status" aria-live="polite" class="mt-2 text-xs text-neutral-500 empty:hidden dark:text-neutral-400"></p>
<div id="panel-chat" class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500 dark:text-neutral-400"></div>
</div>
</aside>`;

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
<button id="notify-toggle" type="button" aria-pressed="false" aria-label="Notify me when an item needs you" title="Notify me when an item needs you" class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-neutral-500 opacity-50 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800">🔔</button>
<button id="theme-toggle" type="button" aria-label="Switch to dark mode" class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50 dark:text-neutral-400 dark:hover:bg-neutral-800">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4 dark:hidden" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="hidden h-4 w-4 dark:block" aria-hidden="true"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>
</button>
</div>
</div>
</header>
<main class="mx-auto max-w-5xl px-4 py-6 sm:px-6">
<div id="filters" class="mb-4 flex flex-wrap items-center justify-between gap-2">
<input id="search" type="search" placeholder="Search items…" aria-label="Search items" autocomplete="off" spellcheck="false" class="w-full rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-sm text-neutral-900 placeholder:text-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500 sm:w-72">
<div class="flex items-center gap-2">
<button id="toggle-all" type="button" aria-keyshortcuts="c" title="Collapse all (c)" class="${BUTTON}">Collapse all</button>
<button id="refresh" type="button" aria-label="Refresh" title="Re-read the tracker" class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50 dark:text-neutral-400 dark:hover:bg-neutral-800">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"></path><polyline points="21 3 21 9 15 9"></polyline></svg>
</button>
</div>
</div>
<p id="no-match" role="status" aria-live="polite" class="mb-4 px-1 text-sm italic text-neutral-400 empty:hidden dark:text-neutral-500"></p>
${lane("needs-you", "Needs you", " border-l-4 border-l-rose-500 [&_h2]:text-rose-600 dark:[&_h2]:text-rose-400 [&_.lane-count]:bg-rose-100 [&_.lane-count]:text-rose-700 dark:[&_.lane-count]:bg-rose-950 dark:[&_.lane-count]:text-rose-300")}
${lane("running", "Agent running", " border-l-4 border-l-emerald-500 [&_h2]:text-emerald-600 dark:[&_h2]:text-emerald-400 [&_.lane-count]:bg-emerald-100 [&_.lane-count]:text-emerald-700 dark:[&_.lane-count]:bg-emerald-950 dark:[&_.lane-count]:text-emerald-300", RUNNING_DOT)}
${lane("elsewhere", "Held elsewhere", " border-l-4 border-l-amber-500 [&_h2]:text-amber-600 dark:[&_h2]:text-amber-400 [&_.lane-count]:bg-amber-100 [&_.lane-count]:text-amber-700 dark:[&_.lane-count]:bg-amber-950 dark:[&_.lane-count]:text-amber-300")}
${lane("waiting", "Waiting", " border-l-4 border-l-neutral-300 dark:border-l-neutral-700 [&_h2]:text-neutral-500 dark:[&_h2]:text-neutral-400 [&_.lane-count]:bg-neutral-100 [&_.lane-count]:text-neutral-600 dark:[&_.lane-count]:bg-neutral-800 dark:[&_.lane-count]:text-neutral-300")}
${collapsedLane("not-admitted", "Not admitted")}
${collapsedLane("discharged", "Done")}
</main>
${PANEL}
</body>
</html>
`;

const THEME_KEY = "landrace-theme";

/** Whether the 🔔 is on, per browser: a person's choice for this page, never the server's. */
const NOTIFY_KEY = "landrace-notify";

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
const NOTIFY_KEY = ${JSON.stringify(NOTIFY_KEY)};

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

// Per write — "<id>:retry", "<id>:goto:<stage>" — what the last attempt heard
// back when it did not go through, and which are still waiting on the server.
// Module state rather than the DOM's, because every poll rebuilds every menu:
// a sentence written only into a button would be gone two seconds later.
const writeNotes = new Map();
const writing = new Set();

// Items a write just went through for, by id: the lane the server had each
// in, when, and the ticks armed since. The server moves an item only once a
// tick lists the tracker again — up to a whole interval after the click, and
// a Reply wakes no tick at all — so until then the page shows it in Waiting.
// ponytail: top-level rows only; a child's lane is its root's, and stays put.
const moves = new Map();

function moved(id) {
  const row = lastView && lastView.rows.find((r) => r.id === id);
  // No tick scheduled, nothing will move it: Waiting would be a lie.
  if (row && lastView.nextTickAt !== null) moves.set(id, { lane: row.lane, next: lastView.nextTickAt, ticks: 0, at: Date.now() });
}

// A fresh view with each moving item in Waiting, until the server moves it
// itself or two ticks have been armed since — one came and went and left it
// where it was, so the server's word stands again.
function withMoves(view, moves) {
  for (const [id, m] of moves) {
    if (view.nextTickAt !== m.next) { m.ticks += 1; m.next = view.nextTickAt; }
    const row = view.rows.find((r) => r.id === id);
    if (!row || row.lane !== m.lane || m.ticks >= 2 || view.nextTickAt === null) moves.delete(id);
  }
  if (moves.size === 0) return view;
  return {
    ...view,
    rows: view.rows.map((r) => {
      const m = moves.get(r.id);
      // Nothing left to click: the server has taken one write, and would
      // judge a second against the state the first is leaving.
      return m ? { ...r, lane: "waiting", badge: "waiting", note: "Sent — moves on the next tick", since: m.at, retry: null, clear: null, goto: [] } : r;
    }),
  };
}

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
  // A refusal is shown for the menu it was asked from, not for good. Keyed
  // by write, so every note under this menu's item goes.
  const prefix = previous.slice(0, previous.length - "menu".length);
  for (const key of [...writeNotes.keys()]) if (key.startsWith(prefix)) writeNotes.delete(key);
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
// Whether focus is somewhere a "c" is a letter someone is typing, not a
// shortcut — the search box above all, but any field or contenteditable
// reads the same way.
function isTypingTarget(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

// Escape closes whatever row menu is open, else the item panel; an
// unmodified "c" answers a click on Collapse all / Expand all — never while
// it would be typed instead, and never while a row's own menu is open, so its
// own keys are never raced.
function onKeydown(e) {
  if (e.key === "Escape") {
    if (openMenuKey !== null) closeMenu({ returnFocus: true });
    else if (panelId !== null) closePanel();
    return;
  }
  if (e.key === "c" && !e.ctrlKey && !e.metaKey && !e.altKey && openMenuKey === null && !isTypingTarget(document.activeElement)) {
    toggleAll.click();
    return;
  }
  if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !e.ctrlKey && !e.metaKey && !e.altKey && openMenuKey === null && onBoard(document.activeElement)) {
    e.preventDefault();
    stepFocus(e.key === "ArrowDown" ? 1 : -1);
    return;
  }
  if (openMenuKey !== null) resetIdleTimer();
}
document.addEventListener("keydown", onKeydown);

// Where an arrow walks the list: nothing focused, or anything on the board
// that is not a field. The panel's own keys stay its own.
function onBoard(el) {
  if (!el || el === document.body) return true;
  return !isTypingTarget(el) && typeof el.closest === "function" && el.closest("main") !== null;
}

// The item titles on screen, in the order drawn — a closed lane's or a
// search-hidden one's take no focus — and the one a step lands on: the next
// or previous from the row focus is in, the first or last from none.
// checkVisibility, not boxes: Chromium lays out a closed <details>' content
// and refuses focus there silently, so with every item in a collapsed Done
// the arrows walked into it and nothing moved.
function stepFocus(by) {
  const titles = [...document.querySelectorAll('[data-key$=":open"]')].filter((t) => t.checkVisibility());
  if (!titles.length) return;
  const active = document.activeElement;
  const here = active && typeof active.closest === "function" ? active.closest('[role="treeitem"]') : null;
  const at = here ? titles.findIndex((t) => t.closest('[role="treeitem"]') === here) : -1;
  const next = titles[at === -1 ? (by > 0 ? 0 : titles.length - 1) : Math.min(titles.length - 1, Math.max(0, at + by))];
  next.focus();
  next.scrollIntoView({ block: "nearest" });
}

function menuItem(tag) {
  const node = el(tag, "flex w-full items-center gap-2 px-3 py-1.5 text-left text-neutral-700 hover:bg-neutral-50 dark:text-neutral-200 dark:hover:bg-neutral-800");
  node.setAttribute("role", "menuitem");
  return node;
}

// One of an item's writes — Retry, or a step to send it back to. Offered
// only where the server put a path in the row, and posted to that path alone.
function writeItem(w) {
  const item = menuItem("button");
  item.type = "button";
  item.setAttribute("data-key", w.key);
  // Its own label is what changes, so that is what a screen reader is told.
  item.setAttribute("aria-live", "polite");
  const busy = writing.has(w.key);
  item.textContent = busy ? w.busy : (writeNotes.get(w.key) || w.label);
  item.disabled = busy;
  item.addEventListener("click", () => send(w));
  return item;
}

// Each write re-runs a paid step, so it asks first. The server checks again
// that the item may go there now, and what it says when it refuses is
// shown where it was asked.
function send(w) {
  if (writing.has(w.key)) return;
  if (!confirm(w.ask)) return;
  writing.add(w.key);
  writeNotes.delete(w.key);
  if (lastView) render(lastView);
  fetch(w.path, { method: "POST", headers: { "x-landrace-action": w.action } })
    .then((res) => (res.ok ? null : res.text().then((text) => text || w.label + " failed", () => w.label + " failed")))
    .then(null, () => w.label + " failed: landrace is not responding")
    .then((problem) => {
      writing.delete(w.key);
      if (problem === null) {
        moved(w.id);
        closeMenu({ returnFocus: true });
        schedulePoll(0);
        return;
      }
      writeNotes.set(w.key, problem);
      if (lastView) render(lastView);
    });
}

// A stopped item's Retry — back to the step that failed — and the steps
// its stage may send it back to, under a caption that is not itself a menu item.
function writesOf(row) {
  const items = [];
  if (row.retry) {
    items.push(writeItem({
      id: row.id, key: row.id + ":retry", label: "Retry", busy: "Retrying…", path: row.retry, action: "retry",
      ask: "Retry #" + row.id + "? This sends it back to the step that failed and re-runs a paid step.",
    }));
  }
  // A screened item's overrule: the refused step's next round runs once
  // without the security check. The server re-reads the item and alone
  // decides; this is only its offer.
  if (row.clear) {
    items.push(writeItem({
      id: row.id, key: row.id + ":clear", label: "Clear & retry", busy: "Clearing…", path: row.clear, action: "clear",
      ask: "Retry #" + row.id + " without the security check? Its next round runs once unscreened — only if you have " +
        "read what was refused and trust it. Anything written on the item after this voids it.",
    }));
  }
  const targets = row.goto || [];
  if (targets.length) {
    const caption = el("div", "px-3 pt-2 pb-1 text-[11px] text-neutral-500 dark:text-neutral-400", "Go to step…");
    caption.setAttribute("role", "presentation");
    items.push(caption);
    for (const g of targets) {
      items.push(writeItem({
        id: row.id, key: row.id + ":goto:" + g.stage, label: g.stage, busy: "Sending…", path: g.path, action: "goto",
        ask: "Send #" + row.id + " back to " + g.stage + "? This re-runs a paid step.",
      }));
    }
  }
  return items;
}

// A row's actions: its writes (Retry, Go to step…), if the server offered
// any, then a divider, then the Chat caption and its targets — the same menu
// regardless of which row's ⋯ opens it (see actionFor).
function buildRowMenu(row) {
  const menu = el("div", "absolute right-0 z-10 mt-1 w-44 overflow-hidden rounded-md border border-neutral-200 bg-white py-1 text-xs shadow-lg dark:border-neutral-700 dark:bg-neutral-900");
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  const writes = writesOf(row);
  // Pairing… opens the item's panel on its Pairing section, which asks the
  // server what may be paired on — the row itself cannot tell.
  if (row.panel) {
    const pairing = menuItem("button");
    pairing.type = "button";
    pairing.textContent = "Pairing…";
    pairing.setAttribute("data-key", row.id + ":pairing");
    pairing.addEventListener("click", () => { closeMenu(); openPairing(row.id); });
    writes.unshift(pairing);
  }
  if (writes.length) menu.append(...writes, el("hr", "my-1 border-neutral-100 dark:border-neutral-800"));
  const chatCaption = el("div", "px-3 pt-2 pb-1 text-[11px] text-neutral-500 dark:text-neutral-400", "Chat");
  chatCaption.setAttribute("role", "presentation");
  menu.append(chatCaption);
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

// The "⋯" slot on the right of every row with actions — bordered for extra
// emphasis on a needs-you row, so a row waiting on you still stands out —
// opening the same menu (see buildRowMenu).
function actionFor(row) {
  const needsYou = row.badge === "needs-you";
  const button = el(
    "button",
    needsYou
      ? "inline-flex items-center gap-1 rounded-md border border-neutral-200 px-2 py-1 text-xs font-medium text-neutral-700 dark:border-neutral-700 dark:text-neutral-300"
      : "inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 dark:text-neutral-500",
    "⋯",
  );
  button.type = "button";
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("data-key", triggerKeyOf(row.id));
  button.setAttribute("aria-label", "Actions");

  const wrap = el("div", "relative shrink-0 self-start sm:self-auto");
  const menu = buildRowMenu(row);
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
// item someone came to look at. An entry lives until its node leaves the
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
// every poll could be re-announced on a focused button. The title carries the
// same word plus the "c" shortcut that answers it, so a hover tells the same
// story a keyboard user already knows.
function labelToggleAll(open) {
  collapsesAll = open;
  const text = open ? "Collapse all" : "Expand all";
  if (toggleAll.textContent !== text) toggleAll.textContent = text;
  const title = text + " (c)";
  if (toggleAll.title !== title) toggleAll.title = title;
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

// What an artifact is, ahead of where it lives: a pull request coloured by
// its state, a document as a page. Stroked in currentColor so a dark: class
// themes it, drawn inline like every mark here, and named for a hover or a
// screen reader. A kind with no glyph gets none rather than a guess.
function kindMark(row) {
  let name, colour, shapes;
  if (row.kind === "pull-request") {
    if (row.closed === "done") [name, colour] = ["Merged pull request", "text-purple-600 dark:text-purple-400"];
    else if (row.closed === "dropped") [name, colour] = ["Closed pull request", "text-red-600 dark:text-red-400"];
    else [name, colour] = ["Open pull request", "text-green-600 dark:text-green-400"];
    shapes = [["circle", { cx: "4", cy: "3.5", r: "1.75" }], ["circle", { cx: "4", cy: "12.5", r: "1.75" }],
      ["circle", { cx: "12", cy: "12.5", r: "1.75" }], ["path", { d: "M4 5.25v5.5M12 10.75V6.5a2 2 0 0 0-2-2H7.5M9 3 7.5 4.5 9 6" }]];
  } else if (row.kind === "document") {
    [name, colour] = ["Document", "text-neutral-500 dark:text-neutral-400"];
    shapes = [["path", { d: "M4 1.75h5l3.25 3.25v9.25H4zM9 1.75V5h3.25M6 8.5h4M6 11h4" }]];
  } else {
    return null;
  }
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of [["viewBox", "0 0 16 16"], ["width", "14"], ["height", "14"], ["fill", "none"], ["stroke", "currentColor"],
    ["stroke-width", "1.5"], ["stroke-linecap", "round"], ["stroke-linejoin", "round"], ["aria-hidden", "true"]]) svg.setAttribute(k, v);
  for (const [tag, attrs] of shapes) {
    const shape = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) shape.setAttribute(k, attrs[k]);
    svg.append(shape);
  }
  const mark = el("span", "inline-flex shrink-0 " + colour);
  mark.title = name;
  mark.setAttribute("role", "img");
  mark.setAttribute("aria-label", name);
  mark.append(svg);
  return mark;
}

// How long ago, in the one unit that matters at a glance: under an hour in
// minutes, under two days in hours, then days. A clock a little ahead of the
// tracker's reads as "now", never as a negative age.
function ago(at, now) {
  const m = Math.floor((now - at) / 60000);
  if (m < 1) return "now";
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  return h < 48 ? h + "h" : Math.floor(h / 24) + "d";
}

// An item a security check stopped: a shield beside its badge, drawn inline
// — the page loads no image — and named, so hovering or a screen reader says
// what it means rather than leaving an icon to be guessed at.
function shieldMark() {
  const mark = el("span", "inline-flex shrink-0 self-center text-rose-600 dark:text-rose-400");
  const name = "Blocked by a security check";
  mark.title = name;
  mark.setAttribute("role", "img");
  mark.setAttribute("aria-label", name);
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z");
  svg.append(path);
  mark.append(svg);
  return mark;
}

function treeItem(row, depth, cls, open) {
  // The chosen row stands out: focused, or open in the panel (aria-selected).
  // A tint, not a grey: neutral-100 on a white card was there and unseen.
  const chosen = " focus-within:bg-blue-50 dark:focus-within:bg-blue-950 aria-selected:bg-blue-50 dark:aria-selected:bg-blue-950";
  const li = el("li", cls + " " + indentOf(depth) + chosen + (row.closed === "dropped" ? " opacity-50" : ""));
  li.setAttribute("role", "treeitem");
  // The tree is drawn flat, one <li> per visible node, so depth is told to
  // assistive tech here rather than by nesting.
  li.setAttribute("aria-level", String(depth + 1));
  if (row.children.length) li.setAttribute("aria-expanded", open ? "true" : "false");
  return li;
}

// The ▸/▾ in front of any row with children — item or artifact, since a
// document can sit under a pull request too, and a row nobody can open would
// hide its children for good. Keyed like the menu, so render()'s restore-by-key
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

// The toggle's column, kept on every row: a blank of the toggle's width where
// there is nothing to open. Without it a row with children put its number one
// indent step right of a sibling with none — exactly where a child of that
// sibling's goes — and #21, with a spec under it, read as nested under #20.
function toggleSlot(row, open) {
  if (row.children.length) return toggleFor(row, open);
  const blank = el("span", "inline-block h-4 w-4 shrink-0");
  blank.setAttribute("aria-hidden", "true");
  return blank;
}

function itemRowFor(row, depth, now, open) {
  // Stacked below the sm breakpoint, side-by-side above it — a breakpoint, not a
  // content-based flex-wrap. flex-wrap's own line-breaking runs on each
  // item's *hypothetical* (content) size: flex-1's 0% basis told the browser
  // this row needed no room at all and it never wrapped the action button
  // down, while flex-auto's content-sized basis wrapped the button down but
  // then sized the title/stage row itself off the unwrapped content width,
  // pushing the stage chip past the edge instead. Neither reliably fits
  // arbitrary item titles at 400px, so the breakpoint sidesteps both.
  const li = treeItem(row, depth, "flex flex-col gap-1 py-3 pr-4 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between sm:gap-x-3 sm:gap-y-1", open);
  // The toggle, when there is one, is a column of its own beside the body:
  // inside the title line it pushed the number right but not the note or a
  // wrapped chip, which then started under the toggle instead of the number.
  const main = el("div", "flex min-w-0 w-full items-baseline gap-2 sm:w-auto sm:flex-1");
  main.append(toggleSlot(row, open));
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
  // An item's title opens its panel — a button, so a keyboard reaches it too.
  const title = row.panel
    ? el("button", "title min-w-0 cursor-pointer text-left font-medium text-neutral-900 hover:underline dark:text-neutral-100", row.title)
    : el("span", "title min-w-0 font-medium text-neutral-900 dark:text-neutral-100", row.title);
  if (row.panel) {
    title.type = "button";
    title.setAttribute("data-key", row.id + ":open");
    title.addEventListener("click", () => openPanel(row.id));
  }
  top.append(num, title);
  // The workflow that owns the item, small, right after its title. An item
  // no one workflow owns names none: its note already says why.
  if (row.workflow) {
    const workflow = el("span", "workflow shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300", row.workflow);
    workflow.title = "Workflow: " + row.workflow;
    top.append(workflow);
  }
  // No stage at all (a halted item, say) shows no chip — not an empty or
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
  if (row.screened) top.append(shieldMark());
  // An item row names no system: its tracker is the whole board's, and the
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
  // Anywhere else on the row opens the panel too — never a click meant for
  // its own link, toggle, title button or menu.
  if (row.panel) {
    li.classList.add("cursor-pointer");
    li.addEventListener("click", (e) => {
      if (e.target && typeof e.target.closest === "function" && e.target.closest("a, button, [role=menu]")) return;
      openPanel(row.id);
    });
  }
  return li;
}

// A pull request, a document — anything that is not an item — as one line:
// what it is, where it lives, its title, how long ago it was opened, and ↗ at
// the far edge, the whole line one link that opens in a new tab. The two
// marks say kind and system without words; the names beside them only
// crowded the title out, so they live in the marks' tooltips and the link's
// accessible name.
// No link, no anchor: a row that goes nowhere must not look like it does.
function artifactRowFor(row, depth, open, now) {
  const li = treeItem(row, depth, "flex items-center gap-2 py-1 pr-4 text-sm", open);
  // The padding is the link's own, so the whole band it lights up on hover
  // is what a click lands on; the negative margin puts the mark back in the
  // column an item's number takes at this depth.
  const line = row.link
    ? external(el("a", "-mx-2 flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:bg-neutral-800 dark:focus-visible:outline-blue-400"), row)
    : el("span", "flex min-w-0 flex-1 items-center gap-2 py-1.5");
  const kindIcon = kindMark(row);
  if (kindIcon) line.append(kindIcon);
  if (row.system && row.system.icon) line.append(systemMark(row.system));
  line.append(el("span", "min-w-0 truncate text-neutral-700 dark:text-neutral-300", row.title));
  const opened = typeof row.createdAt === "number" ? ago(row.createdAt, now) : null;
  if (opened !== null) {
    // Pushed to the far edge itself, so ↗ follows it rather than splitting the space with it.
    const stamp = el("span", "ml-auto shrink-0 text-xs tabular-nums text-neutral-400 dark:text-neutral-500", opened);
    stamp.title = new Date(row.createdAt).toLocaleString();
    line.append(stamp);
  }
  if (row.link) {
    const kind = row.kind.replace(/-/g, " ");
    line.setAttribute("aria-label", row.title + ", " + kind + (row.system ? " on " + row.system.name : "") +
      (opened === null ? "" : opened === "now" ? ", opened just now" : ", opened " + opened + " ago") + ", opens in a new tab");
    const arrow = el("span", (opened === null ? "ml-auto " : "") + "shrink-0 text-neutral-400 dark:text-neutral-500", "↗");
    arrow.setAttribute("aria-hidden", "true");
    line.append(arrow);
  }
  li.append(toggleSlot(row, open), line);
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
    out.push(row.kind === "item" ? itemRowFor(row, depth, now, open) : artifactRowFor(row, depth, open, now));
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
  // Empty unless a poll failed: a view that landed means landrace is answering.
  document.getElementById("meta").textContent = "";
  nextTickAt = view.nextTickAt;
  renderNext();
  // The panel's top half is this row, so every board poll redraws it too.
  renderPanel();
  markSelected();

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
    render(withMoves(await res.json(), moves));
    // After the render, so a click on a notification opens a panel over the
    // board it was raised from — which render() just kept as lastView.
    const now = needingYou(lastView.rows, new Map(), neededYou);
    for (const row of arrived(neededYou, now)) notifyOf(row);
    neededYou = now;
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

// Both 202s mean the ask was taken. A queued one runs once every tick in
// flight has ended, so the button says so for a moment rather than looking as
// if nothing happened.
function tickAnswered(status, said) {
  if (status === 202 && said === "tick queued") {
    setTickButton("queued", true);
    restoreAfter(3000);
  } else if (status === 202) {
    setTickButton(TICK_LABEL, false);
    schedulePoll(0);
  } else {
    setTickButton("failed", true);
    restoreAfter(3000);
  }
}

tickButton.addEventListener("click", () => {
  if (restoreTimer !== null) clearTimeout(restoreTimer);
  setTickButton("starting…", true);
  fetch("/tick", { method: "POST", headers: { "x-landrace-action": "tick" } })
    .then((res) => res.text().then((said) => tickAnswered(res.status, said)))
    .catch(() => tickAnswered(0, ""));
});

// Re-read the tracker, with no step and no agent — the icon-only twin of the
// tick button, right down to the brief-failure-then-restore shape. Its label
// lives in aria-label and title rather than in visible text, since the
// button itself carries no text to change.
const refreshButton = document.getElementById("refresh");
const REFRESH_LABEL = "Refresh";
const REFRESH_TITLE = "Re-read the tracker";
let refreshRestoreTimer = null;

// Busy while the request is out: the icon spins and the button pulses, since
// a tracker round trip can take seconds and a still button reads as a click
// that never landed. aria-busy says the same to a screen reader.
function setRefreshButton(label, title, disabled, busy) {
  refreshButton.setAttribute("aria-label", label);
  refreshButton.title = title;
  refreshButton.disabled = disabled;
  refreshButton.setAttribute("aria-busy", busy ? "true" : "false");
  refreshButton.classList.toggle("animate-pulse", busy);
  refreshButton.querySelector("svg").classList.toggle("animate-spin", busy);
}

function restoreRefreshAfter(ms) {
  if (refreshRestoreTimer !== null) clearTimeout(refreshRestoreTimer);
  refreshRestoreTimer = setTimeout(() => setRefreshButton(REFRESH_LABEL, REFRESH_TITLE, false, false), ms);
}

// The status alone decides, the way tickAnswered's failure branch does: the
// server's own sentence is for the log the 502 mentions, not for a button
// with no room to show it.
function refreshAnswered(status) {
  if (status === 200) {
    setRefreshButton(REFRESH_LABEL, REFRESH_TITLE, false, false);
    schedulePoll(0);
  } else {
    setRefreshButton("failed", "failed", true, false);
    restoreRefreshAfter(3000);
  }
}

refreshButton.addEventListener("click", () => {
  if (refreshRestoreTimer !== null) clearTimeout(refreshRestoreTimer);
  setRefreshButton("Refreshing…", "Refreshing…", true, true);
  fetch("/refresh", { method: "POST", headers: { "x-landrace-action": "refresh" } })
    .then((res) => refreshAnswered(res.status))
    .catch(() => refreshAnswered(0));
});

// ---- the item panel -------------------------------------------------------

// Faster than the board's own poll, so a running step's tool lines land
// within two seconds of the agent reporting them.
const PANEL_POLL_MS = 1500;

// The item the panel is open on, or null. The hash is its one source:
// Back closes the panel, and a reload reopens it (see showPanel).
let panelId = null;
// The item the state below belongs to — kept across a close, so Escape
// halfway through a reply loses nothing if the same item is reopened.
let panelHeld = null;
// ⤢: the panel over the whole page, rather than beside the board.
let panelWide = false;
// What the panel holds, as module state like writeNotes: a board poll
// redraws the panel every two seconds, and the DOM would forget.
let activity = { stage: null, round: null, lines: [] };
let conversation = { lines: null, error: "" };
let asking = null;
let askAnswer = null;
let panelBusy = false;
let panelMode = null;
let panelTimer = null;
let chatShownFor = null;
// The Pairing section: whether it is shown, the server's last answer, the
// command a start handed back, and what the last write heard.
let pairing = { shown: false, view: null, command: null, note: "", busy: false, error: "" };
// A row's Pairing… asked for this item's panel before it had opened.
let pairingOnOpen = null;

const panelEl = document.getElementById("panel");
const panelTitle = document.getElementById("panel-title");
const panelTop = document.getElementById("panel-top");
const panelPairing = document.getElementById("panel-pairing");
const panelBottom = document.getElementById("panel-bottom");
const composer = document.getElementById("panel-composer");
const messageBox = document.getElementById("panel-message");
const panelStatus = document.getElementById("panel-status");
const panelChat = document.getElementById("panel-chat");
const wideButton = document.getElementById("panel-wide");
const panelMore = document.getElementById("panel-more");
const pairingItem = document.getElementById("panel-pairing-item");
const replyButton = document.getElementById("panel-reply");
const askButton = document.getElementById("panel-ask");
const resolveButton = document.getElementById("panel-resolve");

// "#item=12" names item 12; any other hash, or one that will not
// decode, names none.
function itemOfHash(hash) {
  const m = /^#item=(.+)$/.exec(hash || "");
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch (e) { return null; }
}

function findRow(rows, id) {
  const seen = new Set();
  const stack = [...rows];
  while (stack.length) {
    const row = stack.pop();
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    if (row.id === id) return row;
    stack.push(...row.children);
  }
  return null;
}

// The panel's row: an item the board still lists, with the paths the
// server gave it. Nothing else opens a panel.
function currentRow() {
  if (panelId === null || !lastView) return null;
  const row = findRow(lastView.rows, panelId);
  return row && row.kind === "item" && row.panel ? row : null;
}

// Which bottom half an item gets: live lines while its agent runs, the
// composer while it waits on a person, its conversation — and, while another
// process holds it, what that process's agent is doing — otherwise.
function modeOf(row) {
  if (row.badge === "running" || row.badge === "needs-you" || row.badge === "elsewhere") return row.badge;
  return "other";
}

// Whether the panel keeps reading activity: an agent runs, here or — an Ask
// through \`landrace mcp\`, the reason activity is on disk at all — elsewhere.
function readsLive(mode) {
  return mode === "running" || mode === "elsewhere";
}

// The run a running row is on now — never a file an earlier stage or round
// left behind, which would read as this step's work.
function liveLines(held, row) {
  return held.stage === row.stage && held.round === row.round ? held.lines : [];
}

// A read from \`after\` joined onto what the panel held. A read of another
// run than the one held — a new stage, a new round, fewer lines than were
// already seen — lets go of it, and the next read takes the new run from
// its start.
function mergeActivity(held, page, after) {
  if (page.stage === held.stage && page.round === held.round && page.total >= after) {
    return { stage: page.stage, round: page.round, lines: held.lines.concat(page.lines) };
  }
  if (after === 0) return { stage: page.stage, round: page.round, lines: page.lines };
  return { stage: null, round: null, lines: [] };
}

// An Ask's progress: what the agent said since it was asked, with a second's
// slack for the page's clock reading a moment ahead of the agent's.
function progressLines(lines, since) {
  return lines.filter((l) => l.at >= since - 1000);
}

function agoLabel(at, now) {
  const a = ago(at, now);
  return a === "now" ? "just now" : a + " ago";
}

function activityItem(line) {
  const item = el("div", line.kind === "tool" ? "font-mono text-neutral-500 dark:text-neutral-400" : "text-neutral-800 dark:text-neutral-200");
  item.append(el("span", "select-none text-neutral-400 dark:text-neutral-600", line.kind === "tool" ? "▸ " : "· "), el("span", "break-words", line.text));
  return item;
}

// One record, as plain text: who said it, where, when — never markup.
function conversationItem(line, now) {
  const item = el("article", "py-2");
  const head = el("div", "mb-1 flex flex-wrap items-baseline gap-x-2 text-[11px] text-neutral-500 dark:text-neutral-400");
  head.append(el("span", "font-medium " + (line.byAgent ? "text-emerald-700 dark:text-emerald-400" : "text-neutral-800 dark:text-neutral-200"), line.by));
  if (line.byAgent && line.stage !== "-") head.append(el("span", "font-mono", line.stage + " r" + line.round));
  const at = Date.parse(line.at);
  if (!Number.isNaN(at)) {
    const when = el("span", "tabular-nums", agoLabel(at, now));
    when.title = new Date(at).toLocaleString();
    head.append(when);
  }
  item.append(head, el("p", "whitespace-pre-wrap break-words text-sm text-neutral-800 dark:text-neutral-200", line.text));
  return item;
}

function panelNote(text) {
  return el("p", "py-1 italic text-neutral-400 dark:text-neutral-500", text);
}

// The panel's bottom half, from the row and what the panel holds.
function panelBottomOf(row, mode, state, now) {
  if (mode === "running") {
    const lines = liveLines(state.activity, row);
    return lines.length ? lines.map(activityItem) : [panelNote("no live activity for this agent")];
  }
  const out = [];
  const conv = state.conversation;
  if (conv.lines === null) out.push(panelNote(conv.error || "Reading the conversation…"));
  else if (!conv.lines.length) out.push(panelNote("Nothing has been said on this item yet."));
  else out.push(...conv.lines.map((l) => conversationItem(l, now)));
  if (conv.lines !== null && conv.error) out.push(panelNote(conv.error));
  if (mode === "elsewhere") {
    // What the other process's agent did since the conversation's last word
    // — an Ask posts its question before its agent runs, so the step's own
    // older lines stay out of it.
    const lastWord = conv.lines && conv.lines.length ? Date.parse(conv.lines[conv.lines.length - 1].at) : 0;
    const lines = progressLines(state.activity.lines, Number.isNaN(lastWord) ? 0 : lastWord);
    out.push(panelNote(lines.length
      ? "Another process holds this item — what its agent is doing:"
      : "Another process holds this item; its agent has reported nothing yet."));
    out.push(...lines.map(activityItem));
  }
  if (state.asking) {
    out.push(panelNote("Asking the step…"));
    out.push(...progressLines(state.activity.lines, state.asking.since).map(activityItem));
  } else if (state.answer) {
    const answer = el("article", "mt-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 dark:border-emerald-900 dark:bg-emerald-950");
    answer.append(
      el("div", "mb-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-400", "The step answered"),
      el("p", "whitespace-pre-wrap break-words text-sm text-neutral-800 dark:text-neutral-200", state.answer.reply),
      el("div", "mt-1 text-[11px] text-neutral-500 dark:text-neutral-400",
        state.answer.resolved ? "It has what it needs — Resolve hands the item back." : "It still has questions."),
    );
    out.push(answer);
  }
  return out;
}

// Keyed under "panel:" so render()'s restore-by-key, and keepingFocus, never
// confuse one with the board row's own link.
function panelLink(a, href, key) {
  a.href = href;
  a.setAttribute("data-key", key);
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

// An artifact under the item, with the board's own kind and state marks.
function artifactItem(row, now) {
  const li = el("li", "flex min-w-0 items-center gap-2");
  const kind = kindMark(row);
  if (kind) li.append(kind);
  if (row.system && row.system.icon) li.append(systemMark(row.system));
  const title = el(row.link ? "a" : "span", "min-w-0 truncate text-neutral-700 hover:underline dark:text-neutral-300", row.title);
  if (row.link) panelLink(title, row.link, "panel:artifact:" + row.id);
  li.append(title);
  if (typeof row.createdAt === "number") li.append(el("span", "ml-auto shrink-0 tabular-nums text-neutral-400 dark:text-neutral-500", ago(row.createdAt, now)));
  return li;
}

// The panel's top half: the BoardRow already in /board.json, and nothing
// else — no second read of the item's status. \`last\` is the newest line
// of activity the panel has read.
function panelTopOf(row, last, now) {
  const head = el("div", "flex flex-wrap items-center gap-2");
  const num = el("span", "font-mono text-sm text-blue-600 dark:text-blue-400");
  if (row.link) num.append(panelLink(el("a", null, "#" + row.id + " ↗"), row.link, "panel:link"));
  else num.textContent = "#" + row.id;
  head.append(num);
  if (row.badge && BADGES[row.badge]) {
    const [label, cls] = BADGES[row.badge];
    head.append(el("span", "shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium " + cls, label));
  }
  if (row.screened) head.append(shieldMark());
  const facts = el("dl", "mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1");
  for (const [name, value] of [
    ["Stage", row.stage || "—"],
    ["Round", row.round ? "r" + row.round : "—"],
    ["Model", row.model || "—"],
    ["Effort", row.effort || "—"],
    ["Opened", typeof row.createdAt === "number" ? agoLabel(row.createdAt, now) : "—"],
    ["Stage since", typeof row.since === "number" ? elapsed(row.since, now) : "—"],
    ["Last activity", last ? agoLabel(last.at, now) : "—"],
  ]) facts.append(el("dt", "text-neutral-500 dark:text-neutral-400", name), el("dd", "min-w-0 truncate font-mono", value));
  const out = [head, facts];
  const artifacts = row.children.filter((c) => c.kind !== "item");
  if (artifacts.length) {
    const list = el("ul", "mt-1 space-y-1");
    for (const a of artifacts) list.append(artifactItem(a, now));
    out.push(el("div", "mt-3 text-[11px] font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400", "Artifacts"), list);
  }
  return out;
}

// The Chat deep links stay beside the composer. Built once per item: they
// depend on nothing a poll changes, and rebuilding them would steal focus.
function renderChat(row) {
  if (chatShownFor === row.id) return;
  chatShownFor = row.id;
  if (!row.chat) { panelChat.replaceChildren(); return; }
  const links = [el("span", null, "Open in")];
  for (const target of CHAT_TARGETS) {
    const a = el("a", "inline-flex items-center gap-1 hover:underline");
    // The server's own link, as in the row's menu — never one built here.
    a.href = row.chat.links[target.key];
    a.rel = "noreferrer";
    a.setAttribute("data-key", "panel:chat:" + target.key);
    a.append(target.icon(), el("span", null, target.label));
    links.push(a);
  }
  panelChat.replaceChildren(...links);
}

// Whatever had focus by key keeps it across a redraw of the panel.
function keepingFocus(draw) {
  const active = document.activeElement;
  const key = active && typeof active.getAttribute === "function" ? active.getAttribute("data-key") : null;
  draw();
  if (key) {
    const again = byKey(key);
    if (again && again !== document.activeElement) again.focus();
  }
}

// Redrawn only when what it says changed: a poll every 1.5s that redrew the
// same text wiped any selection in it, and copying the step's question lost
// it within seconds.
function replaceIfChanged(target, nodes) {
  const drawn = nodes.map((n) => n.textContent).join("\\n");
  if (target.dataset.drawn === drawn) return false;
  target.dataset.drawn = drawn;
  target.replaceChildren(...nodes);
  return true;
}

function setPanelNote(text) {
  if (panelStatus.textContent !== text) panelStatus.textContent = text;
}

function syncComposer() {
  for (const b of [replyButton, askButton, resolveButton]) b.disabled = panelBusy;
}

function renderPanel() {
  if (panelId === null) return;
  keepingFocus(() => {
    const row = currentRow();
    const now = Date.now();
    // Its only action is pairing, which an item with no panel paths has not.
    panelMore.hidden = !(row && row.panel);
    if (panelMore.hidden && openMenuKey === "panel") closeMenu();
    pairingItem.textContent = pairing.shown ? "Hide pairing" : "Pairing…";
    if (!row) {
      panelTitle.textContent = lastView ? "#" + panelId + " is not on the board" : "Loading…";
      panelTop.replaceChildren();
      panelBottom.replaceChildren();
      composer.hidden = true;
      return;
    }
    panelTitle.textContent = row.title;
    const last = activity.lines.length ? activity.lines[activity.lines.length - 1] : null;
    panelTop.replaceChildren(...panelTopOf(row, last, now));
    const mode = modeOf(row);
    if (mode !== panelMode) {
      panelMode = mode;
      // A change of state is when the conversation moves on, and one read of
      // the activity says when the agent last did anything.
      if (mode !== "running") loadConversation();
      if (pairing.shown) loadPairing();
      pollPanel(0);
    }
    panelPairing.hidden = !pairing.shown;
    if (pairing.shown) replaceIfChanged(panelPairing, pairingSectionOf(row, pairing.view, pairing));
    composer.hidden = mode !== "needs-you";
    if (mode === "needs-you") renderChat(row);
    syncComposer();
    // Held at the bottom while it was there — the newest line is the one
    // worth reading — and left where a person scrolled it otherwise.
    const stick = panelBottom.scrollTop + panelBottom.clientHeight >= panelBottom.scrollHeight - 8;
    const top = panelBottom.scrollTop;
    const nodes = panelBottomOf(row, mode, { activity, conversation, asking, answer: askAnswer }, now);
    if (replaceIfChanged(panelBottom, nodes)) panelBottom.scrollTop = stick ? panelBottom.scrollHeight : top;
  });
}

async function readActivity() {
  const row = currentRow();
  if (!row) return;
  const id = row.id;
  const after = activity.lines.length;
  try {
    const res = await fetch(row.panel.activity + "?after=" + after, { cache: "no-store" });
    if (!res.ok) return;
    const page = await res.json();
    // Another read landed first, or the panel moved on: the next one catches up.
    if (panelId !== id || activity.lines.length !== after) return;
    activity = mergeActivity(activity, page, after);
    // A new run let go of the old one: read it from its start now, not a
    // poll later — the panel owes a new step's lines within two seconds.
    if (activity.stage === null && page.stage !== null) return readActivity();
    renderPanel();
  } catch (e) {
    // The board's own poll says when landrace stops answering.
  }
}

function stopPanelPoll() {
  if (panelTimer !== null) { clearTimeout(panelTimer); panelTimer = null; }
}

// One read now, then one every PANEL_POLL_MS for as long as the agent runs
// or an Ask is waiting on one.
function pollPanel(delay) {
  stopPanelPoll();
  panelTimer = setTimeout(() => {
    readActivity().then(() => {
      panelTimer = null;
      const row = currentRow();
      if (panelId !== null && (asking || (row && readsLive(modeOf(row))))) pollPanel(PANEL_POLL_MS);
    });
  }, delay);
}

// Asked of the page's own script only: it spends a tracker read.
async function loadConversation() {
  const row = currentRow();
  if (!row) return;
  const id = row.id;
  try {
    const res = await fetch(row.panel.conversation, { cache: "no-store", headers: { "x-landrace-action": "conversation" } });
    if (!res.ok) throw new Error(String(res.status));
    const lines = await res.json();
    if (panelId !== id) return;
    conversation = { lines, error: "" };
  } catch (e) {
    if (panelId !== id) return;
    conversation = { lines: conversation.lines, error: "could not read the conversation" };
  }
  renderPanel();
}

function parseJson(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

// Reply, Ask the step, Resolve: the box's words, posted to the path the
// server put on the row with the header the server asks for. An Ask asks
// first — it runs a paid agent turn — and its progress is the turn's own
// activity, read while it runs.
function panelWrite(kind) {
  const row = currentRow();
  if (!row || panelBusy) return;
  const text = messageBox.value;
  if (kind !== "resolve" && !text.trim()) { setPanelNote("Write something first."); return; }
  if (kind === "ask" && !confirm("Ask the step on #" + row.id + "? This runs a paid agent turn.")) return;
  const id = row.id;
  panelBusy = true;
  askAnswer = null;
  if (kind === "ask") { asking = { since: Date.now() }; pollPanel(0); }
  setPanelNote(kind === "ask" ? "Asking the step…" : kind === "reply" ? "Posting…" : "Handing back…");
  syncComposer();
  renderPanel();
  fetch(row.panel[kind], {
    method: "POST",
    headers: { "x-landrace-action": kind, "content-type": "text/plain;charset=UTF-8" },
    body: kind === "resolve" ? "" : text,
  })
    .then((res) => res.text().then((body) => ({ ok: res.ok, body }), () => ({ ok: res.ok, body: "" })))
    .then(null, () => ({ ok: false, body: "landrace is not responding" }))
    .then(({ ok, body }) => {
      panelBusy = false;
      asking = null;
      if (ok && kind !== "ask") moved(id);
      // The answer belongs to its item, not to whether the panel is open:
      // closed mid-Ask, it is there when the item is reopened, rather than
      // "Asking the step…" for good. Only another item's panel is left alone.
      if (panelHeld !== id) return;
      if (!ok) {
        // The words stay in the box, so nothing typed is lost to a refusal.
        setPanelNote(body || kind + " failed");
      } else if (kind === "ask") {
        askAnswer = parseJson(body);
        messageBox.value = "";
        setPanelNote("");
      } else if (kind === "resolve") {
        const r = parseJson(body);
        setPanelNote(r && r.alreadyResolved ? "Already handed back." : "Handed back to the loop.");
      } else {
        messageBox.value = "";
        setPanelNote("Posted.");
      }
      syncComposer();
      if (ok) { loadConversation(); schedulePoll(0); }
      renderPanel();
    });
}

// A step to pair on, as the server offered it: a fresh session seeded with
// the step, or the agent's own session there, continued as a fork.
function offerLabel(o) {
  return o.continue ? "Continue " + o.stage + " together" : "Pair on " + o.stage;
}

// The Pairing section, from the server's answer and the panel's own state:
// what may be paired on, or the pairing open now and what to do with it.
function pairingSectionOf(row, view, state) {
  const out = [el("div", "mb-1 text-[11px] font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400", "Pairing")];
  if (view === null) {
    out.push(panelNote(state.error || "Reading what may be paired on…"));
    return out;
  }
  const buttons = el("div", "mt-2 flex flex-wrap items-center gap-2");
  const button = (label, key, onClick) => {
    const b = el("button", "${BUTTON}", label);
    b.type = "button";
    b.disabled = state.busy;
    b.setAttribute("data-key", "panel:pairing:" + key);
    b.addEventListener("click", onClick);
    buttons.append(b);
  };
  if (view.open) {
    out.push(el("p", "text-neutral-800 dark:text-neutral-200",
      "Pairing on " + view.open.stage + ", round " + view.open.round + " — the agent does not run it alone meanwhile."));
    if (state.command) {
      out.push(el("pre", "mt-2 whitespace-pre-wrap break-all rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1 font-mono text-[11px] text-neutral-800 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200", state.command));
      button("Copy command", "copy", () => copyCommand());
    } else {
      button("Get command", "command", () => pairWrite("pair", view.open.stage));
    }
    button("Finish…", "finish", () => pairWrite("finish"));
    button("Release", "release", () => pairWrite("release"));
  } else if (view.offers.length) {
    for (const o of view.offers) button(offerLabel(o), "offer:" + o.stage, () => pairWrite("pair", o.stage));
  } else {
    out.push(panelNote("Nothing to pair on right now."));
  }
  if (buttons.children.length) out.push(buttons);
  if (state.note) out.push(panelNote(state.note));
  return out;
}

// Asked of the page's own script only: it spends a tracker read.
async function loadPairing() {
  const row = currentRow();
  if (!row) return;
  const id = row.id;
  try {
    const res = await fetch(row.panel.pairing, { cache: "no-store", headers: { "x-landrace-action": "pairing" } });
    if (!res.ok) throw new Error(String(res.status));
    const view = await res.json();
    if (panelId !== id) return;
    pairing.view = view;
    pairing.error = "";
    // A command belongs to the pairing it joined, and to no later one.
    if (!view.open) pairing.command = null;
  } catch (e) {
    if (panelId !== id) return;
    pairing.error = "could not read what may be paired on";
  }
  renderPanel();
}

function togglePairing() {
  pairing.shown = !pairing.shown;
  // Opened again, it asks for a command afresh: see copyCommand.
  pairing.command = null;
  if (pairing.shown) loadPairing();
  renderPanel();
}

// A row's Pairing…: its item's panel, open on the Pairing section.
function openPairing(id) {
  if (panelId === id) {
    if (!pairing.shown) togglePairing();
    return;
  }
  pairingOnOpen = id;
  openPanel(id);
}

// Copied from the click itself — a browser may refuse a clipboard write
// that comes after a wait — and left on screen to select when it does.
// Copied, it is dropped: once run, the seeded line refuses its own session
// id, and only Get command again answers with the line that resumes it.
function copyCommand() {
  const clipboard = navigator.clipboard;
  (clipboard ? clipboard.writeText(pairing.command) : Promise.reject(new Error("no clipboard"))).then(
    () => { pairing.command = null; pairing.note = "Copied: run it in your terminal. Get command again to rejoin later."; renderPanel(); },
    () => { pairing.note = "Could not copy: select the command above and copy it."; renderPanel(); },
  );
}

// Pair, Finish and Release: posted to the paths the server put on the row.
// A pairing holds a round and a hand-in runs a paid turn, so each asks first.
function pairWrite(kind, stage) {
  const row = currentRow();
  if (!row || pairing.busy) return;
  let body = "";
  if (kind === "pair") {
    const fresh = !(pairing.view && pairing.view.open);
    if (fresh && !confirm("Pair on " + stage + " for #" + row.id + "? Its round is held for you: the agent does not run it alone until you finish or release it.")) return;
    body = stage;
  } else if (kind === "finish") {
    const note = prompt("Finish the pairing on #" + row.id + "? Your session is asked for the step's answer, a paid agent turn, and the item moves on. A note for it, if you like:", "");
    if (note === null) return;
    body = note;
  } else if (!confirm("Release the pairing on #" + row.id + "? The agent runs the step alone from the next tick, and the pairing's checkout is removed.")) {
    return;
  }
  const id = row.id;
  pairing.busy = true;
  pairing.note = kind === "finish" ? "Handing in… this runs an agent turn." : kind === "release" ? "Releasing…" : "Starting…";
  renderPanel();
  fetch(row.panel[kind], {
    method: "POST",
    headers: { "x-landrace-action": kind, "content-type": "text/plain;charset=UTF-8" },
    body,
  })
    .then((res) => res.text().then((text) => ({ ok: res.ok, text }), () => ({ ok: res.ok, text: "" })))
    .then(null, () => ({ ok: false, text: "landrace is not responding" }))
    .then(({ ok, text }) => {
      pairing.busy = false;
      if (panelHeld !== id) return;
      const answer = ok ? parseJson(text) : null;
      if (!ok) {
        pairing.note = text || kind + " failed";
      } else if (kind === "pair") {
        pairing.command = answer ? answer.command : null;
        pairing.note = "";
      } else if (kind === "finish") {
        pairing.command = null;
        const left = answer && answer.discarded.length ? " Discarded, uncommitted: " + answer.discarded.join(", ") + "." : "";
        pairing.note = answer ? "Handed in: " + answer.stage + ", round " + answer.round + "." + left : "Handed in.";
      } else {
        pairing.command = null;
        pairing.note = "Released: the agent runs it alone.";
      }
      loadPairing();
      loadConversation();
      schedulePoll(0);
      renderPanel();
    });
}

// The one way the panel opens, shuts or changes item: the hash changed.
function showPanel(id) {
  if (openMenuKey === "panel") closeMenu();
  if (id !== null && id !== panelHeld) {
    panelHeld = id;
    activity = { stage: null, round: null, lines: [] };
    conversation = { lines: null, error: "" };
    asking = null;
    askAnswer = null;
    chatShownFor = null;
    pairing = { shown: false, view: null, command: null, note: "", busy: false, error: "" };
    messageBox.value = "";
    setPanelNote("");
  }
  panelId = id;
  if (id !== null && pairingOnOpen === id) {
    pairingOnOpen = null;
    pairing.shown = true;
    loadPairing();
  }
  panelMode = null;
  markSelected();
  const open = id !== null;
  panelEl.hidden = !open;
  document.body.classList.toggle("sm:pr-[28rem]", open && !panelWide);
  if (!open) { stopPanelPoll(); return; }
  renderPanel();
}

// The panel's item, marked on its own row of the list — looked up by key,
// since a render replaces every row.
function markSelected() {
  for (const li of document.querySelectorAll('[role="treeitem"][aria-selected="true"]')) li.removeAttribute("aria-selected");
  const title = panelId === null ? null : byKey(panelId + ":open");
  const li = title ? title.closest('[role="treeitem"]') : null;
  if (li) li.setAttribute("aria-selected", "true");
}

// A row click: pushed onto the hash, so Back closes the panel and a reload
// reopens it.
function openPanel(id) {
  location.hash = "item=" + encodeURIComponent(id);
}

// ✕ and Escape: the hash goes, as Back would take it, with no history entry
// of its own for Forward to reopen.
function closePanel() {
  history.replaceState(null, "", location.pathname + location.search);
  showPanel(null);
}

document.getElementById("panel-close").addEventListener("click", () => closePanel());
// The header's ⋯ is a menu like a row's, under the same one-open rule, and
// never redrawn: it lives in the skeleton, not in anything a poll replaces.
panelMore.addEventListener("click", () => toggleMenu("panel"));
pairingItem.addEventListener("click", () => { closeMenu(); togglePairing(); });
wideButton.addEventListener("click", () => {
  panelWide = !panelWide;
  panelEl.classList.toggle("sm:w-[28rem]", !panelWide);
  wideButton.setAttribute("aria-pressed", panelWide ? "true" : "false");
  showPanel(panelId);
});
replyButton.addEventListener("click", () => panelWrite("reply"));
// On the button, so the shortcut is seen, not only known.
function shortcutLabel(platform) {
  return /mac|iphone|ipad/i.test(platform) ? "⌘↵" : "Ctrl ↵";
}
document.getElementById("panel-reply-keys").textContent = shortcutLabel((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "");
// Ctrl/⌘+Enter replies, as in any chat; a plain or Shift+Enter is a new line.
function onMessageKey(e) {
  if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  panelWrite("reply");
}
messageBox.addEventListener("keydown", onMessageKey);
askButton.addEventListener("click", () => panelWrite("ask"));
resolveButton.addEventListener("click", () => panelWrite("resolve"));
window.addEventListener("hashchange", () => showPanel(itemOfHash(location.hash)));
showPanel(itemOfHash(location.hash));

// Every item the board badges needs-you, children included, by id — and
// one that needed you at the last poll and is only held elsewhere now: a
// conversation turn or a pairing holds its lock a while, but the item never
// left you, and its return is no arrival. A needs-you read from stale labels
// counts the same way: once a step has run, the labels may still be the stage
// the item is leaving — a spec approval heading into build reads needs-you
// between triage's step and the next list — so only a fresh list says it
// arrived.
function needingYou(rows, into, before) {
  for (const row of rows) {
    const unsure = row.badge === "elsewhere" || (row.badge === "needs-you" && row.stale);
    const held = unsure && before !== null && before.has(row.id);
    if ((row.badge === "needs-you" && !row.stale) || held) into.set(row.id, row);
    needingYou(row.children, into, before);
  }
  return into;
}

// The items that need you now and did not at the last poll. The first poll
// has no last one and only seeds: opening the board announces nothing that
// was already waiting.
function arrived(before, now) {
  return before === null ? [] : [...now.values()].filter((row) => !before.has(row.id));
}

// One system notification for an item that has just come to need you, only
// with the bell on and the browser's leave. Tagged by item, so a second
// arrival replaces the first rather than stacking — and renotify, so the
// replacing one still alerts: a return is notified again, not swapped in
// silently over one still sitting in the notification centre. A click opens
// its panel.
// Caught: a browser that refuses the constructor must not read as a poll
// that failed.
function notifyOf(row) {
  if (!notifyOn || typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    const n = new Notification("#" + row.id + " needs you", { body: row.title + " — " + row.note, tag: "landrace-" + row.id, renotify: true });
    n.addEventListener("click", () => { window.focus(); openPanel(row.id); n.close(); });
  } catch (e) {}
}

// What the bell says: on, off, or that the browser will not let it — a
// person who turned it on and hears nothing deserves to know why.
function bellState(on, permission) {
  if (permission === "denied") {
    return { icon: "🔕", pressed: "false", label: "Notifications are blocked for this page — allow them in the browser's site settings" };
  }
  if (permission === "unsupported") return { icon: "🔕", pressed: "false", label: "Notifications are not available in this browser" };
  // On, but the browser's prompt went unanswered — Arc's can sit unseen
  // behind a hidden sidebar — so nothing will arrive, and it has to say so.
  if (on && permission === "default") {
    return { icon: "🔔", pressed: "false", label: "Your browser has not allowed notifications — allow them for this site in its site settings, or click to ask again" };
  }
  return on && permission === "granted"
    ? { icon: "🔔", pressed: "true", label: "Notifying you when an item needs you — click to stop" }
    : { icon: "🔔", pressed: "false", label: "Notify me when an item needs you" };
}

// Toggled from what the bell shows, not what was stored: on with the prompt
// dismissed reads as off, and a click on it has to turn it on and ask again.
function clickedBell(on, permission) {
  return bellState(on, permission).pressed !== "true";
}

const bell = document.getElementById("notify-toggle");
let notifyOn = false;
try { notifyOn = localStorage.getItem(NOTIFY_KEY) === "on"; } catch (e) {}
// Which items needed you at the last poll that landed; null until one has.
let neededYou = null;

function permissionNow() {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

function syncBell() {
  const state = bellState(notifyOn, permissionNow());
  bell.textContent = state.icon;
  bell.setAttribute("aria-pressed", state.pressed);
  bell.setAttribute("aria-label", state.label);
  bell.title = state.label;
  bell.classList.toggle("opacity-50", state.pressed !== "true");
}

bell.addEventListener("click", async () => {
  notifyOn = clickedBell(notifyOn, permissionNow());
  try { localStorage.setItem(NOTIFY_KEY, notifyOn ? "on" : "off"); } catch (e) {}
  // Asked from the click, the one moment a browser lets a page ask.
  if (notifyOn && permissionNow() === "default") await Notification.requestPermission();
  syncBell();
});
syncBell();

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
