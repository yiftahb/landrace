import type { Problem, RuntimeConfig } from "#namespace.js";

/**
 * Whether `people.allow` admits `email`: an entry equal to it, or `@domain`
 * where the domain is the text after the email's last `@`, both compared in
 * lower case. No subdomains, no patterns: the fewest surprises.
 *
 * Denies by default. No list, or no email — `Person.email` is optional, and a
 * provider need not send one — admits nobody: a forgotten list or a missing
 * claim letting everyone in is the failure this exists to prevent.
 */
export function admits(allow: readonly string[] | undefined, email: string | undefined): boolean {
  if (allow === undefined || email === undefined) return false;
  const lower = email.toLowerCase();
  const at = lower.lastIndexOf("@");
  if (at === -1) return false;
  const domain = `@${lower.slice(at + 1)}`;
  return allow.some((entry) => {
    const e = entry.toLowerCase();
    return e.startsWith("@") ? e === domain : e === lower;
  });
}

/** A remote instance that lists nobody in `people.allow` would admit nobody: refused, by `validate` and `start` alike. */
export function allowProblems(people: RuntimeConfig["people"]): Problem[] {
  if (people?.oidc === undefined || (people.allow?.length ?? 0) > 0) return [];
  return [{
    rule: "people.allow",
    message:
      "people.oidc is set and people.allow lists no one, so nobody could sign in. " +
      'List each email admitted, or "@example.com" for everyone at a domain',
  }];
}
