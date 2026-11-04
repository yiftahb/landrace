import { LOCAL_PERSON_ID } from "#conventions.js";
import { referenceOf } from "#config/env.js";
import type { LoadedConfig, Person } from "#namespace.js";

/**
 * The person a local instance runs for, out of `people.local`. A value still
 * written as a `$VAR` did not resolve — `configProblems` reports it and
 * `start` refuses — so it is left off rather than named as the reference.
 */
export function localPerson({ config }: LoadedConfig): Person {
  const local = config.people?.local;
  const resolved = (value: string | undefined): string | undefined =>
    value === undefined || referenceOf(value) !== undefined ? undefined : value;
  const email = resolved(local?.email);
  const name = resolved(local?.name);
  return { id: LOCAL_PERSON_ID, ...(email === undefined ? {} : { email }), ...(name === undefined ? {} : { name }) };
}

/** What every event of theirs is stamped with: the id, and the email when there is one. */
export function personFields(person: Person): Record<string, unknown> {
  return { person: person.id, ...(person.email === undefined ? {} : { personEmail: person.email }) };
}
