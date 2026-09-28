import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { isTicketId } from "#conventions.js";
import type { ActivityLog, ActivityPage, ActivityRecord } from "#namespace.js";
import { messageOf } from "#runner/errors.js";
import { oneLine } from "#runner/status.js";

/** A line is a glance at what the agent is doing, not a transcript. */
const MAX_TEXT = 240;
/** Per round: a long build calls thousands of tools, and the panel shows the latest. */
const MAX_LINES = 500;

/** One run's lines, skipping any that do not parse — a torn write costs its own line, not the read. */
function parse(text: string): ActivityRecord[] {
  const held: ActivityRecord[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const v = JSON.parse(raw) as Partial<ActivityRecord>;
      if (typeof v.round === "number" && (v.kind === "tool" || v.kind === "message") &&
        typeof v.text === "string" && typeof v.at === "number") {
        held.push({ round: v.round, kind: v.kind, text: v.text, at: v.at });
      }
    } catch {
      // Skipped, as above.
    }
  }
  return held;
}

/** The size of a file, or null when there is none yet. */
const sizeOf = (file: string): number | null => {
  try {
    return statSync(file).size;
  } catch {
    return null;
  }
};

const NONE: ActivityPage = { stage: null, round: null, lines: [], total: 0 };

/**
 * What agents are doing, per ticket, kept at
 * `<root>/activity/<ticket>/<stage>.jsonl` — on disk, because a turn asked
 * through `landrace mcp` runs in another process and the page must show it.
 *
 * Display only, and never state: one round per stage, and a stage's next
 * round replaces the last, so nothing here remembers anything the tracker
 * does not already say. Losing the directory loses a view, nothing more.
 *
 * Every line is redacted before it is cut — cut first, a secret straddling
 * the cut would leave its head on disk where the redactor no longer matches.
 */
export function createActivityLog(root: string, redact: (text: string) => string): ActivityLog {
  const dirOf = (ticket: string): string => join(root, "activity", ticket);
  // A stage id is the workflow's own and a ticket id comes from the tracker;
  // encoded, neither can name a path outside its directory.
  const fileOf = (ticket: string, stage: string): string => join(dirOf(ticket), `${encodeURIComponent(stage)}.jsonl`);

  // Per file, the round it holds and how many lines, as of the size this
  // process last saw it at. Re-reading the whole file on every line made
  // a 500-line round quadratic; a file whose size is not the one remembered
  // was written by someone else — `landrace mcp`, a new round — and is read
  // afresh, so two processes never disagree about which round a file holds.
  const known = new Map<string, { round: number; lines: number; size: number }>();

  const heldIn = (file: string, size: number): { round: number; lines: number } | null => {
    const cached = known.get(file);
    if (cached && cached.size === size) return cached;
    const held = parse(readFileSync(file, "utf8"));
    const first = held[0];
    return first === undefined ? null : { round: first.round, lines: held.length };
  };

  return {
    record(ticket, stage, round, e) {
      // A display must never be able to stop the work it displays: this is
      // called from inside a paid run, so every failure ends here.
      try {
        if (!isTicketId(ticket)) return;
        const file = fileOf(ticket, stage);
        const line = `${JSON.stringify({
          round,
          kind: e.kind === "tool" ? "tool" : "message",
          text: oneLine(redact(String(e.text ?? ""))).slice(0, MAX_TEXT),
          at: Number.isFinite(e.at) ? e.at : Date.now(),
        })}\n`;
        const bytes = Buffer.byteLength(line);
        const size = sizeOf(file);
        const held = size === null ? null : heldIn(file, size);
        if (held === null || held.round < round) {
          mkdirSync(dirOf(ticket), { recursive: true });
          writeFileSync(file, line);
          known.set(file, { round, lines: 1, size: bytes });
          return;
        }
        // An older round never overwrites a newer one, and a round past its
        // cap keeps the lines it has.
        if (held.round > round || held.lines >= MAX_LINES) {
          known.set(file, { ...held, size: size ?? 0 });
          return;
        }
        appendFileSync(file, line);
        known.set(file, { round, lines: held.lines + 1, size: (size ?? 0) + bytes });
      } catch (err) {
        console.error(`landrace: could not record agent activity for #${ticket}: ${messageOf(err)}`);
      }
    },

    async read(ticket, after) {
      if (!isTicketId(ticket)) return NONE;
      try {
        const dir = dirOf(ticket);
        const names = (await readdir(dir)).filter((n) => n.endsWith(".jsonl"));
        const stamped = await Promise.all(names.map(async (name) => ({ name, at: (await stat(join(dir, name))).mtimeMs })));
        // The run that wrote last is the one worth showing: a step running
        // now, or the ask that just answered.
        const newest = stamped.sort((a, b) => b.at - a.at)[0];
        if (!newest) return NONE;
        const held = parse(await readFile(join(dir, newest.name), "utf8"));
        return {
          stage: decodeURIComponent(newest.name.slice(0, -".jsonl".length)),
          round: held[0]?.round ?? null,
          lines: held.slice(Math.max(0, after)).map(({ kind, text, at }) => ({ kind, text, at })),
          total: held.length,
        };
      } catch {
        return NONE;
      }
    },
  };
}
