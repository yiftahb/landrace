import type { Logger, Node, Notifier, NotifyEvent, Problem, Registry, RuntimeConfig, RuntimeContext, Snapshot, Workflow } from "#namespace.js";
import { messageOf } from "#runner/errors.js";
import { laneOf, oneLine, statusRows } from "#runner/status.js";

/**
 * What converge calls with the snapshot a ticket came to rest on. The rule is
 * the board's own — `laneOf` over `statusRows` — so a notifier and the page
 * cannot disagree about who is waiting on you.
 *
 * Fire-and-forget: every send is started and none is awaited, and a send that
 * fails, however it fails, is a `notify.failed` line and nothing more. A chat
 * being down must never stop a ticket, and nothing is kept about what was
 * sent — converge decides *when* this runs, and that is derived.
 */
export function createNotify(opts: {
  workflow: Workflow;
  notify: RuntimeConfig["notify"];
  notifiers: ReadonlyMap<string, Notifier>;
  ctx: RuntimeContext;
  log: Logger;
  /** The board's URL, asked at send time: the page starts after the runtime is built. */
  board: () => string | null;
}): (snapshot: Snapshot) => void {
  return (snapshot) => {
    const notify = opts.notify;
    if (!notify?.on.includes("needs-you")) return;
    const node = snapshot.node as Node;
    // The board's own override, before laneOf: a closed ticket is Done
    // whatever labels nobody took off.
    if (node.closed !== null) return;
    const [row] = statusRows(opts.workflow, [node]);
    if (!row || laneOf(row, opts.workflow) !== "needs-you") return;

    const event: NotifyEvent = {
      event: "needs-you", ticket: row.ticket, title: oneLine(row.title), link: node.link,
      stage: row.stage, why: oneLine(row.note), board: opts.board(),
    };
    for (const via of notify.via) {
      const notifier = opts.notifiers.get(via);
      // Refused at start by notifyProblems; nothing to send through here.
      if (!notifier) continue;
      // Inside a then, so a send that throws before returning a promise is
      // caught the same way as one that rejects.
      void Promise.resolve()
        .then(() => notifier.send(event, opts.ctx))
        .then(
          () => opts.log("notify.sent", { ticket: row.ticket, via }),
          (e: unknown) => opts.log("notify.failed", { ticket: row.ticket, via, reason: messageOf(e) }),
        );
    }
  };
}

/** A `notify.via` id no loaded hook answers to — refused by `start` and reported by `validate`, in these words. */
export function notifyProblems(config: RuntimeConfig, registry: Pick<Registry, "notifiers">): Problem[] {
  const registered = [...registry.notifiers.keys()];
  const known = registered.length ? registered.map((id) => `"${id}"`).join(", ") : "none";
  return (config.notify?.via ?? [])
    .filter((id) => !registry.notifiers.has(id))
    .map((id) => ({
      rule: "notify",
      message: `notify.via names "${id}", which no notifier registers: the loaded hooks register ${known}`,
    }));
}
