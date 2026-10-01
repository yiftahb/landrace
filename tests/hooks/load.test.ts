import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importFailure, loadHooks } from "#hooks/load.js";

/**
 * `workflow.yaml` is a repo file a contributor's PR can edit, and `import()`
 * runs whatever it names — so a hook path is checked exactly as hard as a step
 * path is, by the same helper, and nothing is imported until every path in the
 * list has passed.
 */
describe("a hook module must resolve inside the workflow directory", () => {
  const load = (module: string) => loadHooks({ dir: "tests/fixtures", modules: [module] });

  it("refuses an absolute path", async () => {
    await expect(load("/etc/passwd")).rejects.toThrow(/hook module "\/etc\/passwd" is absolute/);
  });

  it("refuses a path that climbs out", async () => {
    await expect(load("../../src/hooks/load.ts")).rejects.toThrow(/contains a "\.\." segment/);
  });

  it("reports a module that is not there as missing, not as unsafe", async () => {
    await expect(load("hooks/nowhere.ts")).rejects.toThrow(/hook module "hooks\/nowhere\.ts" does not exist/);
  });

  /*
   * Path arithmetic is containment against a typo, not against a contributor:
   * git tracks symlinks, so the same PR that adds the hook path can add the
   * link it escapes through, and a lexically-contained path survives it.
   */
  it("refuses a link inside the directory that points outside it", async () => {
    const root = await mkdtemp(join(tmpdir(), "landrace-hooks-"));
    const dir = join(root, "workflow");
    try {
      await mkdir(dir);
      await writeFile(join(root, "outside.ts"), "export const x = 1;\n");
      await symlink(join(root, "outside.ts"), join(dir, "sneaky.ts"));

      await expect(loadHooks({ dir, modules: ["sneaky.ts"] }))
        .rejects.toThrow(/hook module "sneaky\.ts" is a link to something outside the directory/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /*
   * Rejected before the first module is imported, not while walking the list:
   * importing as we go would already have run module one's top-level code by
   * the time module two turns out to be a path escape. `loud.ts` says whether
   * that happened.
   */
  it("refuses a list with a bad path in it without importing the good ones", async () => {
    const loaded = () => (globalThis as Record<string, unknown>).__landraceLoudHookLoaded;
    expect(loaded()).toBeUndefined();

    await expect(
      loadHooks({ dir: "tests/fixtures", modules: ["hooks/loud.ts", "/etc/passwd"] }),
    ).rejects.toThrow(/"\/etc\/passwd" is absolute/);

    expect(loaded()).toBeUndefined();
  });

  it("refuses the same module listed twice", async () => {
    await expect(
      loadHooks({ dir: "tests/fixtures", modules: ["hooks/alpha.ts", "hooks/alpha.ts"] }),
    ).rejects.toThrow(/hook module "hooks\/alpha\.ts" is listed twice/);
  });
});

/**
 * A hook module is TypeScript that nothing compiles before it is imported, so
 * "this Node is too old to read it" is the likeliest failure on a given
 * machine — and Node's own "Unknown file extension .ts" says nothing about
 * which of the operator's two problems it is.
 * `tests/hooks/strip-types.test.ts` pins that this really is the code Node
 * raises, so the branch below is keyed on something checked rather than
 * remembered.
 */
describe("an import failure says what to do about it", () => {
  const unknownExtension = Object.assign(new Error("Unknown file extension \".ts\""), {
    code: "ERR_UNKNOWN_FILE_EXTENSION",
  });

  it("turns an unreadable .ts into the Node version and the flag", () => {
    const message = importFailure("hooks/github.ts", unknownExtension).message;
    expect(message).toContain('hook module "hooks/github.ts"');
    expect(message).toMatch(/22\.18/);
    expect(message).toMatch(/--experimental-strip-types/);
    // A standing project rule, and the first thing somebody reaches for here.
    expect(message).toMatch(/tsx, jiti or ts-node/);
  });

  it("reports anything else as itself, attributed to the module", () => {
    const message = importFailure("hooks/github.ts", new Error("boom")).message;
    expect(message).toBe('cannot import hook module "hooks/github.ts": boom');
  });

  /*
   * A hook written against a newer landrace than the one loading it — in this
   * repository, a dist/ not rebuilt since a pull — fails on its first import
   * line, and Node names only the export it could not find.
   * `tests/hooks/strip-types.test.ts` pins that this is what Node raises.
   */
  it("says the landrace may be older than the hook when an import it names is missing", () => {
    const missing = new SyntaxError("The requested module 'landrace/hooks' does not provide an export named 'defineExecutor'");
    expect(importFailure("hooks/claude.ts", missing).message).toBe(
      'cannot import hook module "hooks/claude.ts": The requested module \'landrace/hooks\' does not provide an export named ' +
      "'defineExecutor'; the landrace this hook was loaded against may be older than the hook expects: rebuild or update it",
    );
    const bare = new SyntaxError("The requested module 'landrace' does not provide an export named 'createLogger'");
    expect(importFailure("hooks/x.ts", bare).message).toMatch(/may be older than the hook expects/);
  });

  // #32's last review: the kit and the integrations are landrace's own entry
  // points too, and a hook reaching for an export one gained since the last
  // build got Node's bare error with no hint.
  it.each(["landrace/kit", "landrace/integrations/claude", "landrace/integrations/codex"])(
    "says the same when the module lacking the export is %s",
    (module) => {
      const missing = new SyntaxError(`The requested module '${module}' does not provide an export named 'Claude'`);
      expect(importFailure("hooks/claude.ts", missing).message).toMatch(/may be older than the hook expects/);
    },
  );

  it.each(["landrace/kitchen", "landrace/integrations", "landrace/integrations/a/b", "landrace-extra"])(
    "says nothing about landrace for %s, which is not one of its entry points",
    (module) => {
      const missing = new SyntaxError(`The requested module '${module}' does not provide an export named 'x'`);
      expect(importFailure("hooks/x.ts", missing).message).not.toMatch(/may be older/);
    },
  );

  // A hook's own sibling module lacking an export is the hook's bug: blaming
  // the landrace build sends the operator to rebuild something that is fine.
  it("says nothing about landrace when the module lacking the export is the hook's own", () => {
    const sibling = new SyntaxError("The requested module './client.ts' does not provide an export named 'request'");
    expect(importFailure("hooks/github.ts", sibling).message).toBe(
      'cannot import hook module "hooks/github.ts": The requested module \'./client.ts\' does not provide an export named \'request\'',
    );
  });

  // A hook module is arbitrary code; nothing stops it rejecting with a
  // non-Error, and reading `.message` off one throws from inside the very
  // catch whose job is to report the failure.
  it("survives a module that throws something that is not an Error", () => {
    expect(importFailure("hooks/x.ts", Object.create(null)).message).toContain('hook module "hooks/x.ts"');
  });
});

describe("loadHooks inside a workspace", () => {
  it("refuses a module that climbs out of the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "landrace-wshooks-"));
    const dir = join(root, "workflows", "main");
    await mkdir(dir, { recursive: true });
    await writeFile(join(root, "x.ts"), "export const x = 1;\n");
    await expect(loadHooks({ dir, modules: ["../../../x.ts"], workspace: root })).rejects.toThrow(/hook module "\.\.\/\.\.\/\.\.\/x\.ts"/);
  });

  it("still refuses a climb out of the workflow when no workspace is given", async () => {
    const root = await mkdtemp(join(tmpdir(), "landrace-wshooks-"));
    const dir = join(root, "workflows", "main");
    await mkdir(dir, { recursive: true });
    await writeFile(join(root, "x.ts"), "export const x = 1;\n");
    await expect(loadHooks({ dir, modules: ["../../x.ts"] })).rejects.toThrow(/hook module/);
  });
});
