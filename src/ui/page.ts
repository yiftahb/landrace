/*
 * The triage page. Strings rather than files so the build ships them with no
 * copy step. Script and style are served as their own routes so the CSP can
 * forbid anything inline.
 */
export { APP_CSS } from "#ui/styles.generated.js";

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
<button id="tick" type="button" class="rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800">Run next tick now</button>
</div>
<button id="theme-toggle" type="button" aria-label="Switch to dark mode" class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4 dark:hidden" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="hidden h-4 w-4 dark:block" aria-hidden="true"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>
</button>
</div>
</div>
</header>
<main class="mx-auto max-w-5xl px-4 py-6 sm:px-6">
<section id="board" class="rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
<ul id="tree" role="tree" aria-label="Tickets" class="divide-y divide-neutral-100 dark:divide-neutral-800"></ul>
</section>
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

// A small coloured mark per vendor — colour and shape only, not a
// reproduction of any vendor's logotype, just enough to tell the three
// deep-link targets apart at a glance, the way the design's small icons do.
function chatIcon(bg, glyphAttrs) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("shrink-0", "rounded-sm");
  const rect = document.createElementNS(SVG_NS, "rect");
  rect.setAttribute("width", "16");
  rect.setAttribute("height", "16");
  rect.setAttribute("rx", "4");
  rect.setAttribute("fill", bg);
  svg.append(rect);
  const glyph = document.createElementNS(SVG_NS, "path");
  for (const k in glyphAttrs) glyph.setAttribute(k, glyphAttrs[k]);
  svg.append(glyph);
  return svg;
}

// A known system's mark: a coloured square and one or two white letters.
// Built from row.system.icon, which the server only ever fills from its own
// table (src/ui/systems.ts) — colour and letters, never a URL or an image.
function systemIcon(icon) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("shrink-0", "rounded-sm");
  const rect = document.createElementNS(SVG_NS, "rect");
  rect.setAttribute("width", "16");
  rect.setAttribute("height", "16");
  rect.setAttribute("rx", "4");
  rect.setAttribute("fill", icon.bg);
  const text = document.createElementNS(SVG_NS, "text");
  text.setAttribute("x", "8");
  text.setAttribute("y", "11.5");
  text.setAttribute("text-anchor", "middle");
  text.setAttribute("font-size", icon.glyph.length > 1 ? "7" : "9");
  text.setAttribute("font-weight", "700");
  text.setAttribute("fill", "#fff");
  text.textContent = icon.glyph;
  svg.append(rect, text);
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
// pathologically deep tree still fits the card.
const INDENT = ["pl-4", "pl-10", "pl-16", "pl-22", "pl-28"];
const indentOf = (depth) => INDENT[Math.min(depth, INDENT.length - 1)];

// A person's own expand/collapse choices, by node id. Kept across every
// render, and consulted before the server's own \`expanded\`: a poll landing
// every two seconds must never undo what someone just clicked. An entry lives
// until its node leaves the view (see forgetGone), so a returning id starts
// from the server's opinion again rather than a choice made about another node.
const userExpanded = new Map();
function isOpen(row) { return userExpanded.has(row.id) ? userExpanded.get(row.id) : row.expanded; }

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
}

function external(a, href) {
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

function systemLabel(row) {
  const wrap = el("span", "inline-flex shrink-0 items-center gap-1 text-xs text-neutral-500 dark:text-neutral-400");
  if (row.system && row.system.icon) wrap.append(systemIcon(row.system.icon));
  if (row.system) wrap.append(el("span", null, row.system.name));
  return wrap;
}

function treeItem(row, depth, cls) {
  const li = el("li", cls + " " + indentOf(depth) + (row.closed === "dropped" ? " opacity-50" : ""));
  li.setAttribute("role", "treeitem");
  // The tree is drawn flat, one <li> per visible node, so depth is told to
  // assistive tech here rather than by nesting.
  li.setAttribute("aria-level", String(depth + 1));
  if (row.children.length) li.setAttribute("aria-expanded", isOpen(row) ? "true" : "false");
  return li;
}

// The ▸/▾ in front of any row with children — ticket or artifact, since a
// document can sit under a pull request too, and a row nobody can open would
// hide its children for good. Keyed like the menu, so render()'s
// restore-by-key keeps a keyboard user's focus on it across the re-render
// its own click causes.
function toggleFor(row) {
  if (!row.children.length) return el("span", "inline-block h-4 w-4 shrink-0");
  const open = isOpen(row);
  const toggle = el("button", "inline-flex h-4 w-4 shrink-0 items-center justify-center text-neutral-400", open ? "▾" : "▸");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
  toggle.setAttribute("aria-label", (open ? "Collapse " : "Expand ") + row.title);
  toggle.setAttribute("data-key", row.id + ":toggle");
  // Redrawn by the next poll, brought forward to now: render() reads
  // userExpanded, so there is no second drawing path to keep in step.
  toggle.addEventListener("click", () => { userExpanded.set(row.id, !isOpen(row)); schedulePoll(0); });
  return toggle;
}

function ticketRowFor(row, depth, now) {
  // Stacked below the sm breakpoint, side-by-side above it — a breakpoint, not a
  // content-based flex-wrap. flex-wrap's own line-breaking runs on each
  // item's *hypothetical* (content) size: flex-1's 0% basis told the browser
  // this row needed no room at all and it never wrapped the action button
  // down, while flex-auto's content-sized basis wrapped the button down but
  // then sized the title/stage row itself off the unwrapped content width,
  // pushing the stage chip past the edge instead. Neither reliably fits
  // arbitrary ticket titles at 400px, so the breakpoint sidesteps both.
  const li = treeItem(row, depth, "flex flex-col gap-1 py-3 pr-4 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between sm:gap-x-3 sm:gap-y-1");
  const main = el("div", "min-w-0 w-full sm:w-auto sm:flex-1");

  const top = el("div", "flex flex-wrap items-baseline gap-x-2 gap-y-1");
  top.append(toggleFor(row));
  const num = el("span", "num shrink-0 font-mono text-sm text-blue-600 dark:text-blue-400");
  if (row.link) num.append(external(el("a", null, "#" + row.id + " ↗"), row.link));
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
  if (typeof row.priority === "number") {
    top.append(el("span", "priority shrink-0 font-mono text-[11px] text-neutral-500 dark:text-neutral-400", "P" + row.priority));
  }
  top.append(systemLabel(row));

  const bottom = el("div", "mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-neutral-500 dark:text-neutral-400");
  bottom.append(el("span", "note", row.closed === "dropped" ? "dropped" : row.note));
  if (row.model) {
    bottom.append(el("span", "model rounded border border-neutral-200 px-1 font-mono dark:border-neutral-700", row.model));
  }
  if (typeof row.since === "number") {
    bottom.append(el("span", "clock font-mono tabular-nums", elapsed(row.since, now)));
  }

  main.append(top, bottom);
  li.append(main);
  if (row.chat) li.append(actionFor(row));
  return li;
}

// A pull request, a document — anything that is not a ticket — as one line:
// the whole line is the link, and it opens in a new tab. No link, no anchor:
// a row that goes nowhere must not look like it does.
function artifactRowFor(row, depth) {
  const li = treeItem(row, depth, "flex items-center gap-2 py-1.5 pr-4 text-xs");
  const line = row.link
    ? external(el("a", "flex min-w-0 flex-1 items-center gap-2 hover:underline"), row.link)
    : el("span", "flex min-w-0 flex-1 items-center gap-2");
  line.append(
    systemLabel(row),
    el("span", "shrink-0 font-mono text-neutral-400", row.kind),
    el("span", "min-w-0 truncate text-neutral-800 dark:text-neutral-200", row.title),
    el("span", "shrink-0 text-neutral-500 dark:text-neutral-400", row.summary),
  );
  if (row.link) line.append(el("span", "shrink-0 text-neutral-400", "↗"));
  li.append(toggleFor(row), line);
  return li;
}

// Depth-first, drawing a row's children only while it is open. \`seen\` is the
// cycle guard's second half: the server already draws each node once, and
// this makes sure a board.json that somehow did not still cannot hang the tab.
function treeRows(rows, depth, seen, now, out) {
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row.kind === "ticket" ? ticketRowFor(row, depth, now) : artifactRowFor(row, depth));
    if (row.children.length && isOpen(row)) treeRows(row.children, depth + 1, seen, now, out);
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

function render(view) {
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
  const items = treeRows(view.rows, 0, new Set(), now, []);
  document.getElementById("tree").replaceChildren(
    ...(items.length ? items : [el("li", "px-4 py-6 text-sm italic text-neutral-400 dark:text-neutral-600", "None")]),
  );
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
