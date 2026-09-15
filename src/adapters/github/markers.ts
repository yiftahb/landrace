import type { Entry } from "../../core/types.js";
import { parseMarker } from "../../conventions.js";
import type { Comment } from "../types.js";

/**
 * Turn GitHub comments into the engine's tracker-agnostic records. This is the
 * only place that knows progress is recorded as markers in comment bodies; core
 * never learns it, and a different tracker would record them differently.
 */
export function entriesFromComments(comments: Comment[]): Entry[] {
  return comments.map((c) => {
    const marker = parseMarker(c.body ?? "");
    return marker
      ? { stage: marker.stage, kind: marker.kind, round: marker.round, data: marker, at: c.created_at, byAgent: true }
      : {
          stage: "-",
          kind: "human",
          round: 0,
          data: { body: c.body, author: c.user?.login ?? "?", id: c.id },
          at: c.created_at,
          byAgent: false,
        };
  });
}
