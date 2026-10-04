/*
 * The Claude Code integration against the real CLI: whether a step loads its
 * worktree's instructions and skills, under each tier's own flags (#89).
 *
 *   pnpm build && node scripts/claude-check.mjs
 *
 * `CLAUDE_CHECK_MODEL` picks the model (haiku when unset) and `CLAUDE_BIN`
 * the binary (`claude`). It runs two paid agent turns, one per tier, with
 * your own Claude login. The imports resolve by package self-reference to
 * dist/, hence the build.
 *
 * It makes a scratch git repository with a marker planted in each place
 * instructions could come from: the root `CLAUDE.md`, a link to `AGENTS.md`;
 * `docs/more.md`, which `AGENTS.md` imports;
 * `sub2/CLAUDE.md`, a link to `sub2/AGENTS.md`; `sub1/AGENTS.md` with no
 * `CLAUDE.md` beside it; and a skill under `.claude/skills`, a link to
 * `.agents/skills`, whose `references/ref.md` holds a marker too. Its
 * `.claude/settings.json` has a SessionStart hook that would make a file.
 * A write step and a read-only step each use the skill, read
 * `sub1/notes.txt` and `sub2/notes.txt`, and name the markers they were
 * given. What each must see is what docs/workflows.md says loads: the root
 * instructions and what they import, and the skill as `project:probe-skill`
 * only (from the `init` event's skills, not the model's answer), its
 * references read through the plugin; and neither nested file, nor the hook's
 * file. The last checks need no model: a skill declaring hooks, and a
 * `CLAUDE.md` importing a key, are each refused before the agent starts.
 *
 * Each check prints `ok` or `FAIL` with what it saw. Exits 1 on any failure,
 * and when nothing passed: nothing checked is not a pass.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Claude } from "landrace/integrations/claude";
import { DEFAULT_DENY } from "landrace/kit";

const model = process.env.CLAUDE_CHECK_MODEL || "haiku";
const bin = process.env.CLAUDE_BIN || "claude";
const stamp = Date.now();
const MARKERS = {
  root: `MARKER-ROOT-${stamp}`, imported: `MARKER-IMPORTED-${stamp}`, sub1: `MARKER-SUBONE-${stamp}`, sub2: `MARKER-SUBTWO-${stamp}`, ref: `MARKER-REF-${stamp}`,
};
/** What the worktree's own SessionStart hook would make, had it run. */
const escaped = join(tmpdir(), `landrace-claude-check-hook-${stamp}`);

let passed = 0;
let failed = 0;
/** One check: `run` answers what it saw, or throws what was wrong. */
async function check(name, run) {
  try {
    const saw = await run();
    console.log(`ok    ${name}${saw ? ` — ${saw}` : ""}`);
    passed++;
  } catch (e) {
    console.log(`FAIL  ${name} — ${e instanceof Error ? e.message : String(e)}`);
    failed++;
  }
}
const expect = (holds, what) => {
  if (!holds) throw new Error(what);
};

const scratch = [];
/** A scratch git repository holding these files, and these links (path → target). */
function repo(files, links = {}) {
  const dir = mkdtempSync(join(tmpdir(), "landrace-claude-check-"));
  scratch.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  for (const [path, target] of Object.entries(links)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    symlinkSync(target, join(dir, path));
  }
  return dir;
}

const probe = repo({
  "AGENTS.md": `# Probe\n\nThe marker for this repository is ${MARKERS.root}.\n\n@docs/more.md\n`,
  "docs/more.md": `The imported marker is ${MARKERS.imported}.\n`,
  "sub1/AGENTS.md": `The marker for sub1 is ${MARKERS.sub1}.\n`,
  "sub1/notes.txt": "Nothing to see here.\n",
  "sub2/AGENTS.md": `The marker for sub2 is ${MARKERS.sub2}.\n`,
  "sub2/notes.txt": "Nothing to see here either.\n",
  ".agents/skills/probe-skill/SKILL.md": "---\nname: probe-skill\ndescription: Answers the probe.\n---\n\n" +
    "Read references/ref.md in this skill's base directory and repeat the marker it holds.\n",
  ".agents/skills/probe-skill/references/ref.md": `The skill's marker is ${MARKERS.ref}.\n`,
  // Hooks in a project's settings never load: had this run, `escaped` would exist.
  ".claude/settings.json": JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `touch ${escaped}` }] }] } }),
}, {
  "CLAUDE.md": "AGENTS.md",
  "sub2/CLAUDE.md": "AGENTS.md",
  ".claude/skills": "../.agents/skills",
});

const PROMPT = "Use the probe-skill skill and do what it says. Then read sub1/notes.txt and sub2/notes.txt, and open no " +
  "other file yourself. Then list every string starting with MARKER- that appears anywhere in your instructions, " +
  "context or what you read, one per line, or NONE. Change nothing.";

/** One run of a tier: its answer, and the skills its `init` event listed. */
async function step(capabilities) {
  let skills = [];
  const executor = new Claude({ bin }).build({
    model, servers: {}, tools: {}, plugins: [], sandbox: { hosts: [], deny: [...DEFAULT_DENY] },
    log: (name, data) => {
      const event = data?.event;
      if (name === "agent.event" && event?.type === "system" && event.subtype === "init") skills = event.skills ?? [];
    },
  });
  const { text } = await executor.run(PROMPT, { round: 1, cwd: probe, capabilities, signal: AbortSignal.timeout(300_000) });
  return { text, skills };
}

try {
  for (const [tier, capabilities] of [["write", ["repo:read", "repo:write"]], ["read-only", ["repo:read"]]]) {
    let seen;
    await check(`${tier} step: runs on ${model}`, async () => {
      seen = await step(capabilities);
      return `answered ${JSON.stringify(seen.text.slice(0, 200))}`;
    });
    if (seen === undefined) continue;
    await check(`${tier} step: the root CLAUDE.md, a link to AGENTS.md, loads`, async () =>
      expect(seen.text.includes(MARKERS.root), `${MARKERS.root} was not in its answer`));
    await check(`${tier} step: docs/more.md, which AGENTS.md imports, loads`, async () =>
      expect(seen.text.includes(MARKERS.imported), `${MARKERS.imported} was not in its answer`));
    await check(`${tier} step: the skill loads as project:probe-skill, its folder a link, and only from the plugin`, async () => {
      expect(seen.skills.includes("project:probe-skill"), `init listed ${JSON.stringify(seen.skills)}`);
      // Loaded from the worktree too, the unchecked SKILL.md would be beside the checked copy.
      expect(!seen.skills.includes("probe-skill"), `init also listed the worktree's own probe-skill: ${JSON.stringify(seen.skills)}`);
    });
    await check(`${tier} step: the skill reads its references/ through the plugin`, async () =>
      expect(seen.text.includes(MARKERS.ref), `${MARKERS.ref} was not in its answer`));
    await check(`${tier} step: the worktree's settings hook did not run`, async () =>
      expect(!existsSync(escaped), `${escaped} exists: a project settings hook ran`));
    await check(`${tier} step: sub2/CLAUDE.md does not load, as the docs say`, async () =>
      expect(!seen.text.includes(MARKERS.sub2), `${MARKERS.sub2} was in its answer: update docs/workflows.md`));
    await check(`${tier} step: sub1/AGENTS.md, with no CLAUDE.md beside it, does not load`, async () =>
      expect(!seen.text.includes(MARKERS.sub1), `${MARKERS.sub1} was in its answer: update docs/workflows.md`));
  }

  await check("a skill declaring hooks is refused before the agent starts", async () => {
    const hooked = repo({
      ".claude/skills/hooked/SKILL.md": "---\nname: hooked\ndescription: x\nhooks:\n  PreToolUse:\n    - hooks:\n" +
        `        - type: command\n          command: touch ${join(tmpdir(), `landrace-escaped-${stamp}`)}\n---\n`,
    });
    const executor = new Claude({ bin }).build({ model, servers: {}, tools: {}, plugins: [], sandbox: { hosts: [], deny: [...DEFAULT_DENY] } });
    try {
      await executor.run(PROMPT, { round: 1, cwd: hooked, capabilities: ["repo:read", "repo:write"], signal: AbortSignal.timeout(60_000) });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      expect(/hooked\/SKILL\.md declares hooks/.test(message), `refused for another reason: ${message}`);
      return "refused";
    }
    throw new Error("the step ran");
  });

  await check("a CLAUDE.md importing a key is refused before the agent starts", async () => {
    const importing = repo({ "CLAUDE.md": "@~/.aws/credentials\n" });
    const executor = new Claude({ bin }).build({ model, servers: {}, tools: {}, plugins: [], sandbox: { hosts: [], deny: [...DEFAULT_DENY] } });
    try {
      await executor.run(PROMPT, { round: 1, cwd: importing, capabilities: ["repo:read"], signal: AbortSignal.timeout(60_000) });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      expect(/CLAUDE\.md imports ~\/\.aws\/credentials, which is outside the worktree/.test(message), `refused for another reason: ${message}`);
      return "refused";
    }
    throw new Error("the step ran");
  });
} finally {
  for (const dir of [...scratch, escaped]) rmSync(dir, { recursive: true, force: true });
}

console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 || passed === 0 ? 1 : 0;
