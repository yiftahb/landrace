import { fillTemplate } from "#core/index.js";
import type { VarSubstitution } from "#namespace.js";

/**
 * The namespace a configured variable answers under. Prefixed rather than
 * bare, so a var can never shadow `{round}`, `{stage}` or a snapshot path a
 * prompt reads — the three vocabularies share one syntax and must not share
 * one namespace.
 */
const PREFIX = "vars.";

/**
 * `{vars.<name>}`, everywhere it appears in a parsed workflow, replaced by the
 * value the configuration resolved once at load.
 *
 * Over the parsed tree, never over the file's text, and that is the whole
 * design. Substituted into YAML before it is parsed, a value carrying a colon,
 * a newline or a quote ends the mapping it sits in and starts something else —
 * the workflow that loads is not the workflow anybody wrote, and the operator's
 * own environment is what reshaped it. Here a value lands in one string
 * position and stays one string, whatever is in it.
 *
 * Strings only, and only in value position: an object's keys are predicate
 * paths and effect types, which are structure rather than content. A var in
 * one is left in place, where it reads as a path no hook provides and
 * `path-coverage` says so — and its name shows up as declared-but-unused,
 * which is the other end of the same typo.
 *
 * Nothing is thrown from here. The caller holds every file's report, because
 * "this var is declared and nothing references it" cannot be answered until
 * the last step file has been walked.
 */
export function substituteVars(
  tree: unknown,
  vars: ReadonlyMap<string, string>,
  at: string,
): VarSubstitution {
  const used = new Set<string>();
  const unresolved: string[] = [];

  const walk = (node: unknown, where: string): unknown => {
    if (typeof node === "string") {
      return fillTemplate(node, (name) => {
        // Every other template in the system passes straight through: they are
        // filled per entry and per invocation, long after this.
        if (!name.startsWith(PREFIX)) return undefined;
        const key = name.slice(PREFIX.length);
        const value = vars.get(key);
        if (value === undefined) {
          unresolved.push(`${where ? `${at} ${where}` : at} uses {${name}}`);
          return undefined;
        }
        used.add(key);
        return value;
      });
    }
    if (Array.isArray(node)) return node.map((item, i) => walk(item, `${where}[${i}]`));
    if (node !== null && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node).map(([key, value]) => [key, walk(value, where ? `${where}.${key}` : key)]),
      );
    }
    return node;
  };

  return { value: walk(tree, ""), used: [...used], unresolved };
}
