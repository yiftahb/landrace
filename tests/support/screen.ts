import { markOf } from "#agent/screen.js";

/** What an honest screener answers for the screening it was handed: its verdict, with that screening's nonce. */
export const verdictFor = (prompt: string, verdict: "ok" | "suspicious", reason = "fine"): string =>
  `\`\`\`json\n{"verdict":"${verdict}","nonce":"${markOf(prompt) ?? ""}","reason":"${reason}"}\n\`\`\``;
