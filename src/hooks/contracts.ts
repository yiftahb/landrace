/**
 * The define* contracts: how a hook module says what each of its exports is.
 *
 * Values only — the interfaces these helpers take are declared in
 * `src/namespace.ts` with every other type in the system, so the brand's type
 * and its runtime constructor live apart. Nothing depends on them being
 * together: a brand is a symbol written onto an object at runtime, and
 * `hookKindOf` reads that symbol back, neither of which the type system is
 * party to.
 */
import type {
  ArtifactHook,
  Executor,
  ExecutorFactory,
  HookKind,
  Notifier,
  Operator,
  PostHook,
  PreHook,
  Preflight,
  Source,
} from "#namespace.js";

/**
 * Every kind the loader classifies. The list is the loader's vocabulary, and
 * `tests/boundaries.test.ts` checks that each entry has a define* helper — a
 * kind with no helper is a kind nobody can register, which would fail silently
 * at load rather than loudly at build.
 */
export const HOOK_KINDS = ["pre", "post", "artifact", "source", "operator", "executor", "preflight", "notifier"] as const;

/**
 * How the loader tells the kinds apart.
 *
 * Stamped, not sniffed: "it has `handles`, so it is a post hook" is a guess,
 * and a guess that goes wrong registers half an integration and leaves the
 * other half unreachable with nothing said about it. Ambiguity halts here as
 * everywhere else, and a brand is what makes the question answerable at all.
 *
 * Registered globally, because a hook module resolves `landrace/hooks` for
 * itself: if npm ever hands it a second copy of this module, a module-local
 * symbol would make every hook in it read as unbranded — a silent, baffling
 * "your integration did not load". Forgeable, and that is fine: a hook module
 * is arbitrary code we are about to import anyway, so this is a classifier,
 * not a trust boundary.
 */
const KIND = Symbol.for("landrace.hook.kind");

/** Non-enumerable, so a hook stays a plain data object: no brand in Object.keys, in JSON, or in an equality check over its fields. */
const brand = <T extends object>(kind: HookKind, value: T): T =>
  Object.defineProperty(value, KIND, { value: kind, enumerable: false });

/** The kind a define* helper stamped, or null for anything else — a hook module is free to export helpers and constants too. */
export function hookKindOf(value: unknown): HookKind | null {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return null;
  const kind: unknown = (value as Record<symbol, unknown>)[KIND];
  return (HOOK_KINDS as readonly unknown[]).includes(kind) ? (kind as HookKind) : null;
}

export const definePreHook = (hook: PreHook): PreHook => brand("pre", hook);
export const definePostHook = (hook: PostHook): PostHook => brand("post", hook);
export const defineArtifactHook = (hook: ArtifactHook): ArtifactHook => brand("artifact", hook);
export function defineExecutor(executor: Executor): Executor;
export function defineExecutor(factory: ExecutorFactory): ExecutorFactory;
export function defineExecutor(value: Executor | ExecutorFactory): Executor | ExecutorFactory {
  return brand("executor", value);
}
export const defineSource = (source: Source): Source => brand("source", source);
export const defineOperator = (operator: Operator): Operator => brand("operator", operator);
export const definePreflight = (preflight: Preflight): Preflight => brand("preflight", preflight);
export const defineNotifier = (notifier: Notifier): Notifier => brand("notifier", notifier);
