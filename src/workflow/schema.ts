import { z } from "zod";

const condition = z.record(z.unknown());

const effect = z.object({ type: z.string() }).catchall(z.unknown());

const trigger = z.object({ name: z.string().optional(), when: condition });

export const stageSchema = z.object({
  id: z.string().min(1),
  step: z.string().optional(),
  entry: z.boolean().optional(),
  terminal: z.boolean().optional(),
  identity: condition.optional(),
  requires: condition.optional(),
  triggers: z.array(trigger).optional(),
  on_enter: z.array(effect).optional(),
});

export const workflowSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  stages: z.array(stageSchema).min(1),
  eligible: z.array(z.object({ when: condition, else: z.string().min(1) })).optional(),
  budget: z.record(z.unknown()).optional(),
  /**
   * Module paths, relative to the workflow directory, in the order pre hooks
   * should run. Flat rather than split by phase because one module exports
   * several kinds — the reference tracker integration exports four — so a
   * per-phase list would make the same file name itself twice, and the kinds
   * are already known from the brand the define* helpers stamp.
   */
  hooks: z.array(z.string()).optional(),
  artifacts: z.record(z.object({ hook: z.string(), ref: z.string() })).optional(),
});

export const stepFrontMatterSchema = z.object({
  skills: z.array(z.string()).optional(),
  capabilities: z.array(z.string()).optional(),
  model: z.string().optional(),
  output: z.object({
    discriminator: z.string(),
    shapes: z.record(z.unknown()),
    routes: z.array(z.object({ when: condition, effect })),
  }).optional(),
});

export type StepFrontMatter = z.infer<typeof stepFrontMatterSchema>;
