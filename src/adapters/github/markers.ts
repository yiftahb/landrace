import type { Entry } from "../../core/types.js";
import { OUTPUT_KIND, parseMarker, type Marker } from "../../conventions.js";
import type { Comment } from "../types.js";

/**
 * What core reads as a record's payload — `run.outputs[stage]` for an output
 * record, and the marker itself for the kinds core reads no value from.
 *
 * An output record's payload is the step's own value and nothing else. The
 * envelope (stage, kind, round) is already on the Entry, and leaving it in
 * `data` as well is what made `outputs.spec.kind` read back the literal
 * "output" for every shape a step could produce, so every trigger in the
 * shipped workflow that routed on an output field was dead. A record written
 * before markers carried values has no value at all: undefined, not the
 * envelope — answering "output" again for exactly the tickets already in
 * flight is the bug, not the compatible thing to do.
 */
const payloadOf = (m: Marker): unknown => (m.kind === OUTPUT_KIND ? m.output : m);

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
      ? {
          stage: marker.stage,
          kind: marker.kind,
          round: marker.round,
          data: payloadOf(marker),
          at: c.created_at,
          byAgent: true,
        }
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
