import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * `pnpm parity` end to end, over a repository whose hook is a stand-in: the
 * same file at `main` and in the checkout, its `read` throwing for the tickets
 * `THROW` names — on both sides, as a rate limit partway through a run would.
 */
describe("the parity script", () => {
  const script = resolve("scripts/github-parity.mjs");
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "lr-parity-"));
    await mkdir(join(root, ".landrace", "hooks"), { recursive: true });
    await writeFile(join(root, ".landrace", "landrace.yaml"), "tracker: {}\n");
    await writeFile(join(root, ".landrace", "hooks", "github.ts"), `
const graph = (...ids) => ({ nodes: ids.map((id) => ({ id, kind: "ticket" })), relationships: [] });
export const source = {
  list: async () => graph("1", "2"),
  read: async (id) => {
    if ((process.env.THROW ?? "").split(",").includes(id)) throw new Error("rate limited");
    return graph(id);
  },
};
`);
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: root, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-q", "-m", "hook");
  });

  const parity = (THROW: string) => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", script], {
    cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_TOKEN: "t", THROW },
  });

  it("says equal, and exits 0, when every read compared alike", () => {
    const r = parity("");
    expect(r.stdout.trim()).toBe("equal");
    expect(r.status).toBe(0);
  });

  it("says how many reads it compared when some threw on both sides", () => {
    const r = parity("2");
    expect(r.stdout.trim()).toBe("equal (1 of 2 reads compared; 1 threw on both sides)");
    expect(r.status).toBe(0);
  });

  it("refuses equal, and exits 1, when every read threw on both sides", () => {
    const r = parity("1,2");
    expect(r.stdout.trim()).toBe("read: all 2 reads threw on both sides, so no read was compared");
    expect(r.status).toBe(1);
  });
});
