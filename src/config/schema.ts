import { z } from "zod";

export const runtimeConfigSchema = z.object({
  version: z.literal(1),
  agent: z.object({
    adapter: z.string().min(1),
    model: z.string().optional(),
    isolation: z.enum(["none", "worktree", "container"]).default("worktree"),
  }),
  tracker: z.object({
    adapter: z.string().min(1).default("github"),
    repo: z.string().min(1),
    /** The login landrace posts as. Only needed when the token's own login is
     *  not it — a GitHub App posts under "<app>[bot]". Otherwise resolved from
     *  the token at startup. */
    bot: z.string().min(1).optional(),
    candidates: z.string().optional(),
  }),
  tick: z.object({ interval: z.string().default("60s"), concurrency: z.number().int().positive().default(3) }).default({}),
  security: z.object({ screen: z.boolean().default(true), model: z.string().default("haiku") }).default({}),
  log: z.object({ redact: z.array(z.string()).default([]) }).default({}),
  secrets: z.record(z.string()).default({}),
});

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;
