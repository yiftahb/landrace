/**
 * An `Executor`, a `PostHook`, a `PreHook` — anything is a plain interface
 * implemented by whatever library sits behind it, and nothing stops that
 * library from rejecting with something that is not an `Error` (`throw null`,
 * a bare string, a response object). `(e as Error).message` on one of those
 * does not return `undefined`, it *throws* — from inside the very catch block
 * whose job is to turn the failure into a reportable message, which is
 * exactly backwards: the outage case (a rejection with a weird shape) is
 * precisely when this must not itself crash. `screen.ts` had this right
 * first; every other place that describes a caught failure now goes through
 * this one function instead of a second (and a third) copy of the same
 * ternary that someone eventually forgets.
 */
export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
