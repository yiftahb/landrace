import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reexec, REEXEC_MARKER, shouldReexec, STRIP_TYPES } from "#cli/reexec.js";
import { importFailure } from "#hooks/load.js";

/** What node raises for a `.ts` file it is too old to strip types from. */
const unreadable = (): Error =>
  importFailure("hooks/github.ts", Object.assign(new Error("Unknown file extension \".ts\""), {
    code: "ERR_UNKNOWN_FILE_EXTENSION",
  }));

describe("shouldReexec", () => {
  it("re-runs a plain node that cannot read a TypeScript hook", () => {
    expect(shouldReexec(unreadable(), { execArgv: [], env: {} })).toBe(true);
  });

  /**
   * The loop guard, attacked with the case it exists to catch: this *is* the
   * second process, and the same failure came back. Re-execing again would
   * fork forever, each one hiding the real reason behind "re-running with
   * --experimental-strip-types".
   */
  it("refuses a second time, so a failure that survives the flag is reported instead", () => {
    expect(shouldReexec(unreadable(), { execArgv: [], env: { [REEXEC_MARKER]: "1" } })).toBe(false);
  });

  it("refuses when the flag is already on this process, marker or not", () => {
    expect(shouldReexec(unreadable(), { execArgv: [STRIP_TYPES], env: {} })).toBe(false);
  });

  it("leaves every other failure alone", () => {
    expect(shouldReexec(importFailure("hooks/github.ts", new Error("boom")), { execArgv: [], env: {} })).toBe(false);
    expect(shouldReexec(new Error("secret githubToken does not resolve"), { execArgv: [], env: {} })).toBe(false);
  });
});

describe("reexec", () => {
  it("hands the child the flag, the marker and this process's own node options, and reports its exit code", async () => {
    const seen = join(await mkdtemp(join(tmpdir(), "lr-reexec-")), "seen.json");
    const script =
      `require("fs").writeFileSync(${JSON.stringify(seen)}, JSON.stringify(` +
      `{ execArgv: process.execArgv, marker: process.env.${REEXEC_MARKER} })); process.exit(7);`;

    const code = await reexec({
      execPath: process.execPath,
      // Stands in for the node options a real invocation carries (--import,
      // --inspect): dropping them would silently change how the child runs.
      execArgv: ["-e", script],
      argv: [],
      env: { PATH: process.env.PATH ?? "" },
    });

    expect(code).toBe(7);
    const child = JSON.parse(await readFile(seen, "utf8")) as { execArgv: string[]; marker?: string };
    expect(child.execArgv).toContain(STRIP_TYPES);
    expect(child.execArgv).toContain("-e");
    expect(child.marker).toBe("1");
  });
});
