import { definePostHook, definePreHook } from "../../hooks/types.js";
import type { Effect, Snapshot } from "../../core/types.js";
import { labelNames, type TrackerPort } from "../types.js";
import { LABELS, neutraliseMarkers, renderMarker, stageFromLabels, STAGE_LABEL_PREFIX, type Marker } from "../../conventions.js";
import { entriesFromComments } from "./markers.js";

const labels = (s: Snapshot): string[] => ((s.ticket as { labels?: string[] })?.labels ?? []);
const comments = (s: Snapshot): Array<{ body: string }> =>
  ((s.ticket as { comments?: Array<{ body: string }> })?.comments ?? []);

/** Observe: turn a GitHub issue into the snapshot the engine reads. */
export const githubPreHook = (tracker: TrackerPort) =>
  definePreHook({
    id: "github",
    provides: ["ticket.number", "ticket.title", "ticket.body", "ticket.labels", "ticket.comments", "entries"],
    async run({ ticket }) {
      const issue = await tracker.getIssue(ticket);
      const raw = await tracker.listComments(ticket);
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
        entries: entriesFromComments(raw),
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
        case "tracker.label": {
          const add = (effect.add as string[]) ?? [];
          const remove = (effect.remove as string[]) ?? [];
          return add.every((l) => present.includes(l)) && remove.every((l) => !present.includes(l));
        }
        case "tracker.status":
          // GitHub has no status field; position is a stage label.
          return present.includes(LABELS.stage(String(effect.value)));
        case "tracker.comment":
          return comments(snapshot).some((c) => c.body.includes(String(effect.marker)));
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
          };
          await tracker.createComment(ticket, neutraliseMarkers(String(effect.body ?? "")) + renderMarker(marker));
          return;
        }
        default:
          throw new Error(`github hook cannot apply effect "${effect.type}"`);
      }
    },
  });
