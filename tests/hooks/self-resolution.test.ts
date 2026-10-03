import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { appendFile, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const ROOT = process.cwd();
const LOAD = pathToFileURL(join(ROOT, "src/hooks/load.ts")).href;

/**
 * A hook's `import "landrace/kit"`, answered by the landrace that is running,
 * asked of a real Node rather than of jest's resolver — which maps
 * `landrace/*` to the source itself and so would answer every case here.
 *
 * The running copy is this checkout, built and laid out as `npm i -g` lays a
 * package out: `<prefix>/node_modules/landrace`, its dependencies beside it.
 * Built here, into a temporary folder, so the test never depends on a build
 * having run, and never touches this checkout's own dist/.
 */
let tmp = "";
let copy = "";
let self = "";

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "landrace-self-"));
  copy = join(tmp, "global", "node_modules", "landrace");
  self = pathToFileURL(join(copy, "dist", "cli.js")).href;
  await mkdir(copy, { recursive: true });
  await copyFile(join(ROOT, "package.json"), join(copy, "package.json"));
  await symlink(join(ROOT, "node_modules"), join(copy, "node_modules"), "dir");
  const tsup = JSON.parse(readFileSync(join(ROOT, "node_modules/tsup/package.json"), "utf8")) as { bin: { tsup: string } };
  await exec(process.execPath, [join(ROOT, "node_modules/tsup", tsup.bin.tsup), "--out-dir", join(copy, "dist"), "--no-dts", "--silent"], { cwd: ROOT });
}, 120_000);

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** A project folder holding these files, by path relative to it. */
async function project(name: string, files: Record<string, string>): Promise<string> {
  const dir = join(tmp, name);
  for (const [file, body] of Object.entries(files)) {
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await writeFile(join(dir, file), body);
  }
  return dir;
}

type Loaded = { ok: true; pre: string[] } | { ok: false; message: string; code: string | null };

/** `loadHooks` in a fresh node, with the resolution hook on the running copy registered first, or none. */
async function load(dir: string, modules: string[], running: string | null): Promise<Loaded> {
  const script = `
    const { loadHooks, resolveLandraceToSelf } = await import(${JSON.stringify(LOAD)});
    ${running === null ? "" : `resolveLandraceToSelf(${JSON.stringify(running)});`}
    try {
      const r = await loadHooks({ dir: ${JSON.stringify(dir)}, modules: ${JSON.stringify(modules)} });
      console.log(JSON.stringify({ ok: true, pre: r.pre.map((h) => h.id).sort() }));
    } catch (e) {
      console.log(JSON.stringify({ ok: false, message: e.message, code: e.code ?? e.cause?.code ?? null }));
    }`;
  const { stdout } = await exec(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script], { cwd: dir });
  return JSON.parse(stdout.trim()) as Loaded;
}

// The package, a subpath, the kit and one integration — which itself imports
// `landrace/kit` from inside the copy.
const HOOK = `import { compose } from "landrace/kit";
import { GitHubForge, GitHubIssues } from "landrace/integrations/github";
import { definePreHook } from "landrace";
import { definePreHook as fromHooks } from "landrace/hooks";

export const { source, pre } = compose({ tracker: new GitHubIssues(), forge: new GitHubForge() });
export const own = definePreHook({ id: "own", run: () => ({}) });
export const mine = fromHooks({ id: "mine", run: () => ({}) });
`;

describe("a hook's landrace imports resolve to the running copy", () => {
  it("loads a project with no node_modules at all, and without the hook the same load cannot find landrace", async () => {
    const dir = await project("bare", { "hooks/project.ts": HOOK });
    await expect(load(dir, ["hooks/project.ts"], self)).resolves.toEqual({ ok: true, pre: ["mine", "own", "project"] });
    await expect(load(dir, ["hooks/project.ts"], null)).resolves.toMatchObject({ ok: false, code: "ERR_MODULE_NOT_FOUND" });
  });

  it("answers from the running copy even where the project's node_modules holds a landrace of its own", async () => {
    // Every name the hook imports, so linking passes and the throw is what fails.
    const theirs = "throw new Error(\"loaded the project's own landrace\");\n" +
      "export const compose = 0, GitHubForge = 0, GitHubIssues = 0, definePreHook = 0;\n";
    const dir = await project("shadowed", {
      "hooks/project.ts": HOOK,
      "node_modules/landrace/package.json": JSON.stringify({
        name: "landrace", version: "0.0.1", type: "module",
        exports: { ".": "./theirs.js", "./hooks": "./theirs.js", "./kit": "./theirs.js", "./integrations/*": "./theirs.js" },
      }),
      "node_modules/landrace/theirs.js": theirs,
    });
    await expect(load(dir, ["hooks/project.ts"], self)).resolves.toEqual({ ok: true, pre: ["mine", "own", "project"] });
    // The fake is one Node would have used: without the hook, it is.
    await expect(load(dir, ["hooks/project.ts"], null)).resolves.toMatchObject({ ok: false, message: expect.stringContaining("the project's own landrace") });
  });

  it("leaves every other name as Node resolves it: landrace-other, @scope/landrace, ./landrace/x.js", async () => {
    const pkg = (name: string): string => JSON.stringify({ name, type: "module", exports: "./index.js" });
    const dir = await project("others", {
      "hooks/others.ts": `import other from "landrace-other";
import scoped from "@scope/landrace";
import local from "./landrace/x.js";

const KIND = Symbol.for("landrace.hook.kind");
export const pre = Object.defineProperty({ id: [other, scoped, local].join("+"), run: () => ({}) }, KIND, { value: "pre" });
`,
      "hooks/landrace/x.js": "export default \"local\";\n",
      "node_modules/landrace-other/package.json": pkg("landrace-other"),
      "node_modules/landrace-other/index.js": "export default \"other\";\n",
      "node_modules/@scope/landrace/package.json": pkg("@scope/landrace"),
      "node_modules/@scope/landrace/index.js": "export default \"scoped\";\n",
    });
    await expect(load(dir, ["hooks/others.ts"], self)).resolves.toEqual({ ok: true, pre: ["other+scoped+local"] });
  });

  it("says to update landrace when the installed copy lacks an export the hook imports", async () => {
    const dir = await project("stale", { "hooks/newer.ts": "import { notInThisCopy } from \"landrace/kit\";\nexport const x = notInThisCopy;\n" });
    const result = await load(dir, ["hooks/newer.ts"], self);
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/may be older than the hook expects: update landrace/) });
    expect(result.ok ? "" : result.message).not.toMatch(/rebuild/);
  });

  // What `landrace start` and `landrace mcp` re-run themselves on, for a node
  // too old to read a .ts file: the hook must not turn it into anything else.
  it("keeps a module node cannot read failing as ERR_UNKNOWN_FILE_EXTENSION", async () => {
    const dir = await project("unreadable", { "hooks/x.unreadable": "export const x = 1;\n" });
    await expect(load(dir, ["hooks/x.unreadable"], self)).resolves.toMatchObject({ ok: false, code: "ERR_UNKNOWN_FILE_EXTENSION" });
  });

  it("is in place when the installed CLI validates a project with no node_modules", async () => {
    const dir = await project("cli", { ".landrace/hooks/project.ts": HOOK });
    const cli = (...args: string[]) => exec(process.execPath, [join(copy, "dist", "cli.js"), ...args], {
      cwd: dir, env: { ...process.env, LANDRACE_NO_UPDATE_CHECK: "1" },
    });
    await cli("init", "main");
    await appendFile(join(dir, ".landrace/workflows/main/workflow.yaml"), "hooks:\n  - ../../hooks/project.ts\n");
    // Rejects with the reason, "cannot find package 'landrace'", without it.
    await expect(cli("validate")).resolves.toMatchObject({ stdout: ".landrace: valid\n", stderr: "" });
  });
});
