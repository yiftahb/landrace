import type { Effect, Snapshot } from "../core/types.js";
import type { RuntimeConfig } from "../config/schema.js";

/**
 * What a hook is handed. Secrets arrive resolved, so a hook never reads
 * `process.env` itself — that is what makes a hook testable, and what lets log
 * redaction know every value that must never be printed.
 */
export interface HookContext {
  ticket: number;
  snapshot: Snapshot;
  config: RuntimeConfig;
  secrets: ReadonlyMap<string, string>;
  signal: AbortSignal;
  log: (event: string, data?: Record<string, unknown>) => void;
}

/** Observe. Fetch or compute; the engine does not care which. */
export interface PreHook {
  id: string;
  provides?: string[];
  run(ctx: HookContext): Promise<Record<string, unknown>> | Record<string, unknown>;
}

/**
 * Act. `satisfied` is pure and called often during reconcile; `apply` is impure
 * and raced against a deadline. Both live in one hook so nobody adds an effect
 * and forgets its dedup rule.
 */
export interface PostHook {
  id: string;
  handles: string[];
  satisfied(snapshot: Snapshot, effect: Effect): boolean;
  apply(effect: Effect, ctx: HookContext): Promise<void>;
}

/**
 * Something outside the tracker with its own mutable state, which the workflow
 * both writes and reads back. `read` is mandatory: an artifact whose state
 * cannot be read is state that cannot be re-derived, which would break the one
 * guarantee the whole design rests on.
 */
export interface ArtifactHook extends PostHook {
  read(ctx: HookContext): Promise<Record<string, unknown>>;
}

/**
 * The execution plane. Not a hook: invoking an agent produces new information,
 * and an effect hook that produced information would need tracker credentials.
 */
export interface Executor {
  id: string;
  run(
    prompt: string,
    opts: { round: number; resume?: string; cwd?: string; signal: AbortSignal },
  ): Promise<{ text: string; sessionId: string | null }>;
}

export const definePreHook = (hook: PreHook): PreHook => hook;
export const definePostHook = (hook: PostHook): PostHook => hook;
export const defineArtifactHook = (hook: ArtifactHook): ArtifactHook => hook;
export const defineExecutor = (executor: Executor): Executor => executor;
