import { FIELD_EFFECT, TRACKER_CREATE_EFFECT } from "#conventions.js";
import { messageOf } from "#runner/errors.js";
import type { Preflight, PreflightContext, Step, TrackerFieldValue, Workflow } from "#namespace.js";

/**
 * Run every registered preflight, in load order, before the caller does
 * anything else — a tick, the triage page, or an MCP connection.
 *
 * The first one that throws stops the run: a permission problem has to be
 * found before the first paid agent runs, not after a mid-run write fails
 * with nothing durable recorded to show for it (see `Preflight` in
 * namespace.ts). Rethrown with the failing preflight's own id, so a person
 * reading stderr knows which one to go fix rather than which line in this
 * file threw.
 */
export async function runPreflights(preflights: Preflight[], ctx: PreflightContext): Promise<void> {
  for (const preflight of preflights) {
    try {
      await preflight.check(ctx);
    } catch (e) {
      throw new Error(`preflight "${preflight.id}" failed: ${messageOf(e)}`);
    }
  }
}

/** Every capability a step of the loaded workflows declares, for the preflights to skip what none asks for. */
export function declaredCapabilities(workflows: Iterable<ReadonlyMap<string, Step>>): Set<string> {
  const declared = new Set<string>();
  for (const steps of workflows) for (const step of steps.values()) for (const capability of step.capabilities ?? []) declared.add(capability);
  return declared;
}

/**
 * Each project's field ids a route's `tracker.create` fills from its answer,
 * for the tracker's preflight to find on the issue type it files: a field off
 * its create screen would refuse the first bug, after the step was paid for.
 * Routes only — `fieldsFrom` reads an answer, and `validate` refuses it
 * anywhere else — whether a route has one effect or a list of them.
 */
export function declaredCreateFields(workflows: Iterable<ReadonlyMap<string, Step>>): Map<string, Set<string>> {
  const declared = new Map<string, Set<string>>();
  for (const steps of workflows) {
    for (const step of steps.values()) {
      for (const route of step.output?.routes ?? []) {
        for (const effect of [...(route.effect ? [route.effect] : []), ...(route.effects ?? [])]) {
          const { project, fieldsFrom } = effect as { project?: unknown; fieldsFrom?: unknown };
          if (effect.type !== TRACKER_CREATE_EFFECT || typeof project !== "string") continue;
          if (fieldsFrom === null || typeof fieldsFrom !== "object" || Array.isArray(fieldsFrom)) continue;
          const fields = declared.get(project) ?? new Set<string>();
          for (const field of Object.keys(fieldsFrom)) fields.add(field);
          declared.set(project, fields);
        }
      }
    }
  }
  return declared;
}

/** A value `tracker.field` takes; anything else `validate` refuses, and nothing here guesses at it. */
const isFieldValue = (value: unknown): value is TrackerFieldValue =>
  typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) ||
  (Array.isArray(value) && value.every((v) => typeof v === "string"));

/**
 * Each field id a loaded `tracker.field` sets, with every value it is set
 * to: in a stage's `on_enter`, and in the routes of the step a stage runs,
 * whether a route has one effect or a list of them. The ids are what a
 * tracker's reads fetch into `node.state.fields`; the values are what its
 * preflight checks a field can hold, before an item is entered into a stage
 * whose transition needs it.
 */
export function declaredTrackerFields(
  workflows: Iterable<{ workflow: Workflow; steps: ReadonlyMap<string, Step> }>,
): Map<string, TrackerFieldValue[]> {
  const declared = new Map<string, TrackerFieldValue[]>();
  for (const { workflow, steps } of workflows) {
    for (const stage of workflow.stages) {
      const routes = (stage.step === undefined ? undefined : steps.get(stage.step))?.output?.routes ?? [];
      const effects = [...(stage.on_enter ?? []), ...routes.flatMap((route) => [...(route.effect ? [route.effect] : []), ...(route.effects ?? [])])];
      for (const effect of effects) {
        const { fields } = effect as { fields?: unknown };
        if (effect.type !== FIELD_EFFECT || fields === null || typeof fields !== "object" || Array.isArray(fields)) continue;
        for (const [id, value] of Object.entries(fields)) {
          if (!isFieldValue(value)) continue;
          declared.set(id, [...(declared.get(id) ?? []), value]);
        }
      }
    }
  }
  return declared;
}

/** What the loaded workflows declare, as a preflight is handed it by every caller alike. */
export function declaredOf(
  workflows: ReadonlyArray<{ workflow: Workflow; steps: ReadonlyMap<string, Step> }>,
): Pick<PreflightContext, "capabilities" | "createFields"> {
  const steps = workflows.map((w) => w.steps);
  return { capabilities: declaredCapabilities(steps), createFields: declaredCreateFields(steps) };
}

/**
 * Each preflight once, by identity and in load order, handed as `fieldValues`
 * only what the workflows that load it set with `tracker.field`. A tracker
 * checks a value against its own project's screens, so a second workflow's
 * value, on another project, would refuse an option only that one offers.
 */
export function scopedPreflights(
  loads: Iterable<{ preflights: readonly Preflight[]; workflow: { workflow: Workflow; steps: ReadonlyMap<string, Step> } }>,
): Preflight[] {
  const loadedBy = new Map<Preflight, Array<{ workflow: Workflow; steps: ReadonlyMap<string, Step> }>>();
  for (const { preflights, workflow } of loads) for (const preflight of preflights) loadedBy.set(preflight, [...(loadedBy.get(preflight) ?? []), workflow]);
  return [...loadedBy].map(([preflight, workflows]) => {
    const fieldValues = declaredTrackerFields(workflows);
    return { id: preflight.id, check: (ctx) => preflight.check({ ...ctx, fieldValues }) };
  });
}
