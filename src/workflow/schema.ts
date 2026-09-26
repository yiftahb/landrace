import { z } from "zod";
import { durationMs } from "#conventions.js";

const condition = z.record(z.unknown());

/**
 * Open on purpose, and the only thing here that is. An effect's fields belong
 * to whichever post hook claims its type, and the engine does not know what a
 * `tracker.status` or an `artifact.publish` carries. Every other object below
 * is a vocabulary the engine itself reads, so every other object below is
 * closed.
 */
const effect = z.object({ type: z.string() }).catchall(z.unknown());

const trigger = z.object({ name: z.string().optional(), when: condition }).strict();

export const stageSchema = z.object({
  id: z.string().min(1),
  step: z.string().optional(),
  branch: z.string().min(1).optional(),
  entry: z.boolean().optional(),
  terminal: z.boolean().optional(),
  identity: condition.optional(),
  requires: condition.optional(),
  triggers: z.array(trigger).optional(),
  on_enter: z.array(effect).optional(),
  goto: z.array(z.union([
    z.string().min(1),
    z.object({ stage: z.string().min(1), when: condition.optional() }).strict(),
  ])).optional(),
}).strict();

export const workflowSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  stages: z.array(stageSchema).min(1),
  eligible: z.array(z.object({ when: condition, else: z.string().min(1) }).strict()).optional(),
  /**
   * One key, because one key is read. `spec: 3` and `review: 4` sat here for
   * as long as this file has existed while the real caps were literals in the
   * triggers that enforce them, and `humanWait: 24h` had no implementation
   * behind it anywhere — three numbers an operator could edit to no effect at
   * all. A cap belongs in the trigger that enforces it, where it is a
   * predicate the validator can see (§11.4) rather than a number somebody has
   * to keep in step with one.
   */
  budget: z.object({ stepTimeout: z.string().min(1).optional() }).strict().optional(),
  /**
   * Module paths, relative to the workflow directory, in the order pre hooks
   * should run. Flat rather than split by phase because one module exports
   * several kinds — the reference tracker integration exports four — so a
   * per-phase list would make the same file name itself twice, and the kinds
   * are already known from the brand the define* helpers stamp.
   */
  hooks: z.array(z.string()).optional(),
}).strict();

export const stepFrontMatterSchema = z.object({
  capabilities: z.array(z.string()).optional(),
  /**
   * Which model this step is worth. Read by runStep and handed to the
   * executor, where it wins over the operator's own default — a classifier
   * that says `haiku` must not be billed as `opus`.
   */
  model: z.string().min(1).optional(),
  /**
   * How long this step's agent may run before it is killed, overriding
   * `budget.stepTimeout`: a build can need two hours where a classifier needs
   * two minutes, and one number for both is too short for one or too loose
   * for the other. Checked here, at load, so a value nobody can apply is a
   * file that does not load rather than a cap that silently is not there.
   */
  timeout: z.string()
    .refine((t) => (durationMs(t) ?? 0) > 0, { message: 'must be a duration like "30m" or "2h", above zero and at most 596h' })
    .optional(),
  output: z.object({
    discriminator: z.string(),
    shapes: z.record(z.unknown()),
    routes: z.array(z.object({ when: condition, effect, goto: z.string().min(1).optional() }).strict()),
  }).strict().optional(),
}).strict();
