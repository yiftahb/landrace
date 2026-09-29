/*
 * OpenAI's `codex exec`, as a landrace integration: the command line per
 * tier, the JSONL events `--json` prints, and the session files a pairing
 * carries on. Written against codex-cli 0.154; everything else is the kit's.
 *
 * A project's hook is `export const codex = new Codex();`, with
 * `agent.adapter: codex`.
 *
 * What codex cannot do is refused rather than run without: its sandbox has the
 * network on or off and no list of hosts, and cannot keep a command from
 * reading a path, so `agent.sandbox.hosts` and `agent.sandbox.deny` must be
 * empty (`deny: []` says so); it has no `max` effort; and it cannot start a
 * session under an id it is given, so a person pairs only by carrying on the
 * agent's own session.
 */
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { BaseExecutor, DEFAULT_DENY, shortPath } from "landrace/kit";
import type { EventReading, HandoffPlan, McpServerConfig, PairingKind, RunPlan, SandboxSettings } from "landrace/kit";
import type { HandoffArg } from "landrace/hooks";

/**
 * The built-in tools codex 0.154 turns on by default, each turned off for the
 * screener, which judges a prompt and needs none of them: the shell, the
 * image viewer, connectors and plugins, the browser and the desktop, image
 * generation, sub-agents, goals, sleeping, tool suggestions, and hooks.
 */
const SCREENER_OFF = [
  "shell_tool", "unified_exec", "view_image", "apps", "plugins", "browser_use", "computer_use",
  "image_generation", "multi_agent", "goals", "sleep_tool", "tool_suggest", "hooks",
];

/**
 * A segment of a `-c` key path: codex splits the path on ".", so a server,
 * variable or header name carrying one would set some other key.
 */
const KEY_SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * `-c <key>=<value>` for each setting of one server, the way codex's own
 * config.toml spells an MCP server. The value is TOML, and JSON writes the
 * strings and lists of strings used here as TOML reads them.
 */
function serverArgs(name: string, server: McpServerConfig, tools: readonly string[] | null): string[] {
  const at = `mcp_servers.${name}`;
  const args: string[] = [];
  const set = (key: string, value: unknown): void => {
    const segments = key.slice(at.length + 1).split(".");
    const bad = [name, ...segments].find((s) => !KEY_SEGMENT.test(s));
    if (bad !== undefined) {
      throw new Error(`refused MCP server "${name}": codex reads ${JSON.stringify(bad)} in "${key}" as more than one key; ` +
        "use letters, digits, '_' and '-' only");
    }
    args.push("-c", `${key}=${JSON.stringify(value)}`);
  };
  if (typeof server.command === "string") set(`${at}.command`, server.command);
  if (server.args?.length) set(`${at}.args`, server.args);
  for (const [key, value] of Object.entries(server.env ?? {})) set(`${at}.env.${key}`, value);
  if (typeof server["url"] === "string") set(`${at}.url`, server["url"]);
  const headers = server["headers"];
  if (headers !== null && typeof headers === "object") {
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) set(`${at}.http_headers.${key}`, value);
  }
  if (tools !== null) set(`${at}.enabled_tools`, tools);
  return args;
}

/**
 * The file codex keeps a session in: `<CODEX_HOME>/sessions/<y>/<m>/<d>/
 * rollout-<time>-<id>.jsonl`. Undefined under none, or under several — which
 * of two to carry on is not this integration's to guess.
 *
 * ponytail: reads codex's own session layout, which is its to change; a
 * `codex resume` that finds no session is where that shows up.
 */
async function rolloutOf(home: string, id: string): Promise<string | undefined> {
  const sessions = join(home, "sessions");
  const found = (await readdir(sessions, { recursive: true }).catch(() => [] as string[]))
    .filter((path) => path.endsWith(`-${id}.jsonl`));
  return found.length === 1 && found[0] !== undefined ? join(sessions, found[0]) : undefined;
}

export class Codex extends BaseExecutor {
  readonly id = "codex";
  /** The levels `model_reasoning_effort` takes in codex 0.154. */
  readonly efforts = ["none", "low", "medium", "high", "xhigh"];
  /** No `take`: codex names every session itself, so none can start under the engine's id. */
  readonly pairings: readonly PairingKind[] = ["continue", "fork"];
  /** Where codex keeps its auth, sessions and config, when not `~/.codex`. */
  readonly envKeys = ["CODEX_HOME"];
  /** The CODEX_HOME sessions are looked up in. The operator's own, but for a test. */
  private readonly home: string;

  constructor({ bin = "codex", home = process.env.CODEX_HOME ?? join(homedir(), ".codex") }: { bin?: string; home?: string } = {}) {
    super(bin);
    this.home = home;
  }

  protected sandboxProblems({ hosts, deny }: SandboxSettings): string[] {
    const problems: string[] = [];
    if (hosts.length) {
      problems.push(
        `agent.sandbox.hosts names ${hosts.join(", ")}, and codex cannot hold a write step to some hosts: ` +
        "its sandbox has the network on or off. Remove hosts: a write step then has no network",
      );
    }
    if (deny.length) {
      const defaulted = deny.join() === DEFAULT_DENY.join() ? " — the list it has when it is not written —" : "";
      problems.push(
        `agent.sandbox.deny names ${deny.join(", ")}${defaulted} and codex cannot keep a write step's commands from reading ` +
        "a path under your home. Write deny: [] to run write steps that can read them",
      );
    }
    return problems;
  }

  /** Where the agent works: the run's own directory, or — for a screener given none — no project at all. */
  private rootOf({ cwd, tier }: RunPlan): string {
    return cwd ?? (tier === "screen" ? tmpdir() : process.cwd());
  }

  /**
   * A project's own `.codex/config.toml` loads beside the run, from where it
   * works up to the repository root — and a step could commit one to its
   * branch: servers of its own, a looser sandbox. Refused, never loaded.
   */
  protected async prepare(plan: RunPlan): Promise<void> {
    const own = join(this.home, "config.toml");
    for (let at = this.rootOf(plan); ; at = dirname(at)) {
      const file = join(at, ".codex", "config.toml");
      if (file !== own && existsSync(file)) {
        throw new Error(`refused to run codex where ${file} would load beside it: a project's own codex settings can add ` +
          "servers or loosen the sandbox, and a step could commit them. Remove it from the branch");
      }
      if (existsSync(join(at, ".git")) || dirname(at) === at) return;
    }
  }

  protected argv(plan: RunPlan): string[] {
    const { tier, model, effort, resume, fork, cwd, servers, allowed } = plan;
    const args = ["exec"];
    if (resume !== undefined) args.push(fork ? "fork" : "resume", resume);
    // The operator's own config.toml holds their servers — landrace's
    // operator server among them — and an execpolicy rule can let a command
    // out of the sandbox: a run loads neither, and has exactly what it is
    // handed below.
    args.push("--json", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules");
    const set = (key: string, value: unknown): void => { args.push("-c", `${key}=${JSON.stringify(value)}`); };
    // Nobody is there to ask: every command runs, or not, by the sandbox alone.
    set("approval_policy", "never");
    set("sandbox_mode", tier === "write" ? "workspace-write" : "read-only");
    if (tier === "write") set("sandbox_workspace_write.network_access", false);
    if (tier === "screen") {
      for (const feature of SCREENER_OFF) set(`features.${feature}`, false);
      set("web_search", "disabled");
    }
    if (model !== undefined) args.push("-m", model);
    if (effort !== undefined) set("model_reasoning_effort", effort);
    for (const [name, server] of Object.entries(servers)) args.push(...serverArgs(name, server, allowed[name] ?? null));
    // The screener, given nowhere to run, runs nowhere of the operator's: the
    // checkout it was started in has a `.codex/config.toml` of agsync's.
    if (tier === "screen" && cwd === undefined) args.push("-C", this.rootOf(plan));
    // The prompt on stdin: argv is world-readable via `ps`.
    args.push("-");
    return args;
  }

  protected readEvent(event: object, cwd: string): EventReading {
    const e = event as { type?: unknown; thread_id?: unknown; item?: Record<string, unknown> | null; error?: { message?: unknown } | null };
    if (e.type === "thread.started") return { session: e.thread_id };
    if (e.type === "turn.completed") return { done: true };
    if (e.type === "turn.failed") return { error: `agent reported an error: ${String(e.error?.message ?? "its turn failed")}` };
    const item = e.item;
    if (typeof e.type !== "string" || !e.type.startsWith("item.") || !item) return {};
    // What a command printed and what a tool returned: the files the agent
    // read and the output of what it ran.
    const quiet = item.type === "command_execution" || item.type === "mcp_tool_call";
    if (e.type !== "item.completed") return { quiet };
    if (item.type === "agent_message" && typeof item.text === "string") {
      return { text: item.text, ...(item.text.trim() ? { activity: [{ kind: "message", text: item.text }] } : {}) };
    }
    if (item.type === "command_execution" && typeof item.command === "string") {
      return { quiet, activity: [{ kind: "tool", text: `shell ${item.command}` }] };
    }
    if (item.type === "file_change" && Array.isArray(item.changes)) {
      const paths = (item.changes as Array<{ path?: unknown } | null>).flatMap((c) => (typeof c?.path === "string" ? [shortPath(c.path, cwd)] : []));
      return { activity: [{ kind: "tool", text: `edit ${paths.join(", ")}` }] };
    }
    if (item.type === "mcp_tool_call") {
      return { quiet, activity: [{ kind: "tool", text: `mcp ${String(item.server)}.${String(item.tool)}` }] };
    }
    return { quiet };
  }

  /*
   * The interactive `codex resume` a person runs for a pairing, in the
   * pairing's checkout: the agent's own session on the stage, copied under
   * the engine's id — codex names every session it starts itself, so this is
   * the only way one comes to answer to the engine's — and seeded with the
   * step, read by the person's shell. Their own config loads as it always
   * does, beside the engine's server, their way back to Landrace. Run a
   * second time, the command resumes the copy it made.
   */
  protected async handoffArgv({ session, promptFile, resume, server }: HandoffPlan): Promise<HandoffArg[]> {
    const argv: HandoffArg[] = [this.bin, "resume"];
    if (server) argv.push(...serverArgs(server.name, { command: server.command, args: server.args }, server.tools.length ? server.tools : null));
    if (await rolloutOf(this.home, session)) return [...argv, session];

    const agent = resume === undefined ? undefined : await rolloutOf(this.home, resume);
    if (resume === undefined || agent === undefined) {
      throw new Error(
        `cannot continue the agent's session ${resume ?? ""}: it is not in ${join(this.home, "sessions")}, and codex cannot ` +
        "start a session under the id Landrace gives it. Release the pairing, and let the agent run the step",
      );
    }
    const copy = join(dirname(agent), basename(agent).replace(resume, session));
    await writeFile(copy, (await readFile(agent, "utf8")).replaceAll(resume, session), { flag: "wx", mode: 0o600 });
    return [...argv, session, { file: promptFile }];
  }
}
