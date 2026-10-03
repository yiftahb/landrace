import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  isNewer, latestVersion, ownVersion, runUpdate, runVersion, updateCheckOff, updateCommand, updateNotice,
} from "#cli/version.js";

const exec = promisify(execFile);
const CLI = join(process.cwd(), "src/cli/index.ts");
const fresh = (): Promise<string> => mkdtemp(join(tmpdir(), "landrace-version-"));

describe("isNewer", () => {
  it.each([
    ["1.1.0", "1.0.0", true],
    ["2.0.0", "1.9.9", true],
    // Numbers, not strings: "1.10.0" sorts before "1.9.0" as text.
    ["1.10.0", "1.9.0", true],
    ["1.0.0", "1.0.0-rc.1", true],
    ["1.0.0", "1.0.0", false],
    // A build ahead of npm, as in a clone, is not behind.
    ["1.0.0", "1.1.0", false],
    ["1.0.0-rc.2", "1.0.0", false],
    ["not-a-version", "1.0.0", false],
    ["1.0.0", "", false],
  ])("%s over %s is %s", (latest, current, expected) => {
    expect(isNewer(latest, current)).toBe(expected);
  });
});

describe("updateCheckOff", () => {
  it.each([
    [{ LANDRACE_NO_UPDATE_CHECK: "1" }, true],
    [{ LANDRACE_NO_UPDATE_CHECK: "true" }, true],
    [{ LANDRACE_NO_UPDATE_CHECK: "0" }, false],
    [{ LANDRACE_NO_UPDATE_CHECK: "" }, false],
    [{ CI: "true" }, true],
    [{}, false],
  ])("%j is %s", (env, expected) => {
    expect(updateCheckOff(env)).toBe(expected);
  });
});

describe("latestVersion", () => {
  const answering = (status: number, body: unknown) =>
    jest.fn(async () => new Response(JSON.stringify(body), { status }));

  it("reads the version npm calls latest", async () => {
    const fetchImpl = answering(200, { name: "landrace", version: "1.2.0" });
    await expect(latestVersion(fetchImpl)).resolves.toBe("1.2.0");
    expect(fetchImpl).toHaveBeenCalledWith("https://registry.npmjs.org/landrace/latest", expect.anything());
  });

  it("answers null for a refusal, a throw, or a version that is not one", async () => {
    await expect(latestVersion(answering(404, { error: "Not found" }))).resolves.toBeNull();
    await expect(latestVersion(jest.fn(async () => { throw new Error("offline"); }))).resolves.toBeNull();
    await expect(latestVersion(answering(200, { version: "1.2.0; rm -rf /" }))).resolves.toBeNull();
    await expect(latestVersion(answering(200, ["1.2.0"]))).resolves.toBeNull();
  });

  it("gives up after its timeout instead of holding the command", async () => {
    const hanging = jest.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const started = Date.now();
    await expect(latestVersion(hanging, 50)).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("updateNotice", () => {
  it("says what is newer and how to get it", async () => {
    const line = await updateNotice({}, "1.0.0", async () => "1.1.0");
    expect(line).toContain("1.1.0");
    expect(line).toContain("1.0.0");
    expect(line).toContain("landrace update");
  });

  it("says nothing when this is the latest, ahead of it, or npm did not answer", async () => {
    await expect(updateNotice({}, "1.1.0", async () => "1.1.0")).resolves.toBeNull();
    await expect(updateNotice({}, "1.2.0", async () => "1.1.0")).resolves.toBeNull();
    await expect(updateNotice({}, "1.0.0", async () => null)).resolves.toBeNull();
  });

  it("asks npm nothing when the check is off", async () => {
    const latest = jest.fn(async () => "9.9.9");
    await expect(updateNotice({ LANDRACE_NO_UPDATE_CHECK: "1" }, "1.0.0", latest)).resolves.toBeNull();
    expect(latest).not.toHaveBeenCalled();
  });
});

describe("updateCommand", () => {
  async function project(files: Record<string, string>): Promise<string> {
    const dir = await fresh();
    for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
    return dir;
  }
  const dev = JSON.stringify({ devDependencies: { landrace: "^1.0.0" } });

  it("updates the project's own dependency with the project's package manager", async () => {
    const pnpm = await project({ "package.json": dev, "pnpm-lock.yaml": "" });
    expect(updateCommand(pnpm)).toEqual({ command: "pnpm", args: ["add", "-D", "landrace@latest"], where: "project", cwd: pnpm });
    const yarn = await project({ "package.json": dev, "yarn.lock": "" });
    expect(updateCommand(yarn)).toEqual({ command: "yarn", args: ["add", "-D", "landrace@latest"], where: "project", cwd: yarn });
    const npm = await project({ "package.json": dev, "package-lock.json": "{}" });
    expect(updateCommand(npm)).toEqual({ command: "npm", args: ["install", "--save-dev", "landrace@latest"], where: "project", cwd: npm });
  });

  it("keeps a runtime dependency a runtime one", async () => {
    const dir = await project({ "package.json": JSON.stringify({ dependencies: { landrace: "^1.0.0" } }), "pnpm-lock.yaml": "" });
    expect(updateCommand(dir).args).toEqual(["add", "landrace@latest"]);
  });

  it("updates the global install where the folder's package.json does not list landrace", async () => {
    const none = await fresh();
    expect(updateCommand(none)).toEqual({ command: "npm", args: ["install", "-g", "landrace@latest"], where: "global", cwd: none });
    const other = await project({ "package.json": JSON.stringify({ devDependencies: { jest: "1" } }) });
    expect(updateCommand(other).where).toBe("global");
  });

  it("refuses to guess between two lockfiles, naming both", async () => {
    const dir = await project({ "package.json": dev, "pnpm-lock.yaml": "", "yarn.lock": "" });
    expect(() => updateCommand(dir)).toThrow(/pnpm-lock\.yaml.*yarn\.lock/);
  });
});

describe("ownVersion", () => {
  it("is this package's version", async () => {
    const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as { version: string };
    expect(ownVersion()).toBe(pkg.version);
  });
});

describe("runVersion", () => {
  it("prints the version, then what npm has", async () => {
    const lines: string[] = [];
    await runVersion({ env: {}, current: "1.0.0", latest: async () => "1.1.0", log: (l) => lines.push(l) });
    expect(lines[0]).toBe("landrace 1.0.0");
    expect(lines[1]).toContain("landrace update");
  });

  it("says when this is the latest, and when npm could not be asked", async () => {
    const latest: string[] = [];
    await runVersion({ env: {}, current: "1.1.0", latest: async () => "1.1.0", log: (l) => latest.push(l) });
    expect(latest).toEqual(["landrace 1.1.0", "This is the latest version."]);
    const offline: string[] = [];
    await runVersion({ env: {}, current: "1.1.0", latest: async () => null, log: (l) => offline.push(l) });
    expect(offline[1]).toMatch(/could not/i);
  });

  it("prints only the version when the check is off", async () => {
    const lines: string[] = [];
    const latest = jest.fn(async () => "9.9.9");
    await runVersion({ env: { LANDRACE_NO_UPDATE_CHECK: "1" }, current: "1.0.0", latest, log: (l) => lines.push(l) });
    expect(lines).toEqual(["landrace 1.0.0"]);
    expect(latest).not.toHaveBeenCalled();
  });
});

describe("runUpdate", () => {
  const plan = { command: "pnpm", args: ["add", "-D", "landrace@latest"], where: "project" as const, cwd: "/p" };

  it("runs the update when npm has a newer version", async () => {
    const run = jest.fn(() => 0);
    const lines: string[] = [];
    await runUpdate({ current: "1.0.0", latest: async () => "1.1.0", plan: () => plan, run, log: (l) => lines.push(l) });
    expect(run).toHaveBeenCalledWith(plan);
    expect(lines.join("\n")).toContain("1.1.0");
  });

  it("runs nothing when this is already the latest", async () => {
    const run = jest.fn(() => 0);
    const lines: string[] = [];
    await runUpdate({ current: "1.1.0", latest: async () => "1.1.0", plan: () => plan, run, log: (l) => lines.push(l) });
    expect(run).not.toHaveBeenCalled();
    expect(lines.join("\n")).toMatch(/latest/);
  });

  it("refuses when npm cannot be asked", async () => {
    const run = jest.fn(() => 0);
    await expect(runUpdate({ current: "1.0.0", latest: async () => null, plan: () => plan, run, log: () => {} }))
      .rejects.toThrow(/could not/i);
    expect(run).not.toHaveBeenCalled();
  });

  it("names the command to run by hand when the update fails", async () => {
    await expect(runUpdate({ current: "1.0.0", latest: async () => "1.1.0", plan: () => plan, run: () => 1, log: () => {} }))
      .rejects.toThrow("pnpm add -D landrace@latest");
  });
});

describe("the CLI", () => {
  const env = { ...process.env, LANDRACE_NO_UPDATE_CHECK: "1" };
  const run = (args: string[]) => exec(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, ...args], { env });

  it("prints its version for --version and for `version`", async () => {
    const version = ownVersion();
    expect((await run(["--version"])).stdout.trim()).toBe(version);
    expect((await run(["version"])).stdout.trim()).toBe(`landrace ${version}`);
    // Two cold starts of the CLI from source, each loading its whole module
    // graph: under a full, parallel suite they outran jest's default 5s.
  }, 30_000);
});
