/**
 * A hook module the way a hook author writes one, for the loader's own tests:
 * branded values it must pick up, and plain ones it must walk past.
 */
import { definePreHook, defineSource } from "../../../src/hooks/index.js";

export const NAME = "alpha";

export const helper = (n: number): number => n + 1;

export const observe = definePreHook({
  id: "alpha",
  provides: ["ticket.title"],
  run: () => ({ ticket: { title: "from alpha" } }),
});

export const tickets = defineSource({
  id: "alpha",
  list: async () => [{ ticket: 1, title: "one", url: "u/1", labels: ["lr:auto"] }],
});
