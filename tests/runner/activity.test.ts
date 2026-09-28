import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActivityLog } from "#runner/activity.js";

const roots: string[] = [];
const rootDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "activity-"));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  while (roots.length) {
    const dir = roots.pop() as string;
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

const SECRET = "ghp_supersecretvalue123";
const redact = (text: string): string => text.split(SECRET).join("[redacted]");
const tool = (text: string, at = 1) => ({ kind: "tool" as const, text, at });

/** Every byte the log wrote under its root, for a claim about what is on disk. */
const onDisk = (root: string): string =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => readFileSync(join(d.parentPath, d.name), "utf8"))
    .join("");

describe("the activity log", () => {
  it("reads back what a run recorded, in order, from the line asked for", async () => {
    const log = createActivityLog(rootDir(), redact);
    log.record("25", "build", 1, tool("Read a.ts", 1));
    log.record("25", "build", 1, { kind: "message", text: "Looking at a.ts", at: 2 });
    log.record("25", "build", 1, tool("Bash pnpm test", 3));

    expect(await log.read("25", 0)).toEqual({
      stage: "build", round: 1, total: 3,
      lines: [tool("Read a.ts", 1), { kind: "message", text: "Looking at a.ts", at: 2 }, tool("Bash pnpm test", 3)],
    });
    expect((await log.read("25", 2)).lines).toEqual([tool("Bash pnpm test", 3)]);
  });

  it("answers the stage it recorded last, not every stage at once", async () => {
    const log = createActivityLog(rootDir(), redact);
    log.record("25", "spec", 1, tool("Read spec.md", 1));
    await new Promise((r) => setTimeout(r, 20));
    log.record("25", "build", 2, tool("Edit a.ts", 2));
    expect(await log.read("25", 0)).toMatchObject({ stage: "build", round: 2, total: 1 });
  });

  it("reads nothing for a ticket that has recorded nothing", async () => {
    expect(await createActivityLog(rootDir(), redact).read("99", 0)).toEqual({ stage: null, round: null, lines: [], total: 0 });
  });

  it("keeps a finished round's lines until that stage's next round, which replaces them", async () => {
    const root = rootDir();
    createActivityLog(root, redact).record("25", "build", 1, tool("Read old.ts"));
    // Another process — `landrace mcp` — sees what the loop wrote.
    const other = createActivityLog(root, redact);
    expect((await other.read("25", 0)).lines).toEqual([tool("Read old.ts")]);

    other.record("25", "build", 2, tool("Read new.ts"));
    expect(await other.read("25", 0)).toMatchObject({ round: 2, total: 1, lines: [tool("Read new.ts")] });
  });

  it("notices another process's write between two of its own", async () => {
    const root = rootDir();
    const loop = createActivityLog(root, redact);
    loop.record("25", "build", 1, tool("Read a.ts"));
    loop.record("25", "build", 1, tool("Read b.ts"));
    createActivityLog(root, redact).record("25", "build", 2, tool("Read new.ts"));
    loop.record("25", "build", 1, tool("Read stale.ts"));
    expect(await loop.read("25", 0)).toMatchObject({ round: 2, lines: [tool("Read new.ts")] });
  });

  it("never lets an older round overwrite a newer one", async () => {
    const log = createActivityLog(rootDir(), redact);
    log.record("25", "build", 2, tool("Read new.ts"));
    log.record("25", "build", 1, tool("Read stale.ts"));
    expect(await log.read("25", 0)).toMatchObject({ round: 2, lines: [tool("Read new.ts")] });
  });

  it("cuts a line to 240 characters and keeps at most 500 lines a round", async () => {
    const log = createActivityLog(rootDir(), redact);
    log.record("25", "build", 1, { kind: "message", text: "x".repeat(1000), at: 1 });
    for (let i = 1; i < 600; i++) log.record("25", "build", 1, tool(`Read ${i}`));
    const page = await log.read("25", 0);
    expect(page.lines[0]?.text).toHaveLength(240);
    expect(page.total).toBe(500);
  });

  it("never writes a secret to disk, even one the 240-character cut would have split", async () => {
    const root = rootDir();
    const log = createActivityLog(root, redact);
    log.record("25", "build", 1, tool(`Bash curl -H "Authorization: ${SECRET}"`));
    log.record("25", "build", 1, tool(`${"y".repeat(230)}${SECRET}`));
    expect(onDisk(root)).not.toContain(SECRET);
    expect(onDisk(root)).not.toContain(SECRET.slice(0, 10));
    expect((await log.read("25", 0)).lines[0]?.text).toContain("[redacted]");
  });

  it("puts one line on one line, whatever the agent's text held", async () => {
    const log = createActivityLog(rootDir(), redact);
    log.record("25", "build", 1, { kind: "message", text: "first\nsecond\r\n\tthird", at: 1 });
    expect((await log.read("25", 0)).lines[0]?.text).toBe("first second third");
  });

  it("never throws, not even when it cannot write", async () => {
    const root = rootDir();
    chmodSync(root, 0o500);
    const said = jest.spyOn(console, "error").mockImplementation(() => {});
    const log = createActivityLog(root, redact);
    expect(() => log.record("25", "build", 1, tool("Read a.ts"))).not.toThrow();
    said.mockRestore();
  });

  it("skips a line it cannot parse rather than failing the whole read", async () => {
    const root = rootDir();
    const log = createActivityLog(root, redact);
    log.record("25", "build", 1, tool("Read a.ts", 1));
    const file = join(root, "activity", "25", "build.jsonl");
    writeFileSync(file, `${readFileSync(file, "utf8")}{not json\n`);
    expect((await log.read("25", 0)).lines).toEqual([tool("Read a.ts", 1)]);
  });

  it("keeps a stage name that is not a safe file name inside its own directory", async () => {
    const root = rootDir();
    const log = createActivityLog(root, redact);
    log.record("25", "../../escape", 1, tool("Read a.ts"));
    expect(readdirSync(root)).toEqual(["activity"]);
    expect(await log.read("25", 0)).toMatchObject({ stage: "../../escape", total: 1 });
  });
});
