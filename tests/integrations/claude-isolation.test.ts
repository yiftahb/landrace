import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Claude, claudeProjectDirOf } from "landrace/integrations/claude";
import { CREDENTIALS_ROOT } from "#conventions.js";
import { denyForPerson } from "#people/isolation.js";

/*
 * #186: on one instance, a person's step may not read another person's
 * worktrees, nor the transcripts Claude Code keeps of the runs in them. The
 * engine lists the worktrees; the integration finds the transcripts.
 */
const bin = join(__dirname, "..", "agent", "fake-agent.mjs");
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const temp = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};

/** A fake HOME holding a session for a run in each of alice's, bob's and bobby's worktrees. */
function instance() {
  const home = temp("fake-home-");
  const worktrees = join(temp("sandbox-"), "worktrees");
  const project = (cwd: string): string => {
    const dir = claudeProjectDirOf(cwd, home);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const projects = {
    alice: project(join(worktrees, "alice", "1.write")),
    bob: project(join(worktrees, "bob", "2.write")),
    bobby: project(join(worktrees, "bobby", "3.write")),
  };
  const denyPaths = () => Promise.resolve(denyForPerson({ id: "alice" }, [{ id: "bob" }], { worktrees, credentials: CREDENTIALS_ROOT }));
  const cwd = temp("fake-agent-");
  writeFileSync(join(cwd, "fake.json"), JSON.stringify({ out: "{{ARGV_JSON}}" }));
  const executor = new Claude({ bin, home }).build({
    servers: {}, tools: {}, plugins: [], sandbox: { hosts: [], deny: ["~/.ssh", CREDENTIALS_ROOT] }, denyPaths,
  });
  const settingsOf = async (capabilities: string[]) => {
    const r = await executor.run("p", { round: 1, cwd, capabilities, signal: new AbortController().signal });
    const argv = JSON.parse(r.text) as string[];
    return JSON.parse(argv[argv.indexOf("--settings") + 1] as string) as {
      permissions: { deny: string[] }; sandbox?: { filesystem: { denyRead: string[] } };
    };
  };
  return { home, worktrees, projects, project, settingsOf };
}

describe("a person whose id no rule can hold", () => {
  // encodeURIComponent leaves "(" and ")" as they are, and either ends a Read rule early.
  it("refuses another person's step, naming the path, rather than leave their work readable", async () => {
    const worktrees = join(temp("sandbox-"), "worktrees");
    const cwd = temp("fake-agent-");
    writeFileSync(join(cwd, "fake.json"), JSON.stringify({ out: "{{ARGV_JSON}}" }));
    const executor = new Claude({ bin, home: temp("fake-home-") }).build({
      servers: {}, tools: {}, plugins: [], sandbox: { hosts: [], deny: [] },
      denyPaths: () => Promise.resolve(denyForPerson({ id: "alice" }, [{ id: "b)ob" }], { worktrees, credentials: CREDENTIALS_ROOT })),
    });
    await expect(executor.run("p", { round: 1, cwd, capabilities: ["repo:read"], signal: new AbortController().signal }))
      .rejects.toThrow(`refused the run: ${JSON.stringify(join(worktrees, "b)ob"))}`);
  });
});

describe("claudeProjectDirOf", () => {
  it("is where the CLI keeps a directory's sessions: every character but a letter or digit made -", () => {
    expect(claudeProjectDirOf("/w/bob@x/2.write", "/h")).toBe("/h/.claude/projects/-w-bob-x-2-write");
  });
});

describe("a person's step on an instance with others", () => {
  it("is denied, on the read tier, bob's worktrees and his runs' transcripts, and nothing of alice's or bobby's", async () => {
    const { worktrees, projects, settingsOf } = instance();
    const { permissions } = await settingsOf(["repo:read"]);
    expect(permissions.deny).toEqual(expect.arrayContaining([
      `Read(${CREDENTIALS_ROOT}/**)`, `Read(/${join(worktrees, "bob")}/**)`, `Read(/${projects.bob}/**)`,
    ]));
    expect(permissions.deny).toContain(`Read(//${join(worktrees, "bob").slice(1)}/**)`);
    const named = permissions.deny.join("\n");
    expect(named).not.toContain(join(worktrees, "alice"));
    expect(named).not.toContain(projects.alice);
    expect(named).not.toContain(projects.bobby);
    expect(named).not.toContain(join(worktrees, "bobby"));
  });

  it("is denied both, on the write tier, by the sandbox as well as the Read rules", async () => {
    const { worktrees, projects, settingsOf } = instance();
    const { sandbox, permissions } = await settingsOf(["repo:read", "repo:write"]);
    expect(sandbox?.filesystem.denyRead).toEqual(expect.arrayContaining([join(worktrees, "bob"), projects.bob, CREDENTIALS_ROOT]));
    expect(sandbox?.filesystem.denyRead).not.toContain(projects.alice);
    expect(sandbox?.filesystem.denyRead).not.toContain(projects.bobby);
    expect(permissions.deny).toContain(`Read(/${projects.bob}/**)`);
  });

  it("is denied a run of bob's that began after alice's executor was built, on her next step", async () => {
    const { worktrees, project, settingsOf } = instance();
    const later = join(worktrees, "bob", "9.write");
    expect((await settingsOf(["repo:read"])).permissions.deny.join("\n")).not.toContain(claudeProjectDirOf(later, "/x").split("/").pop());
    const made = project(later);
    expect((await settingsOf(["repo:read"])).permissions.deny).toContain(`Read(/${made}/**)`);
  });
});
