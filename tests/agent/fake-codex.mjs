#!/usr/bin/env node
// Stands in for `codex exec --json`, emitting the JSONL events it prints: the
// thread, the turn, whatever items a test scripts, then the agent's message
// and the turn's end.
//
// Scripted by a `fake.json` in its working root — the `-C` directory when it
// is given one, as the real CLI works there, else its cwd — never by
// environment variables, which the executor under test does not pass on.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const root = argv.includes("-C") ? argv[argv.indexOf("-C") + 1] : process.cwd();
const cfgPath = join(root, "fake.json");
const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : {};

// Proof it ran at all, for a test asserting it never did.
if (cfg.mark) writeFileSync(join(root, "spawned"), "");

if (cfg.hang) {
  setTimeout(() => {}, 60_000);
} else {
  let stdin = "";
  for await (const chunk of process.stdin) stdin += chunk;
  // Unscripted, it answers with its own command line.
  const filled = (cfg.out ?? "{{ARGV_JSON}}")
    .replaceAll("{{LEN}}", String(stdin.length))
    .replaceAll("{{ARGV_JSON}}", JSON.stringify(argv))
    .replace(/\{\{ENV:([A-Za-z0-9_]+)\}\}/g, (_, name) => process.env[name] ?? "");
  const line = (event) => process.stdout.write(`${JSON.stringify(event).replaceAll("{{CWD}}", root)}\n`);

  line({ type: "thread.started", thread_id: cfg.thread ?? "0199a213-81c0-7800-8aa1-bbab2a035a53" });
  line({ type: "turn.started" });
  for (const event of cfg.events ?? []) line(event);
  if (cfg.fail) {
    line({ type: "turn.failed", error: { message: cfg.fail } });
    process.exit(1);
  }
  line({ type: "item.completed", item: { id: "item_9", type: "agent_message", text: filled } });
  line({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } });
}
