import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { dirname, join } from "node:path";
import { Command } from "commander";
import type { BoardInstance, BoardLiveness, InstanceRead, PortIo } from "#namespace.js";
import { messageOf } from "#runner/errors.js";
import { alive } from "#runner/lock.js";
import { sandboxRoot } from "#sandbox.js";

const HOST = "127.0.0.1";

/** Long enough for a board busy building its view; short enough that a pane polling this never waits on a wedged one. */
const ASK_TIMEOUT_MS = 2_000;

/**
 * `$TMPDIR/landrace/<repo>/boards/<digest>.json`, the digest of the
 * workspace's real path: one repository can hold two workspaces, each with
 * its own `start` and its own port, and a record keyed by the repository
 * would name one of them. Never inside the working tree, so nothing has to
 * be gitignored. Throws when the folder does not exist.
 */
export function instancePath(dir: string): string {
  const real = realpathSync(dir);
  const key = createHash("sha256").update(real).digest("hex").slice(0, 12);
  return join(sandboxRoot(real), "boards", `${key}.json`);
}

/** Written to a sibling and renamed, so a `port` reading mid-write never meets half a record. */
export async function writeInstance(dir: string, instance: BoardInstance): Promise<void> {
  const path = instancePath(dir);
  await mkdir(dirname(path), { recursive: true });
  const part = `${path}.${process.pid}.part`;
  await writeFile(part, `${JSON.stringify(instance)}\n`);
  await rename(part, path);
}

const isInstance = (v: unknown): v is BoardInstance => {
  const r = v as Partial<BoardInstance> | null;
  return typeof r === "object" && r !== null && Number.isInteger(r.pid) && Number.isInteger(r.port)
    && typeof r.workspace === "string" && typeof r.startedAt === "string";
};

export async function readInstance(dir: string): Promise<InstanceRead> {
  const path = instancePath(dir);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { missing: true };
    return { unreadable: messageOf(e) };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isInstance(parsed) ? { instance: parsed } : { unreadable: "it is not a pid, a port, a workspace and a start time" };
  } catch (e) {
    return { unreadable: messageOf(e) };
  }
}

/**
 * The record, removed only when `pid` wrote it: a start that found a stale
 * record and overwrote it owns it now, and the one that left it must not
 * take it from under the live one.
 */
export async function removeInstance(dir: string, pid: number): Promise<void> {
  const read = await readInstance(dir);
  if (!("instance" in read) || read.instance.pid !== pid) return;
  await unlink(instancePath(dir)).catch((e: unknown) => {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  });
}

/** `GET /board.json` on loopback, with the Host header the board answers: its status and body, or why nothing answered. */
function askBoard(port: number): Promise<{ status: number; body: string } | { error: string }> {
  return new Promise((done) => {
    const req = request(
      { host: HOST, port, path: "/board.json", method: "GET", headers: { host: `${HOST}:${port}` }, timeout: ASK_TIMEOUT_MS },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => done({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", (e) => done({ error: messageOf(e) }));
      },
    );
    req.on("timeout", () => req.destroy(new Error(`no answer within ${ASK_TIMEOUT_MS / 1000}s`)));
    req.on("error", (e) => done({ error: messageOf(e) }));
    req.end();
  });
}

/**
 * Whether the workspace in `dir` has a live board, decided by asking it and
 * never by trusting the record: a crash leaves the record behind, and the
 * OS can hand its port to another project's board. Each way of being
 * offline is said in its own words, because "offline" alone sends a person
 * to check all four.
 */
export async function boardLiveness(dir: string): Promise<BoardLiveness> {
  let read: InstanceRead;
  try {
    read = await readInstance(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { offline: `there is no workspace at ${dir}` };
    throw e;
  }
  if ("missing" in read) return { offline: `no record for the workspace in ${dir}: no landrace start serves its board` };
  if ("unreadable" in read) return { offline: `the record at ${instancePath(dir)} cannot be read: ${read.unreadable}` };
  const { instance } = read;
  if (!alive(instance.pid)) {
    return { offline: `the recorded pid ${instance.pid} is gone, so the start that served port ${instance.port} has stopped` };
  }
  const answer = await askBoard(instance.port);
  if ("error" in answer) return { offline: `port ${instance.port} does not answer: ${answer.error}` };
  let published: unknown;
  try {
    published = answer.status === 200 ? (JSON.parse(answer.body) as { workspace?: unknown }).workspace : undefined;
  } catch {
    published = undefined;
  }
  if (typeof published !== "string") {
    return { offline: `port ${instance.port} answers, but not with a board: HTTP ${answer.status}` };
  }
  if (published !== instance.workspace) return { offline: `port ${instance.port} answers for another workspace, ${published}` };
  return { live: `http://${HOST}:${instance.port}`, instance };
}

const consoleIo: PortIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  exit: (code) => {
    process.exitCode = code;
  },
};

/**
 * `landrace port`: stdout is the URL alone, or `offline`, so a script or an
 * editor pane can read it without parsing; why it is offline goes to stderr.
 */
export function portCommand(io: PortIo = consoleIo): Command {
  return new Command("port")
    .description("print the URL of the board this workspace's landrace start serves, or say it is offline and why")
    .option("-w, --workspace <dir>", "workspace directory", ".landrace")
    .action(async (opts: { workspace: string }) => {
      let found: BoardLiveness;
      try {
        found = await boardLiveness(opts.workspace);
      } catch (e) {
        found = { offline: messageOf(e) };
      }
      if ("live" in found) {
        io.out(found.live);
        return;
      }
      io.out("offline");
      io.err(`landrace port: ${found.offline}`);
      io.exit(1);
    });
}
