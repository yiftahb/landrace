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
<body>
<header>
<h1>Landrace</h1><span id="meta">connecting…</span>
<div id="schedule" class="ml-auto"><span id="next">no tick scheduled</span><button id="tick" type="button">Run next tick now</button></div>
<button id="theme-toggle" type="button" aria-label="Switch to dark mode">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="dark:hidden" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="hidden dark:block" aria-hidden="true"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>
</button>
</header>
<main>
<section data-lane="needs-you"><h2>Needs you</h2><ul></ul></section>
<section data-lane="running"><h2>Agent running</h2><ul></ul></section>
<section data-lane="elsewhere"><h2>Held elsewhere</h2><ul></ul></section>
<section data-lane="waiting"><h2>Waiting</h2><ul></ul></section>
<details data-lane="not-admitted"><summary>Not admitted</summary><ul></ul></details>
<details data-lane="discharged"><summary>Discharged</summary><ul></ul></details>
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

function rowFor(row, now) {
  const li = el("li");
  const num = el("span", "num");
  if (row.url) {
    const a = el("a", null, "#" + row.ticket);
    a.href = row.url;
    a.rel = "noreferrer";
    num.append(a);
  } else {
    num.textContent = "#" + row.ticket;
  }
  const stage = row.round ? row.stage + " r" + row.round : (row.stage || "—");
  li.append(num, el("span", "stage", stage), el("span", "title", row.title));
  const note = row.model ? row.note + " · " + row.model : row.note;
  li.append(el("span", "note", note), el("span", "clock", elapsed(row.since, now)));
  return li;
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
    nextTickAt === null ? "no tick scheduled" : "next tick in " + countdown(nextTickAt - Date.now());
}

function render(view) {
  const now = Date.now();
  for (const lane of document.querySelectorAll("[data-lane]")) {
    const rows = view.rows.filter((r) => r.lane === lane.dataset.lane);
    const list = lane.querySelector("ul");
    list.replaceChildren(...(rows.length ? rows.map((r) => rowFor(r, now)) : [el("li", "empty", "none")]));
    const title = lane.querySelector("h2, summary");
    if (!title.dataset.label) title.dataset.label = title.textContent;
    title.textContent = title.dataset.label + " (" + rows.length + ")";
  }
  const listed = view.listedAt === null ? "waiting for the first tick" : "listed " + elapsed(view.listedAt, now) + " ago";
  document.getElementById("meta").textContent = listed;
  nextTickAt = view.nextTickAt;
  renderNext();
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
