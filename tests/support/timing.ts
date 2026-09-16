/**
 * The fastest of a few runs of `work`, in milliseconds.
 *
 * Every timing guard in this suite asks one question — is this the linear
 * implementation or the one it replaced — and the two answers are orders of
 * magnitude apart, so the bound beside each call is absolute and loose. Only
 * how the reading is taken should differ, and it used to differ three ways:
 * fastest-of-three, median-of-five, and a single `Date.now()` sample. The
 * single sample is the one that flaked, and it is the one with no defence:
 * every source of error here *adds* time, because the suite's own workers
 * contending for a core make a run slower and never faster.
 *
 * So the minimum is the reading least contaminated by everything that is not
 * the code under test, and a pathological implementation has no fast run to
 * hide behind. Warmed once first, so the JIT and any regex compilation are
 * not part of what is measured.
 */
export function fastest(work: () => unknown, samples = 3): number {
  work();
  let best = Infinity;
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    work();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}
