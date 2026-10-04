import { z } from "zod";

import { durationMs } from "#conventions.js";

export const runtimeConfigSchema = z.object({
  version: z.literal(1),
  /**
   * Two keys the engine reads, and everything else passed on unread to the
   * executor `adapter` names, as `tracker:` is to the tracker hooks. `adapter`
   * picks the executor; `isolation` is how the engine prepares the directory
   * it runs in. A coding agent's own settings — its model, its plugins, its
   * servers — are that executor's vocabulary, and it refuses a key it does
   * not read.
   */
  agent: z
    .object({
      adapter: z.string().min(1),
      isolation: z.enum(["none", "worktree", "container"]).default("worktree"),
      /** What a write step's worktree is given before its agent runs: see `WorktreeSetup`. */
      worktree: z
        .object({
          copy: z.array(z.string().min(1)).default([]),
          setup: z.array(z.string().min(1)).default([]),
          // No default here: one written beside `isolation: none` is refused, and a default is not written.
          lockfiles: z.array(z.string().min(1)).optional(),
          setupTimeout: z
            .string()
            .refine((t) => (durationMs(t) ?? 0) > 0, { message: 'must be a duration like "15m", above zero' })
            .default("15m"),
        })
        .strict()
        .default({}),
    })
    .passthrough(),
  /**
   * Opaque on purpose. Whatever a tracker needs — a repository, a project key,
   * a board id, the account it posts as — is the hook's vocabulary, and the
   * engine has no business having an opinion about it. It is carried through
   * to `ctx.config` unread. There is no `adapter` here either: hooks are
   * imported by path, so there is no id left to name.
   */
  tracker: z.record(z.unknown()).default({}),
  tick: z.object({ interval: z.string().default("60s"), concurrency: z.number().int().positive().default(3) }).default({}),
  /**
   * `adapter` names the executor that screens, by the same lookup as
   * `agent.adapter` and falling back to it: a screener on a different
   * provider from the agent it guards is a second opinion rather than the
   * same model reading its own attack. `model` is asked of it on every run.
   *
   * `model` has no default: a model name is a provider's word, and the
   * engine names no provider. Absent, the screening run names none and the
   * executor's own default decides.
   */
  security: z
    .object({ screen: z.boolean().default(true), adapter: z.string().min(1).optional(), model: z.string().min(1).optional() })
    .default({}),
  workflows: z.array(z.string().min(1)).optional(), // the sidebar's order; must name exactly the folders
  log: z.object({ redact: z.array(z.string()).default([]) }).default({}),
  secrets: z.record(z.string()).default({}),
  /**
   * The same `$VAR` expansion as `secrets`, pointed somewhere else entirely: a
   * secret is handed to a hook at runtime, a var is substituted into
   * `workflow.yaml` and the step files at load, before anything validates
   * them. That is what makes one instance per developer possible — the graph
   * is the same file for everyone and `$LANDRACE_ASSIGNEE` differs.
   *
   * Strings only, because substitution happens in string positions: a var's
   * value lands inside a predicate operand or a prompt, where a number would
   * arrive as its own spelling anyway. Quote it and it works.
   *
   * These are *not* secrets, and the schema cannot enforce that — the log
   * redacts by value and only knows the values `secrets` declares, while a var
   * reaches a comment body and an agent's prompt unredacted. `varsHoldingSecrets`
   * in config/load.ts is the check; this comment is the reason it exists.
   */
  vars: z.record(z.string()).default({}),
  /**
   * Who is told when an item comes to rest waiting on a person: `on` the
   * events, `via` the notifier hooks by id. Strict, and `needs-you` is the one
   * event there is — a notify block naming anything else would promise a
   * message that never comes.
   */
  notify: z
    .object({ on: z.array(z.literal("needs-you")).min(1), via: z.array(z.string().min(1)).min(1) })
    .strict()
    .optional(),
});
