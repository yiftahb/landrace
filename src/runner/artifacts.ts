import { isReservedId, neutraliseMarkers } from "#conventions.js";
import { definePreHook } from "#hooks/contracts.js";
import { messageOf } from "#runner/errors.js";
import type { ArtifactHook, HookContext, PreHook } from "#namespace.js";

/**
 * Deep enough for any artifact a workflow reads through a dot-path, and far
 * shallower than the snapshot's own canonicalisation cap, so a remote document
 * that is too deep fails *here*, naming the artifact, rather than as an
 * unattributed throw from inside the hashing path on every tick.
 */
const MAX_DEPTH = 8;

/**
 * A whole artifact's state, not a document. Pages returns a hash and a URL; a
 * PR returns a handful of counts. Anything approaching this is a hook handing
 * the snapshot a remote document verbatim — which is then canonicalised and
 * hashed on every pass of every tick, for a value no predicate can read.
 */
const MAX_CHARS = 64 * 1024;

/**
 * Why this value cannot be carried in the snapshot, or null if it can.
 *
 * Artifact state is the one snapshot region whose shape a remote document
 * reaches, and everything downstream assumes JSON: `canonicalize` stringifies
 * it into the snapshot hash (where `undefined` and a function vanish and NaN
 * becomes null, so the hash would claim two different worlds were the same),
 * and predicates address it by dot-path. Refused at the boundary rather than
 * coerced, because a silently dropped field is a predicate that silently stops
 * matching.
 */
function problemWith(value: unknown, path: string, depth: number, size: { chars: number }): string | null {
  if (depth > MAX_DEPTH) return `${path} is nested deeper than ${MAX_DEPTH} levels`;
  if (value === null || typeof value === "boolean") return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? null : `${path} is ${String(value)}, which JSON cannot carry`;
  }
  if (typeof value === "string") {
    size.chars += value.length;
    return size.chars > MAX_CHARS ? `it is over ${MAX_CHARS} characters` : null;
  }
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      const problem = problemWith(item, `${path}[${i}]`, depth + 1, size);
      if (problem) return problem;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      // A reserved key is not a field name but a reachable key on a plain
      // object: it arrives from the network through JSON.parse as an own
      // property, and every consumer downstream walks these objects by name.
      if (isReservedId(key)) return `${path}.${key} is a reserved object key`;
      size.chars += key.length;
      if (size.chars > MAX_CHARS) return `it is over ${MAX_CHARS} characters`;
      const problem = problemWith(item, `${path}.${key}`, depth + 1, size);
      if (problem) return problem;
    }
    return null;
  }
  return `${path} is a ${typeof value}, which JSON cannot carry`;
}

/** The artifacts previous hooks have already contributed this pass. */
function priorArtifacts(snapshot: HookContext["snapshot"]): Record<string, unknown> {
  const prior = snapshot.artifacts;
  if (prior === undefined) return {};
  if (prior === null || typeof prior !== "object" || Array.isArray(prior)) {
    throw new Error(`the snapshot's "artifacts" is a ${Array.isArray(prior) ? "list" : typeof prior}, not an object of artifact states`);
  }
  return prior as Record<string, unknown>;
}

/**
 * The observe half of an artifact hook, as a pre hook.
 *
 * The hook returns its own state and this decides where it lands, because
 * `artifacts.<name>` is a public contract every workflow's predicates are
 * written against — not a convention each integration is trusted to remember.
 * Letting the hook return the whole fragment also lost state outright: pre-hook
 * fragments merge with a shallow spread, so a second artifact returning its own
 * `{ artifacts: { … } }` replaced the first one's entry and the predicate
 * reading it simply stopped matching.
 */
export function artifactPreHook(hook: ArtifactHook): PreHook {
  // At wiring time, not at read time: an id is fixed when the module is
  // loaded, so an unusable one should stop the daemon starting rather than
  // stop one ticket, once per tick, forever.
  if (isReservedId(hook.id)) {
    throw new Error(`artifact "${hook.id}" is named after a reserved object key and cannot be addressed in the snapshot`);
  }

  return definePreHook({
    id: hook.id,
    // Wildcarded: an artifact's fields are the integration's business, and
    // validate's path coverage only needs to know who owns the prefix.
    provides: [`artifacts.${hook.id}.*`],
    run: async (ctx: HookContext) => {
      let state: Record<string, unknown>;
      try {
        state = await hook.read(ctx);
      } catch (e) {
        throw new Error(`artifact "${hook.id}" could not be read: ${messageOf(e)}`);
      }

      if (state === null || typeof state !== "object" || Array.isArray(state)) {
        throw new Error(
          `artifact "${hook.id}" read back ${Array.isArray(state) ? "a list" : typeof state}, not an object of its state`,
        );
      }

      const problem = problemWith(state, "", 0, { chars: 0 });
      if (problem) throw new Error(`artifact "${hook.id}" read back state the snapshot cannot carry: ${problem}`);

      // A computed key in an object literal defines an own property rather
      // than going through a setter, so nothing here can reach a prototype
      // even before the reserved-key refusal above.
      return { artifacts: { ...priorArtifacts(ctx.snapshot), [hook.id]: state } };
    },
  });
}

/**
 * How much prompt text every artifact's briefing gets between them, per
 * invocation.
 *
 * Cut rather than refused, and that is the choice worth stating: a briefing is
 * unbounded text that whoever can comment on a pull request writes, so a
 * refusal would be a ticket halted by anyone willing to paste a megabyte into
 * a review thread. Nothing downstream reads a briefing as state, so there is
 * no predicate that silently stops matching when it is cut — unlike artifact
 * state above, where a dropped field is exactly that.
 */
const BRIEF_MAX_CHARS = 32 * 1024;

/**
 * Which artifacts a step's prompt actually asks for, by name.
 *
 * The prompt is the only consumer a briefing has, and a step file is the
 * workflow author's own text — so this is an exact question about a static
 * template, not a guess. It is also what keeps the cost honest: a briefing is
 * an unbounded remote read, and `spec`, `triage` and `build` have no use for
 * the review threads that `fix-review` exists to address.
 */
const briefingsNamedIn = (prompt: string): Set<string> =>
  new Set([...prompt.matchAll(/\{brief\.([a-zA-Z0-9_]+)\./g)].map((m) => m[1] as string));

/**
 * Ask every artifact the prompt names for its briefing: prompt text, filed under
 * the hook's own name, and nowhere near the snapshot.
 *
 * Called from the invoke path only, so this costs a request per *invocation*
 * rather than per converge pass — and a workflow with no step running never
 * pays for it at all.
 *
 * Escaped on the way in, not on the way out. A briefing's only consumer is
 * `renderPrompt`, and the fixer's reply to a finding is posted straight back
 * to the tracker: text that arrives carrying one of our markers has to stop
 * being able to forge one at the boundary, once, rather than at each place it
 * is later spliced into something.
 */
export async function buildBriefing(
  artifacts: ArtifactHook[],
  ctx: HookContext,
  prompt: string,
): Promise<Record<string, Record<string, string>>> {
  const built: Record<string, Record<string, string>> = {};
  let left = BRIEF_MAX_CHARS;
  const asked = briefingsNamedIn(prompt);

  for (const hook of artifacts) {
    if (!hook.brief || !asked.has(hook.id)) continue;

    let fragment: Record<string, string>;
    try {
      fragment = await hook.brief(ctx);
    } catch (e) {
      throw new Error(`the briefing for artifact "${hook.id}" failed: ${messageOf(e)}`);
    }
    if (fragment === null || typeof fragment !== "object" || Array.isArray(fragment)) {
      throw new Error(
        `the briefing for artifact "${hook.id}" read back ${Array.isArray(fragment) ? "a list" : typeof fragment}, ` +
        "not an object of prompt text",
      );
    }

    const kept: Record<string, string> = {};
    for (const [key, value] of Object.entries(fragment)) {
      // Same boundary the state above draws, for the same reason: a reserved
      // id is not a field name but a reachable key on a plain object, and the
      // prompt scope is walked by name.
      if (isReservedId(key)) {
        throw new Error(`artifact "${hook.id}" briefed a key named "${key}", which is a reserved object key`);
      }
      if (typeof value !== "string") {
        throw new Error(
          `artifact "${hook.id}" briefed "${key}" as a ${typeof value}; a briefing is prompt text, nothing else`,
        );
      }
      const safe = neutraliseMarkers(value);
      kept[key] = safe.length <= left ? safe : `${safe.slice(0, Math.max(0, left))}\n\n…[truncated]`;
      left = Math.max(0, left - safe.length);
    }
    built[hook.id] = kept;
  }

  return built;
}
