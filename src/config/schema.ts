import { z } from "zod";

export const runtimeConfigSchema = z.object({
  version: z.literal(1),
  /** Typed, because the engine still picks an executor out of the registry by this id. */
  agent: z.object({
    adapter: z.string().min(1),
    model: z.string().optional(),
    isolation: z.enum(["none", "worktree", "container"]).default("worktree"),
  }),
  /**
   * Opaque on purpose. Whatever a tracker needs — a repository, a project key,
   * a board id, the account it posts as — is the hook's vocabulary, and the
   * engine has no business having an opinion about it. It is carried through
   * to `ctx.config` unread. There is no `adapter` here either: hooks are
   * imported by path, so there is no id left to name.
   */
  tracker: z.record(z.unknown()).default({}),
  tick: z.object({ interval: z.string().default("60s"), concurrency: z.number().int().positive().default(3) }).default({}),
  security: z.object({ screen: z.boolean().default(true), model: z.string().default("haiku") }).default({}),
  log: z.object({ redact: z.array(z.string()).default([]) }).default({}),
  secrets: z.record(z.string()).default({}),
});

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;
