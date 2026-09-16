import { definePostHook } from "../../../src/hooks/index.js";

export const act = definePostHook({
  id: "beta",
  handles: ["beta.write"],
  satisfied: () => false,
  apply: async () => {},
});
