import { z } from "zod";

import { durationMs, ITEM_BRANCH } from "#conventions.js";

/** A URL's hostname on loopback, as `new URL` spells it: an IPv6 address bracketed. */
const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A `secrets` or `vars` value: a string, as it always was, or a key each
 * person supplies for themselves. `env` is a bare variable name, never a
 * `$VAR` and never a value — the object form holds no literal, because one
 * committed file names nobody in particular. `connection` is
 * `<connection id>.<field>`, the stored value a person's connection answers
 * with when the variable is unset.
 */
const keyValue = z.union([
  z.string(),
  z
    .object({
      perPerson: z.literal(true),
      env: z
        .string()
        .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, { message: "must be a bare variable name like LANDRACE_ASSIGNEE, not a $reference or a value" })
        .optional(),
      connection: z.string().regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, { message: 'must be "<connection id>.<field>", like forge.login' }),
    })
    .strict(),
]);

export const runtimeConfigSchema = z.object({
  version: z.literal(1),
  /**
   * The keys the engine reads, and everything else passed on unread to the
   * executor `adapter` names, as `tracker:` is to the tracker hooks. `adapter`
   * picks the executor; `isolation` is how the engine prepares the directory
   * it runs in; `signature` is whether what an agent writes is signed. A
   * coding agent's own settings — its model, its plugins, its servers — are
   * that executor's vocabulary, and it refuses a key it does not read.
   */
  agent: z
    .object({
      adapter: z.string().min(1),
      isolation: z.enum(["none", "worktree", "container"]).default("worktree"),
      /** Whether what an agent writes ends in a line naming its model and effort (`signatureLine`). */
      signature: z.boolean().default(true),
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
  /**
   * The branch an item's work is on, `{item}` filled with the tracker's id as
   * it gives it. Here and not a forge option: `validate` holds every
   * workflow's branch to it and the forges tie a pull request to an item by
   * it, and two places to set one name would be an ambiguity. What makes one
   * a template is `branchTemplateProblem`, reported by `configProblems`.
   */
  branch: z.string().default(ITEM_BRANCH),
  /**
   * The names of the item branch's variants: `<branch>-<name>`, a branch a
   * stage may work on beside the item's own, and that a forge ties back to
   * the item as it does the item branch (`variantBranch`). Here for the same
   * reason `branch` is. What makes one usable is `branchVariantProblem`,
   * reported by `configProblems`.
   */
  branchVariants: z.array(z.string()).default([]),
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
  /**
   * The front door: the board and the operator's MCP endpoint, on one port.
   * `host` is what it binds; `serveProblems` refuses one that is not loopback,
   * since nothing asks who a caller is. `publicUrl` is where a person reaches
   * it through a proxy of their own: the URL `start` prints and notifications
   * link to, and one more name the door answers to.
   */
  serve: z
    .object({
      host: z.string().min(1).default("127.0.0.1"),
      port: z.number().int().min(1).max(65535).default(4545),
      publicUrl: z
        .string()
        .url()
        .refine((u) => /^https?:$/.test(new URL(u).protocol), { message: "must be an http:// or https:// URL" })
        .optional(),
    })
    .strict()
    .default({}),
  workflows: z.array(z.string().min(1)).optional(), // the sidebar's order; must name exactly the folders
  log: z.object({ redact: z.array(z.string()).default([]) }).default({}),
  /** A `$VAR` or a literal, or the per-person form (`keyValue`), resolved in `loadConfig` and the person's store. */
  secrets: z.record(keyValue).default({}),
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
   * in config/load.ts is the check, and `resolvePerson` for a pair with a
   * per-person key in it; this comment is the reason it exists.
   *
   * A var may instead be the per-person form (`keyValue`), whose value comes
   * from its `env` or, unset, from the person's own stored connection.
   */
  vars: z.record(keyValue).default({}),
  /**
   * Who this instance's events belong to: every event `landrace start` logs
   * carries `person: "local"`, and `personEmail` when `email` is set. Each
   * value may be a `$VAR`, resolved per instance as `agent.git`'s is, since one
   * committed file names nobody in particular.
   */
  people: z
    .object({
      local: z.object({ email: z.string().min(1).optional(), name: z.string().min(1).optional() }).strict().optional(),
      /**
       * Set, the instance is remote: everyone signs in through this OpenID
       * Connect provider, and the door may be served beyond loopback. Absent,
       * nothing asks who anyone is. `clientId` and `clientSecret` may be a
       * `$VAR`, resolved as `people.local`'s are. An `http` issuer only on
       * loopback, where a local test provider runs: anywhere else the ID token
       * would cross the network in the clear.
       */
      oidc: z
        .object({
          issuer: z
            .string()
            .url()
            .refine((u) => {
              // Refined even when `.url()` failed; that failure is already its own message.
              if (!URL.canParse(u)) return true;
              const url = new URL(u);
              return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_NAMES.has(url.hostname));
            }, { message: "must be an https:// URL, or http:// on loopback" }),
          clientId: z.string().min(1),
          clientSecret: z.string().min(1),
        })
        .strict()
        .optional(),
      /**
       * An identity the admin pins for a person whose lookup cannot find
       * them: their email, then the connection id, then its fields. Stored
       * as `source: "override"` when they sign in, and held to the same
       * rule as a lookup: a value another person holds is refused.
       */
      overrides: z.record(z.record(z.record(z.string().min(1)))).optional(),
      /**
       * Who a remote instance admits: each entry an email, or `@domain` for
       * every email whose text after its last `@` is that domain — never a
       * subdomain of it. Nothing else: a `*`, a bare `@` or a bare domain
       * would admit far more than it reads as. `allowProblems` refuses a
       * remote instance that lists no one.
       */
      allow: z
        .array(z.string().regex(/^[^\s@]*@[^\s@]+$/, { message: 'must be an email like "ann@example.com", or "@example.com" for its whole domain' }))
        .optional(),
    })
    .strict()
    .optional(),
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
