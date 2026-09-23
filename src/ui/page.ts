/*
 * The triage page. Strings rather than files so the build ships them with no
 * copy step. Script and style are served as their own routes so the CSP can
 * forbid anything inline.
 */

export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Landrace</title>
<link rel="stylesheet" href="/app.css">
<script src="/app.js" defer></script>
</head>
<body>
<header>
<h1>Landrace</h1><span id="meta">connecting…</span>
<div id="schedule"><span id="next">no tick scheduled</span><button id="tick" type="button">Run next tick now</button></div>
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

export const APP_CSS = `
:root { color-scheme: light dark; --needs: #d33; --run: #2a2; --else: #c90; --muted: #888; }
body { font: 14px/1.4 system-ui, sans-serif; margin: 0; padding: 1rem clamp(1rem, 4vw, 3rem); }
header { display: flex; gap: 1rem; align-items: baseline; flex-wrap: wrap; }
h1 { margin: 0 0 .5rem; font-size: 1.3rem; }
#meta { color: var(--muted); }
#schedule { margin-left: auto; display: flex; gap: .5rem; align-items: baseline; }
#next { color: var(--muted); font-variant-numeric: tabular-nums; }
#tick { font: inherit; }
section, details { margin: 1rem 0; }
h2, summary { font-size: .8rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
[data-lane="needs-you"] h2 { color: var(--needs); }
[data-lane="running"] h2 { color: var(--run); }
[data-lane="elsewhere"] h2 { color: var(--else); }
ul { list-style: none; margin: 0; padding: 0; }
li { display: flex; gap: .75rem; padding: .35rem 0; border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent); flex-wrap: wrap; }
.num { font-variant-numeric: tabular-nums; min-width: 3.5rem; }
.stage { min-width: 9rem; color: var(--muted); }
.title { flex: 1 1 14rem; min-width: 0; overflow-wrap: anywhere; }
.note, .clock { color: var(--muted); font-variant-numeric: tabular-nums; }
.empty { color: var(--muted); font-style: italic; }
`;

export const APP_JS = `
"use strict";
const POLL_MS = 2000;

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
`;
