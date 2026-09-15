import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN = [
  "node:fs", "node:http", "node:https", "node:child_process",
  "node:os", "node:process", "node:crypto",
];

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("core purity", () => {
  const files = filesUnder("src/core");

  it("has files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(FORBIDDEN)("core never imports %s", (mod) => {
    const offenders = files.filter((f) => readFileSync(f, "utf8").includes(`"${mod}"`));
    expect(offenders).toEqual([]);
  });

  it("core never reads the clock or randomness", () => {
    const offenders = files.filter((f) => /Date\.now\(|Math\.random\(/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("core never imports a sibling layer", () => {
    const offenders = files.filter((f) => /from "\.\.\/(workflow|cli|hooks|runner|agent)/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
