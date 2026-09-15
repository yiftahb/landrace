import type { Entry } from "../../core/types.js";
import { parseMarker } from "../../conventions.js";
import type { Comment } from "../types.js";

/**
 * Turn GitHub comments into the engine's tracker-agnostic records. This is the
 * only place that knows progress is recorded as markers in comment bodies; core
 * never learns it, and a different tracker would record them differently.
 *
 * A marker is control state, and it is trustworthy only because *we* wrote it.
 * An earlier version stamped `byAgent` on any comment whose trailing marker
 * parsed, so one comment from any account with comment access could complete a
 * stage, block a ticket, or run a counter up until the triggers went ambiguous.
 * The trailing-marker rule does not help there: it stops a *quoted* example
 * being mistaken for a real one, not someone who deliberately puts one last.
 * Authorship is the check; syntax is not.
 */
export function entriesFromComments(comments: Comment[], botLogin: string): Entry[] {
  // Fail closed, and loudly. An empty login would make every marker read as
  // human — the engine would believe no step had ever run and re-invoke paid
  // steps forever, which has cost real money on this project once.
  if (!botLogin.trim()) {
    throw new Error("entriesFromComments needs the login landrace posts as; refusing to read markers without it");
  }
  const bot = botLogin.trim().toLowerCase();

  return comments.map((c) => {
    // GitHub logins are case-insensitive.
    const author = c.user?.login;
    const ours = typeof author === "string" && author.toLowerCase() === bot;
    const marker = ours ? parseMarker(c.body ?? "") : null;
    return marker
      ? { stage: marker.stage, kind: marker.kind, round: marker.round, data: marker, at: c.created_at, byAgent: true }
      : {
          stage: "-",
          kind: "human",
          round: 0,
          data: { body: c.body, author: author ?? "?", id: c.id },
          at: c.created_at,
          byAgent: false,
        };
  });
}
