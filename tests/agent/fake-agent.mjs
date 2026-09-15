#!/usr/bin/env node
// Stands in for `claude`, emitting the same json envelope under
// --output-format json.
//
// Scripted via a `fake.json` file in the child's cwd rather than environment
// variables: the executor under test builds an explicit, minimal env for the
// real agent (so a credential sitting in the parent's env cannot reach it),
// which means this double cannot read ambient FAKE_* vars either — the cwd
// is the one channel the executor is supposed to pass through on purpose.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

let stdin = "";
for await (const chunk of process.stdin) stdin += chunk;

const cfgPath = join(process.cwd(), "fake.json");
const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : {};

if (cfg.exit) {
  process.stderr.write(cfg.stderr ?? "boom");
  process.exit(cfg.exit);
}
if (cfg.hang) {
  setTimeout(() => {}, 60_000);
} else {
  const template = cfg.out ?? "";
  const filled = template
    .replaceAll("{{LEN}}", String(stdin.length))
    .replaceAll("{{ARGV}}", process.argv.slice(2).join(" "))
    // Lets a test prove a value from the parent's environment did NOT reach
    // this child, by asking the child itself to echo it back.
    .replace(/\{\{ENV:([A-Za-z0-9_]+)\}\}/g, (_, name) => process.env[name] ?? "");
  process.stdout.write(
    cfg.raw ??
      JSON.stringify({
        type: "result",
        is_error: cfg.isError ?? false,
        session_id: cfg.sid ?? "sid-1",
        result: filled,
      }),
  );
}
