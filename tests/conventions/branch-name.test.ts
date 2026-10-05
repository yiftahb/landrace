import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { branchNameProblem, branchTemplateProblem, effectBranch } from "#conventions.js";

const exec = promisify(execFile);

jest.setTimeout(60_000);

/**
 * A branch name is handed to `git worktree add` and to `git push` as argv, so
 * the engine and the hooks have to agree with git about what one may look like
 * — and agree *before* git is asked, because a name git refuses is a halt the
 * operator reads, and a name git misreads (`-f`) is an option.
 *
 * Checked against git itself rather than against a list written here: a copy
 * of git's rules that drifted from git would be the defect this exists to stop.
 */
const CORPUS = [
  "landrace/1", "landrace/PROJ-7", "feat/1-api", "a.b", "x/-y", "a{b}", "a@b", "é", "HEAD/x", "x/HEAD",
  "HEAD", "-x", "-", "a..b", "a.lock", "a/b.lock/c", "a.lock/b", "a/.b", ".a", "a/", "/a", "a//b", "a.", "a/b/",
  "a@{b", "@{-1}", "a b", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b", "a\tb", "a\u007fb", "",
];

/*
 * Asked from an empty directory outside any repository: `--branch` expands
 * `@{-N}` against the checkout's own history, so inside a repository the answer
 * for "@{-1}" depended on which branch that checkout happened to have been on.
 */
let outside = "";
beforeAll(async () => {
  outside = await mkdtemp(join(tmpdir(), "landrace-refname-"));
});
afterAll(async () => {
  await rm(outside, { recursive: true, force: true });
});

const gitSays = async (name: string): Promise<boolean> =>
  exec("git", ["check-ref-format", "--branch", name], {
    cwd: outside,
    env: { ...process.env, GIT_CEILING_DIRECTORIES: outside },
  }).then(() => true, () => false);

describe("branch names", () => {
  it.each(CORPUS)("agrees with git check-ref-format --branch about %j", async (name) => {
    expect({ name, ok: branchNameProblem(name) === null }).toEqual({ name, ok: await gitSays(name) });
  });

  /*
   * Stricter than git in one place, on purpose: git accepts a branch called
   * `@`, which every git command also reads as HEAD. A workflow that named one
   * would be pushing whatever the operator has checked out.
   */
  it("refuses @, which git reads as HEAD everywhere else", () => {
    expect(branchNameProblem("@")).toMatch(/@/);
  });

  it("says what is wrong, naming the name", () => {
    expect(branchNameProblem("a..b")).toMatch(/"a\.\.b"/);
    expect(branchNameProblem("-f")).toMatch(/-/);
  });
});

/*
 * The branch a publishing effect names, as the workflow's template left it.
 * A `{name}` nothing filled in is a legal ref to git — braces are allowed —
 * so it is refused by name, the way a stage's own branch is.
 */
describe("the branch an effect names", () => {
  it("is taken as it stands when it is a usable name", () => {
    expect(effectBranch({ type: "branch.push", branch: "landrace/7" })).toBe("landrace/7");
  });

  it("is refused when a template name was left in it", () => {
    expect(() => effectBranch({ type: "pull.open", branch: "landrace/{item}" })).toThrow(/\{item\}/);
    expect(() => effectBranch({ type: "pull.open", branch: "x/{node.title}" })).toThrow(/\{node\.title\}/);
  });

  it("is refused when it names none, or one git would refuse", () => {
    expect(() => effectBranch({ type: "branch.push" })).toThrow(/names none/);
    expect(() => effectBranch({ type: "branch.push", branch: "a..b" })).toThrow(/not a usable branch name/);
  });
});

/*
 * The item branch a project configures. A forge reads an item back out of a
 * head by the template's fixed text, so the template has to leave `{item}`
 * recoverable, and git has to take what it fills to.
 */
describe("an item branch template", () => {
  it.each(["landrace/{item}", "lr-{item}", "lr/{item}-x"])("takes %j", (template) => {
    expect(branchTemplateProblem(template)).toBeNull();
  });

  it.each([
    ["lr-", /\{item\} once.*none/],
    ["lr-{item}-{item}", /\{item\} once.*2/],
    ["{item}", /fixed text before \{item\}/],
    ["{item}-lr", /fixed text before \{item\}/],
    ["lr-{round}-{item}", /\{round\}/],
    ["lr..{item}", /not a usable branch name.*".."/],
    ["lr-{item}.lock", /not a usable branch name.*\.lock/],
    ["-{item}", /not a usable branch name.*"-"/],
  ])("refuses %j, saying which rule", (template, why) => {
    expect(branchTemplateProblem(template)).toMatch(why);
  });
});
