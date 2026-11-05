import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/*
 * Every git the engine starts runs with hooks and fsmonitor off: a step that
 * may write shares the repository's git directory, and one call left without
 * the guard is the one a planted hook waits for. Read from the source, so a
 * new call is held to it the day it is written.
 */

const SRC = "src";

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []);
}

/** A process started on "git", and what follows its name on the line. */
const SPAWN = /\b(?:exec|execFile|execFileAsync|execFileSync|spawn|spawnSync)\(\s*"git"\s*,\s*(.*)$/;

describe("every git spawn under src/", () => {
  const spawning = files(SRC).filter((f) => readFileSync(f, "utf8").includes("node:child_process"));

  it("finds the spawns it judges", () => {
    // Not found is not missing: a pattern that matched nothing would pass every file.
    const found = spawning.flatMap((f) => readFileSync(f, "utf8").split("\n").filter((l) => SPAWN.test(l)));
    expect(found.length).toBeGreaterThanOrEqual(8);
  });

  it("puts GIT_GUARD_ARGS first, and names git no other way", () => {
    const bad: string[] = [];
    for (const file of spawning) {
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        // "git" as a call's first argument, whatever the function is called.
        if (!/\(\s*"git"\s*[,)]/.test(line)) return;
        const m = SPAWN.exec(line);
        if (m?.[1]?.startsWith("[...GIT_GUARD_ARGS")) return;
        bad.push(`${relative(SRC, file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(bad).toEqual([]);
  });
});
