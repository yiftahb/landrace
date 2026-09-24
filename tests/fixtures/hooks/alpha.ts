/**
 * A hook module the way a hook author writes one, for the loader's own tests:
 * branded values it must pick up, and plain ones it must walk past.
 */
import { definePreHook, defineSource } from "#hooks/index.js";

export const NAME = "alpha";

export const helper = (n: number): number => n + 1;

export const observe = definePreHook({
  id: "alpha",
  provides: ["ticket.title"],
  run: () => ({ ticket: { title: "from alpha" } }),
});

const one = {
  nodes: [{
    id: "1", kind: "ticket", title: "one", link: "u/1", closed: null, priority: null, origin: null,
    state: { labels: ["lr:auto"], assignees: [] },
  }],
  relationships: [],
};

export const tickets = defineSource({
  id: "alpha",
  relations: [],
  list: async () => one,
  read: async () => one,
});
