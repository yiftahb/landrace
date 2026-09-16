/**
 * An `Executor`, a `PostHook`, a `PreHook` — anything is a plain interface
 * implemented by whatever library sits behind it, and nothing stops that
 * library from rejecting with something that is not a well-behaved `Error`.
 * `(e as Error).message` does not return `undefined` for a weird shape, it
 * *throws* — from inside the very catch block whose job is to turn the
 * failure into a reportable message, which is exactly backwards: an outage
 * (a rejection with a weird shape) is precisely when this must not itself
 * crash. `screen.ts` had the `instanceof Error ? e.message : String(e)`
 * shape right first, but that shape is not actually safe on its own — an
 * Error subclass with a throwing `message` getter, a throwing `toString` or
 * `Symbol.toPrimitive`, a Proxy trapping `get`, a revoked Proxy (where even
 * `instanceof` throws), or a null-prototype object (which has no inherited
 * `toString` for `String()` to call at all) can each make it throw in turn —
 * as can an `AggregateError` whose `.errors` getter throws, or one that
 * cites itself as its own first inner error. Every property read and every
 * coercion is individually guarded, `instanceof` is not trusted as a safe
 * first step, and recursion into a wrapped error is depth-bounded. This is a
 * checked claim, not an aspiration: `tests/runner/errors.test.ts` attacks
 * each shape named above and this function must not throw for any of them —
 * extend that test file before extending this one's confidence.
 */
const FALLBACK = "an error occurred, but its message could not be read";

/** A plain, guarded property read — safe even on a null-prototype object (no inherited method to fail), and safe against a Proxy whose `get` trap throws. */
function readMessage(e: object): string | undefined {
  try {
    const m = (e as Record<string, unknown>).message;
    return typeof m === "string" ? m : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `AggregateError`'s own `message` defaults to `""` when constructed without
 * one (`new AggregateError([inner])`, the common shape), which is
 * technically a string but useless — the real information is in the first
 * wrapped error. Guarded and depth-bounded: `.errors` is a plain accessor
 * property, so nothing stops it from throwing (a Proxy-wrapped array,
 * say), and nothing stops an `AggregateError` from citing itself as its own
 * first inner error — `new AggregateError([agg])` — which would otherwise
 * recurse into `messageOf` forever.
 */
function firstAggregateMessage(e: unknown, depth: number): string | undefined {
  try {
    if (!(e instanceof AggregateError)) return undefined;
    const inner = Array.isArray(e.errors) ? (e.errors as unknown[])[0] : undefined;
    return inner === undefined ? undefined : messageOfAt(inner, depth + 1);
  } catch {
    return undefined;
  }
}

const MAX_DEPTH = 10;

function messageOfAt(e: unknown, depth: number): string {
  if (depth > MAX_DEPTH) return FALLBACK;

  try {
    // `instanceof` on a revoked Proxy throws too — it needs the target's
    // prototype chain, which a revoked Proxy can no longer produce. Wrapped
    // here rather than trusted as the safe first step it looks like.
    if (e instanceof Error) {
      // A plain property read alone can throw (a subclass with a throwing
      // `message` getter), so this is guarded exactly like the
      // generic-object case below, not trusted just because `instanceof`
      // succeeded.
      const own = readMessage(e);
      if (own !== undefined && own !== "") return own;
      return firstAggregateMessage(e, depth) ?? own ?? FALLBACK;
    }
  } catch {
    return FALLBACK;
  }

  try {
    if (e !== null && typeof e === "object") {
      // Tried before any coercion: a plain property read is safe on a
      // null-prototype object (nothing to inherit, so nothing to fail),
      // where `String(e)` is not — coercion must find *some* stringifier to
      // call, and a null-prototype object has none, throwing before ever
      // reaching this function's own guards.
      const read = readMessage(e);
      if (read !== undefined) return read;
    }
  } catch {
    return FALLBACK;
  }

  try {
    return String(e);
  } catch {
    return FALLBACK;
  }
}

export function messageOf(e: unknown): string {
  return messageOfAt(e, 0);
}
