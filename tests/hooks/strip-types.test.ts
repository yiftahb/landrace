import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * What Node itself does with a hook module, asked of a real Node rather than
 * of the test runner's transform.
 *
 * `src/hooks/load.ts` makes two claims about the runtime it will be running
 * in, and both are the kind of assumption that rots silently: that a
 * `file:` URL for a `.ts` file imports once types can be stripped, and that
 * an extension the runtime cannot read comes back as
 * `ERR_UNKNOWN_FILE_EXTENSION` — the code its error message branches on. The
 * suite's own runtime answers neither question, because ts-jest transforms
 * the file before Node ever sees it.
 */
async function nodeImport(file: string, flags: string[] = []): Promise<{ ok: boolean; code?: string; value?: string }> {
  const url = pathToFileURL(file).href;
  const script =
    `try { const m = await import(${JSON.stringify(url)}); ` +
    `console.log(JSON.stringify({ ok: true, value: m.value })); } ` +
    `catch (e) { console.log(JSON.stringify({ ok: false, code: e?.code ?? String(e) })); }`;
  const { stdout } = await execFileAsync(process.execPath, [...flags, "--input-type=module", "-e", script]);
  return JSON.parse(stdout.trim()) as { ok: boolean; code?: string; value?: string };
}

describe("node imports a hook module written in TypeScript", () => {
  let dir = "";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "landrace-strip-"));
    await writeFile(join(dir, "hook.ts"), "export const value: string = \"stripped\";\n");
    await writeFile(join(dir, "hook.unreadable"), "export const value = \"never\";\n");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("strips the types and imports it by file URL", async () => {
    // The remedy the loader's message names, run for real. Passed explicitly
    // so this says the same thing on a Node old enough to need the flag and
    // on one new enough to ignore it.
    await expect(nodeImport(join(dir, "hook.ts"), ["--experimental-strip-types"]))
      .resolves.toEqual({ ok: true, value: "stripped" });
  });

  /*
   * The code `importFailure` keys on. A Node too old to strip types raises
   * exactly this for a `.ts` file; an extension no Node will ever read raises
   * it on every version, which is what makes it something this suite can
   * actually check rather than remember.
   */
  it("reports an extension it has no loader for as ERR_UNKNOWN_FILE_EXTENSION", async () => {
    await expect(nodeImport(join(dir, "hook.unreadable")))
      .resolves.toEqual({ ok: false, code: "ERR_UNKNOWN_FILE_EXTENSION" });
  });

  /*
   * What `importFailure` reads as a hook newer than the landrace it imports:
   * a SyntaxError with no code, quoting the module's specifier and naming the
   * export that is not there — the specifier is how it tells landrace's own
   * module from the hook's sibling.
   */
  it("reports an import of an export that is not there as a SyntaxError naming it", async () => {
    await writeFile(join(dir, "contracts.mjs"), "export const defineHook = 1;\n");
    await writeFile(join(dir, "newer.mjs"), "import { defineExecutor } from \"./contracts.mjs\";\nexport const value = defineExecutor;\n");
    const result = await nodeImport(join(dir, "newer.mjs"));
    expect(result.ok).toBe(false);
    expect(result.code).toBe("SyntaxError: The requested module './contracts.mjs' does not provide an export named 'defineExecutor'");
  });
});
