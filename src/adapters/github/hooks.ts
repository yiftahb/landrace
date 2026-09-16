import { definePostHook, definePreHook } from "../../hooks/types.js";
import type { Effect, Snapshot } from "../../core/types.js";
import { labelNames, type TrackerPort } from "../types.js";
import { LABELS, neutraliseMarkers, renderMarker, stageFromLabels, STAGE_LABEL_PREFIX, type Marker } from "../../conventions.js";
import { entriesFromComments } from "./markers.js";

const labels = (s: Snapshot): string[] => ((s.ticket as { labels?: string[] })?.labels ?? []);

interface SnapshotComment {
  body?: string;
  user?: { login?: string } | null;
}
const comments = (s: Snapshot): SnapshotComment[] =>
  ((s.ticket as { comments?: SnapshotComment[] })?.comments ?? []);

/**
 * Who we post as, as the pre hook recorded it this tick. satisfied() is
 * synchronous by contract, so it cannot resolve the login itself; the
 * snapshot is where the state a decision reads belongs anyway.
 *
 * Absent means we cannot tell whether an effect has landed, and the two ways
 * of guessing are both wrong: "satisfied" silently drops the work, "not
 * satisfied" re-posts a comment on every tick. Halting is the third option,
 * and the dispatcher attributes the throw to this hook.
 */
function botLoginOf(s: Snapshot): string {
  const bot = (s.tracker as { bot?: unknown } | undefined)?.bot;
  if (typeof bot !== "string" || !bot.trim()) {
    throw new Error("the snapshot does not record the login landrace posts as, so no effect can be checked");
  }
  return bot.trim().toLowerCase();
}

const wroteIt = (c: SnapshotComment, bot: string): boolean =>
  typeof c.user?.login === "string" && c.user.login.toLowerCase() === bot;

/** Observe: turn a GitHub issue into the snapshot the engine reads. */
export const githubPreHook = (tracker: TrackerPort) =>
  definePreHook({
    id: "github",
    provides: [
      "ticket.number", "ticket.title", "ticket.body", "ticket.labels", "ticket.comments",
      "entries", "tracker.bot",
    ],
    async run({ ticket }) {
      const issue = await tracker.getIssue(ticket);
      const raw = await tracker.listComments(ticket);
      const bot = await tracker.botLogin();
      const names = labelNames(issue);
      return {
        ticket: {
          number: issue.number,
          title: issue.title,
          body: issue.body ?? "",
          state: issue.state,
          url: issue.html_url,
          labels: names,
          stage: stageFromLabels(names).stage,
          comments: raw,
        },
        entries: entriesFromComments(raw, bot),
        // Recorded because the post hook's satisfied() is synchronous and
        // needs to know which comments are ours.
        tracker: { bot },
      };
    },
  });

/**
 * Act. Every write GitHub owns lives here with its own satisfied() — one file
 * per integration, so nobody adds an effect and forgets its dedup rule.
 */
export const githubPostHook = (tracker: TrackerPort) =>
  definePostHook({
    id: "github",
    handles: ["tracker.label", "tracker.status", "tracker.comment"],

    satisfied(snapshot: Snapshot, effect: Effect): boolean {
      const present = labels(snapshot);
      switch (effect.type) {
        // The two label cases read labels, which only an account with write
        // access can set — unlike a comment, which anyone can post. Forging
        // one is the operator-tools problem (lr: labels are refused there),
        // not an authorship question this hook can answer.
        case "tracker.label": {
          const add = (effect.add as string[]) ?? [];
          const remove = (effect.remove as string[]) ?? [];
          return add.every((l) => present.includes(l)) && remove.every((l) => !present.includes(l));
        }
        case "tracker.status":
          // GitHub has no status field; position is a stage label.
          return present.includes(LABELS.stage(String(effect.value)));
        case "tracker.comment": {
          // Only a comment *we* wrote can mean our comment effect has landed.
          // Reading any comment let a stranger who guessed the marker string
          // suppress the effect for good, because reconcile drops it.
          const bot = botLoginOf(snapshot);
          const marker = String(effect.marker);
          return comments(snapshot).some((c) => wroteIt(c, bot) && (c.body ?? "").includes(marker));
        }
        default:
          return false;
      }
    },

    async apply(effect: Effect, { ticket }): Promise<void> {
      switch (effect.type) {
        case "tracker.label": {
          for (const l of (effect.remove as string[]) ?? []) await tracker.removeLabel(ticket, l);
          await tracker.addLabels(ticket, (effect.add as string[]) ?? []);
          return;
        }
        case "tracker.status": {
          const want = LABELS.stage(String(effect.value));
          const current = labelNames(await tracker.getIssue(ticket)).filter((l) => l.startsWith(STAGE_LABEL_PREFIX));
          for (const stale of current.filter((l) => l !== want)) await tracker.removeLabel(ticket, stale);
          await tracker.addLabels(ticket, [want]);
          return;
        }
        case "tracker.comment": {
          const marker: Marker = {
            stage: String(effect.stage ?? "-"),
            kind: String(effect.kind ?? "note"),
            round: Number(effect.round ?? 0),
            ...(effect.marker ? { marker: String(effect.marker) } : {}),
            // The step's own value, already cut to its declared shape by the
            // runner. It rides inside the marker, not in the body: the body
            // is prose, and prose is escaped on the way out precisely so it
            // cannot carry control state. Kept as structure rather than
            // stringified, because parseMarker reads it back with JSON.parse.
            ...(effect.output === undefined ? {} : { output: effect.output }),
          };
          await tracker.createComment(ticket, neutraliseMarkers(String(effect.body ?? "")) + renderMarker(marker));
          return;
        }
        default:
          throw new Error(`github hook cannot apply effect "${effect.type}"`);
      }
    },
  });
