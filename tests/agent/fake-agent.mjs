#!/usr/bin/env node
// Stands in for `claude`, emitting the same json envelope under
// --output-format json.
//
// Scripted via a `fake.json` file in the child's cwd rather than environment
// variables: the executor under test builds an explicit, minimal env for the
// real agent (so a credential sitting in the parent's env cannot reach it),
// which means this double cannot read ambient FAKE_* vars either — the cwd
// is the one channel the executor is supposed to pass through on purpose.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

const cfgPath = join(process.cwd(), "fake.json");
const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : {};

if (cfg.exit) {
  process.stderr.write(cfg.stderr ?? "boom");
  process.exit(cfg.exit);
}

if (cfg.grandchild) {
  // Stands in for the bash/MCP-server subprocesses a real `claude` spawns:
  // if the executor only signals this direct child, this one survives it.
  const gc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writeFileSync(join(process.cwd(), "grandchild.pid"), String(gc.pid));
}

if (cfg.flood) {
  // A runaway agent that never stops talking. Bounded by floodMax so a test
  // whose fix is broken fails fast (jest's own test timeout) rather than
  // exhausting memory chasing a crash that isn't the point of the test.
  const chunk = "x".repeat(cfg.flood);
  let sent = 0;
  const max = cfg.floodMax ?? 64;
  const id = setInterval(() => {
    if (sent++ >= max) return clearInterval(id);
    process.stdout.write(chunk);
  }, 1);
} else if (cfg.hang || cfg.grandchild) {
  // Deliberately never reads stdin. A prompt larger than the OS pipe buffer
  // then sits blocked on backpressure in the parent — exactly the state a
  // real hung agent leaves a write in when it is killed mid-write, which is
  // what turns into EPIPE on the parent's `child.stdin` if nothing is
  // listening for it there.
  setTimeout(() => {}, 60_000);
} else {
  let stdin = "";
  for await (const chunk of process.stdin) stdin += chunk;

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
        // `cfg.sid` is passed through verbatim, including a non-string, on
        // purpose: it is what lets a test prove the executor validates the
        // field's type rather than trusting it.
        session_id: "sid" in cfg ? cfg.sid : "sid-1",
        result: filled,
      }),
  );
}
