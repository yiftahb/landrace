import { z } from "zod";

export const runtimeConfigSchema = z.object({
  version: z.literal(1),
  /** Typed, because the engine still picks an executor out of the registry by this id. */
  agent: z.object({
    adapter: z.string().min(1),
    model: z.string().optional(),
    isolation: z.enum(["none", "worktree", "container"]).default("worktree"),
    /**
     * Plugin ids (`name@marketplace`) enabled for every step and conversation
     * turn. A read-only step runs `--restricted`, which ignores the operator's
     * own settings — and every plugin enabled there with them.
     */
    plugins: z.array(z.string().min(1)).default([]),
    /**
     * MCP servers a step may use, each looked up by name in the repository
     * root's `.mcp.json` at startup — names, not definitions, so the file
     * agsync generates stays the one place a server is described. A bare name
     * allows every tool the server has; `{ name, tools }` allows only those.
     * Strict, so a misspelt `tool:` is refused rather than read as "every tool".
     */
    mcp: z
      .array(z.union([z.string().min(1), z.object({ name: z.string().min(1), tools: z.array(z.string().min(1)) }).strict()]))
      .default([]),
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
  /**
   * `adapter` names the executor that screens, by the same lookup as
   * `agent.adapter` and falling back to it: a screener on a different
   * provider from the agent it guards is a second opinion rather than the
   * same model reading its own attack. `model` is asked of it on every run.
   *
   * No default here: `haiku` is right for the engine's own claude executor
   * and nothing else, so `screenerFor` supplies it there and refuses to
   * start a hook's executor screening without one.
   */
  security: z
    .object({ screen: z.boolean().default(true), adapter: z.string().min(1).optional(), model: z.string().min(1).optional() })
    .default({}),
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
});
