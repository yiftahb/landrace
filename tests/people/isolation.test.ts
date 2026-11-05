import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CREDENTIALS_ROOT } from "#conventions.js";
import { denyForPerson, scopeOf, worktreeFolders } from "#people/isolation.js";

const ENV = "/repo/.landrace/.env";
const where = { worktrees: "/tmp/landrace/repo-1/worktrees", credentials: CREDENTIALS_ROOT, env: [ENV] };

describe("scopeOf", () => {
  it("is a person's id, encoded, so no separator survives", () => {
    expect(scopeOf({ id: "a/b@c.d" })).toBe("a%2Fb%40c.d");
  });
});

describe("denyForPerson", () => {
  it("is the credentials root and the .env always, and each other person's folder", () => {
    expect(denyForPerson({ id: "alice" }, [{ id: "bob" }, { id: "carol@x.io" }], where)).toEqual({
      always: [CREDENTIALS_ROOT, ENV],
      people: ["/tmp/landrace/repo-1/worktrees/bob", "/tmp/landrace/repo-1/worktrees/carol%40x.io"],
    });
  });

  it("never lists the person's own folder, and lists each other's once", () => {
    expect(denyForPerson({ id: "alice" }, [{ id: "alice" }, { id: "bob" }, { id: "bob" }], where).people).toEqual([
      "/tmp/landrace/repo-1/worktrees/bob",
    ]);
  });

  it("denies the .env by every spelling it is given, and one spelling once", () => {
    const real = "/private/repo/.landrace/.env";
    expect(denyForPerson({ id: "local" }, [], { ...where, env: [ENV, real] }).always).toEqual([CREDENTIALS_ROOT, ENV, real]);
    expect(denyForPerson({ id: "local" }, [], { ...where, env: [ENV, ENV] }).always).toEqual([CREDENTIALS_ROOT, ENV]);
  });

  it("is only the credentials root and the .env for a person alone", () => {
    expect(denyForPerson({ id: "local" }, [], where)).toEqual({ always: [CREDENTIALS_ROOT, ENV], people: [] });
  });

  it("lists, for a person with a folder of their own, every other folder there, whoever the roster names", () => {
    const present = ["alice", "bob", "dave%40x.io", "12.write"];
    expect(denyForPerson({ id: "alice" }, [{ id: "bob" }], { ...where, own: "alice", present })).toEqual({
      always: [CREDENTIALS_ROOT, ENV],
      people: ["/tmp/landrace/repo-1/worktrees/bob"],
      found: ["/tmp/landrace/repo-1/worktrees/dave%40x.io", "/tmp/landrace/repo-1/worktrees/12.write"],
    });
  });

  // The local person's worktrees are the folder's own entries: denying what is there would deny them their own.
  it("lists nothing it found for a person without a folder of their own", () => {
    expect(denyForPerson({ id: "local" }, [], { ...where, present: ["12.write", "bob"] }).people).toEqual([]);
  });
});

describe("worktreeFolders", () => {
  it("is every entry there, and none when the folder is not there yet", async () => {
    const root = await mkdtemp(join(tmpdir(), "lr-worktrees-"));
    await mkdir(join(root, "bob", "1.write"), { recursive: true });
    await mkdir(join(root, "carol"));
    expect((await worktreeFolders(root)).sort()).toEqual(["bob", "carol"]);
    expect(await worktreeFolders(join(root, "nowhere"))).toEqual([]);
  });

  // Read as none, a person who left the roster would be left readable.
  it("refuses when the folder is there and cannot be listed", async () => {
    const root = await mkdtemp(join(tmpdir(), "lr-worktrees-"));
    await writeFile(join(root, "worktrees"), "");
    await expect(worktreeFolders(join(root, "worktrees"))).rejects.toThrow(/ENOTDIR/);
  });
});
