import { messageOf } from "#runner/errors.js";
import type { Preflight, RuntimeContext } from "#namespace.js";

/**
 * Run every registered preflight, in load order, before the caller does
 * anything else — a tick, the triage page, or an MCP connection.
 *
 * The first one that throws stops the run: a permission problem has to be
 * found before the first paid agent runs, not after a mid-run write fails
 * with nothing durable recorded to show for it (see `Preflight` in
 * namespace.ts). Rethrown with the failing preflight's own id, so a person
 * reading stderr knows which one to go fix rather than which line in this
 * file threw.
 */
export async function runPreflights(preflights: Preflight[], ctx: RuntimeContext): Promise<void> {
  for (const preflight of preflights) {
    try {
      await preflight.check(ctx);
    } catch (e) {
      throw new Error(`preflight "${preflight.id}" failed: ${messageOf(e)}`);
    }
  }
}
