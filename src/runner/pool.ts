import { compareIds } from "#conventions.js";
import type { SlotListener, SlotPool } from "#namespace.js";

/**
 * `tick.concurrency` agent slots, shared by every person's runtime.
 *
 * Fair by share rather than by turn: a person may hold up to
 * `ceil(capacity / askers)`, askers being everyone holding a slot or waiting
 * for one, and the person asking. With nobody else asking, that is every
 * slot — a lone person is never held below the cap waiting for someone who
 * is not there — and with several, nobody's three items starve another's one.
 * Waiting is each person's listener's own answer, so a queue a new tick
 * emptied stops counting at once.
 */
export function createSlotPool(capacity: number): SlotPool {
  const held = new Map<string, number>();
  const listeners = new Map<string, SlotListener>();
  let turn = 0;

  const total = (): number => [...held.values()].reduce((a, b) => a + b, 0);
  const askers = (asking: string): number => {
    const who = new Set([asking]);
    for (const [person, n] of held) if (n > 0) who.add(person);
    for (const [person, l] of listeners) if (l.waiting()) who.add(person);
    return who.size;
  };

  const order = (personIds: readonly string[]): string[] => {
    const ids = [...new Set(personIds)].sort(compareIds);
    if (ids.length === 0) return [];
    const start = turn % ids.length;
    turn += 1;
    return [...ids.slice(start), ...ids.slice(0, start)];
  };

  const nudge = (): void => {
    for (const person of order([...listeners.keys()])) listeners.get(person)?.drain();
  };

  return {
    capacity,
    nudge,
    take: (personId) => {
      if (total() >= capacity) return false;
      const mine = held.get(personId) ?? 0;
      if (mine >= Math.ceil(capacity / askers(personId))) return false;
      held.set(personId, mine + 1);
      return true;
    },
    release: (personId) => {
      const mine = held.get(personId) ?? 0;
      if (mine <= 0) return;
      if (mine === 1) held.delete(personId);
      else held.set(personId, mine - 1);
      nudge();
    },
    order,
    onFree: (personId, listener) => {
      listeners.set(personId, listener);
      return () => {
        if (listeners.get(personId) === listener) listeners.delete(personId);
      };
    },
  };
}
