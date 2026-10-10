import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { instancePath, portCommand, readInstance, removeInstance, writeInstance } from "#cli/port.js";
import type { BoardInstance, BoardView, UiServer } from "#namespace.js";
import { sandboxRoot } from "#sandbox.js";
import { serveBoard } from "#ui/server.js";
import { describeLoopback } from "#tests/support/loopback.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) {
    await rm(dirname(instancePath(dir)), { recursive: true, force: true }).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

async function workspace(): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), "lr-port-")), ".landrace");
  await mkdir(dir);
  dirs.push(dir);
  return dir;
}

const record = (over: Partial<BoardInstance> = {}): BoardInstance => ({
  pid: process.pid, port: 4545, workspace: "/repos/widgets", startedAt: "2026-10-10T00:00:00.000Z", ...over,
});

/** `landrace port`, parsed from its own command line as the CLI parses it. */
async function port(...argv: string[]): Promise<{ out: string[]; err: string[]; code: number }> {
  const out: string[] = [];
  const err: string[] = [];
  let code = 0;
  await portCommand({ out: (l) => out.push(l), err: (l) => err.push(l), exit: (c) => { code = c; } })
    .parseAsync(argv, { from: "user" });
  return { out, err, code };
}

/** A pid that was a process a moment ago and is not one now. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((r) => child.once("exit", r));
  if (child.pid === undefined) throw new Error("no pid");
  return child.pid;
}

describe("the instance record", () => {
  it("lives under the tmp sandbox root, never inside the workspace", async () => {
    const dir = await workspace();
    expect(instancePath(dir).startsWith(`${sandboxRoot(dir)}/`)).toBe(true);
    expect(instancePath(dir).startsWith(await realpath(dirname(dir)))).toBe(false);
  });

  it("is keyed by the workspace, so two workspaces of one repository never share one", async () => {
    const root = await mkdtemp(join(tmpdir(), "lr-port-two-"));
    const [a, b] = [join(root, "a", ".landrace"), join(root, "b", ".landrace")];
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    dirs.push(a, b);
    expect(instancePath(a)).not.toBe(instancePath(b));
    // A symlink to a workspace is the same workspace.
    await symlink(join(root, "a"), join(root, "link"));
    expect(instancePath(join(root, "link", ".landrace"))).toBe(instancePath(a));
  });

  it("is written whole and read back", async () => {
    const dir = await workspace();
    await writeInstance(dir, record());
    expect(await readInstance(dir)).toEqual({ instance: record() });
  });

  it("is removed only by the process that wrote it", async () => {
    const dir = await workspace();
    await writeInstance(dir, record({ pid: 1 }));
    await removeInstance(dir, process.pid);
    expect(await readInstance(dir)).toEqual({ instance: record({ pid: 1 }) });
    await removeInstance(dir, 1);
    expect(await readInstance(dir)).toEqual({ missing: true });
    // Nothing to remove is no failure.
    await removeInstance(dir, 1);
  });
});

describe("landrace port, offline", () => {
  it("says no record for a workspace no start serves", async () => {
    const dir = await workspace();
    const { out, err, code } = await port("-w", dir);
    expect([out, code]).toEqual([["offline"], 1]);
    expect(err).toEqual([`landrace port: no record for the workspace in ${dir}: no landrace start serves its board`]);
  });

  it("says so for a workspace folder that does not exist", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "lr-port-none-")), ".landrace");
    const { out, err, code } = await port("-w", dir);
    expect([out, code]).toEqual([["offline"], 1]);
    expect(err).toEqual([`landrace port: there is no workspace at ${dir}`]);
  });

  it("says the recorded pid is gone, for a record a crash left behind", async () => {
    const dir = await workspace();
    const pid = await deadPid();
    await writeInstance(dir, record({ pid }));
    const { out, err, code } = await port("-w", dir);
    expect([out, code]).toEqual([["offline"], 1]);
    expect(err).toEqual([`landrace port: the recorded pid ${pid} is gone, so the start that served port 4545 has stopped`]);
  });

  it("says the port does not answer, when the pid lives but nothing serves the port", async () => {
    const dir = await workspace();
    // Port 1 is never a board; the pid is this live process.
    await writeInstance(dir, record({ port: 1 }));
    const { out, err, code } = await port("-w", dir);
    expect([out, code]).toEqual([["offline"], 1]);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^landrace port: port 1 does not answer: /);
  });

  it("says a record it cannot read is unreadable, naming it", async () => {
    const dir = await workspace();
    await mkdir(dirname(instancePath(dir)), { recursive: true });
    await writeFile(instancePath(dir), "{ half a rec");
    const { out, err, code } = await port("-w", dir);
    expect([out, code]).toEqual([["offline"], 1]);
    expect(err).toEqual([expect.stringContaining(`landrace port: the record at ${instancePath(dir)} cannot be read: `)]);
  });

  it("defaults the workspace to .landrace in the current folder", () => {
    expect(portCommand().helpInformation()).toMatch(/-w, --workspace <dir>\s+workspace directory \(default: "\.landrace"\)/);
  });
});

// Starts a real server on 127.0.0.1: skipped only where a sandbox forbids that.
describeLoopback("landrace port, asking the board", () => {
  const servers: UiServer[] = [];
  afterAll(async () => {
    for (const s of servers) await s.close();
  });
  const board = async (view: () => Promise<BoardView>): Promise<UiServer> => {
    const ui = await serveBoard({ port: 0, view });
    servers.push(ui);
    return ui;
  };

  it("prints the board's URL alone, and exits 0, when the board answers for this workspace", async () => {
    const dir = await workspace();
    const ui = await board(async () => ({ workspace: "/repos/widgets" }) as BoardView);
    await writeInstance(dir, record({ port: ui.port }));
    expect(await port("-w", dir)).toEqual({ out: [`http://127.0.0.1:${ui.port}`], err: [], code: 0 });
  });

  it("says the port answers for another workspace, naming it", async () => {
    const dir = await workspace();
    const ui = await board(async () => ({ workspace: "/repos/gadgets" }) as BoardView);
    await writeInstance(dir, record({ port: ui.port }));
    expect(await port("-w", dir)).toEqual({
      out: ["offline"], code: 1,
      err: [`landrace port: port ${ui.port} answers for another workspace, /repos/gadgets`],
    });
  });

  it("says the port answers, but not with a board, when /board.json fails", async () => {
    const dir = await workspace();
    const ui = await board(() => Promise.reject(new Error("no")));
    await writeInstance(dir, record({ port: ui.port }));
    expect(await port("-w", dir)).toEqual({
      out: ["offline"], code: 1, err: [`landrace port: port ${ui.port} answers, but not with a board: HTTP 500`],
    });
  });
});
