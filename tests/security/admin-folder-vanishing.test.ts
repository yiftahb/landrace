import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { adminFolderProblems, ensureWorktree } from "#agent/worktree.js";
import { gitRepoWithOrigin, removeRepos } from "#tests/support/repo.js";

/*
 * After every Linux write run each admin folder under `<common>/worktrees` is
 * judged, other items' included, while the engine's own `git worktree remove`
 * and `prune` delete theirs. A folder gone partway through the check once read
 * as planted and halted an unrelated item. The deletion is made to land at an
 * exact point of the check, every run, by doing it just before the engine's
 * own call on that path.
 */

jest.setTimeout(60_000);

// `mock`-prefixed, so jest's hoisted factory may read it: before the named call on the path, the action runs once.
const mockBefore = new Map<string, () => Promise<void>>();
jest.mock("node:fs/promises", () => {
  const actual = jest.requireActual<typeof import("node:fs/promises")>("node:fs/promises");
  const wrap = <F extends (path: never, ...rest: never[]) => Promise<unknown>>(name: string, fn: F): F =>
    (async (path: unknown, ...rest: unknown[]) => {
      const key = `${name} ${String(path)}`;
      const act = mockBefore.get(key);
      if (act !== undefined) {
        mockBefore.delete(key);
        await act();
      }
      return (fn as unknown as (...a: unknown[]) => Promise<unknown>)(path, ...rest);
    }) as unknown as F;
  return {
    ...actual,
    lstat: wrap("lstat", actual.lstat),
    readdir: wrap("readdir", actual.readdir),
    realpath: wrap("realpath", actual.realpath),
    open: wrap("open", actual.open),
  };
});

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", args, { cwd })).stdout.trim();

afterAll(removeRepos);
afterEach(() => mockBefore.clear());

async function setup(): Promise<{ root: string; common: string; folder: string }> {
  const { root } = await gitRepoWithOrigin();
  await ensureWorktree("13", root);
  const common = realpathSync(join(root, ".git"));
  const [name] = await readdir(join(common, "worktrees"));
  if (name === undefined) throw new Error("no admin folder");
  return { root, common, folder: join(common, "worktrees", name) };
}

const gone = (path: string) => async (): Promise<void> => rm(path, { recursive: true, force: true });

describe("an admin folder removed while it is judged", () => {
  it.each([
    ["before it is first looked at", (f: string) => `lstat ${f}`],
    ["before it is resolved", (f: string) => `realpath ${f}`],
    ["before its commondir is opened", (f: string) => `open ${join(f, "commondir")}`],
    ["before its info is looked at", (f: string) => `lstat ${join(f, "info")}`],
    ["before its config.worktree is looked at", (f: string) => `lstat ${join(f, "config.worktree")}`],
  ])("%s is nothing to judge", async (_when, at) => {
    const { common, folder } = await setup();
    mockBefore.set(at(folder), gone(folder));
    expect(await adminFolderProblems(common)).toEqual([]);
    expect(mockBefore.size).toBe(0);
  });

  it("with its info emptied by git deleting it, and still there, passes: git reads nothing from an empty one", async () => {
    const { common, folder } = await setup();
    await mkdir(join(folder, "info"));
    await writeFile(join(folder, "info", "sparse-checkout"), "/*\n");
    // Git's delete empties info, then the read of it lands before the folder goes.
    mockBefore.set(`readdir ${join(folder, "info")}`, gone(join(folder, "info", "sparse-checkout")));
    expect(await adminFolderProblems(common)).toEqual([]);
    expect(mockBefore.size).toBe(0);
  });

  it("with its info removed between being found and being read, is judged again, and passes", async () => {
    const { common, folder } = await setup();
    await mkdir(join(folder, "info"));
    await writeFile(join(folder, "info", "sparse-checkout"), "/*\n");
    mockBefore.set(`readdir ${join(folder, "info")}`, gone(join(folder, "info")));
    expect(await adminFolderProblems(common)).toEqual([]);
    expect(mockBefore.size).toBe(0);
  });

  it("hides nothing in another folder that is still there", async () => {
    const { root, common, folder } = await setup();
    await ensureWorktree("14", root);
    const names = (await readdir(join(common, "worktrees"))).map((n) => join(common, "worktrees", n));
    const other = names.find((n) => n !== folder);
    if (other === undefined) throw new Error("no second admin folder");
    await mkdir(join(other, "hooks"));
    mockBefore.set(`lstat ${folder}`, gone(folder));
    expect((await adminFolderProblems(common)).join("\n")).toContain(join(other, "hooks"));
    expect(mockBefore.size).toBe(0);
  });

  it("that is still there, holding a planted hooks, is refused as before", async () => {
    const { common, folder } = await setup();
    await mkdir(join(folder, "hooks"));
    expect((await adminFolderProblems(common)).join("\n")).toContain(join(folder, "hooks"));
  });
});

describe("<common>/worktrees pruned while it is judged", () => {
  it("is nothing to judge", async () => {
    const { root, common } = await setup();
    const under = join(common, "worktrees");
    mockBefore.set(`readdir ${under}`, async () => {
      await rm(under, { recursive: true, force: true });
      await git(root, "worktree", "prune");
    });
    expect(await adminFolderProblems(common)).toEqual([]);
    expect(mockBefore.size).toBe(0);
  });
});
