import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";
import { isEngineLabel } from "#conventions.js";
import { WORKFLOW_ID, WORKFLOW_ID_RULE } from "#workflow/workspace.js";

const execFileAsync = promisify(execFile);

const ENV_ENTRY = ".landrace/.env";

/*
 * Commented placeholders, and the two keys the schema requires. The engine
 * names no agent, so `adapter` is one nobody registers: `validate` names it
 * until a hook does, which is the next thing a new project has to write.
 */
const CONFIG = `# Landrace's runtime: how agents run and where items live. Every key is
# described in Landrace's docs/configuration.md.
version: 1 # the file format; 1 is the only one

agent:
  # The coding agent that runs steps: the id a hook under .landrace/hooks/
  # registers with defineExecutor. A placeholder until then, which
  # \`landrace validate\` names.
  adapter: my-agent
  # How the engine prepares the directory a step runs in: worktree (the
  # default), none or container.
  # isolation: worktree

# Where your items live, handed unread to your tracker hooks: its keys are
# the hook's own, such as the repository as owner/name.
# tracker:
#   repo: owner/name

# Credentials, each a $VARIABLE resolved from .landrace/.env (gitignored) or
# your shell and handed to your hooks as a value. Never the value itself:
# this file is committed.
# secrets:
#   token: $TRACKER_TOKEN

# Secret names whose values are stripped from every log line.
# log:
#   redact: [token]
`;

/** Quoted, since YAML would read an id such as `123` as a number and `name` is a string. */
const workflowYaml = (name: string, label: string): string => `# The ${name} workflow: the stages an item moves through, from the one it
# starts at to the one where its work is done. Every key, and the prompts a
# stage runs from steps/, is described in Landrace's docs/workflows.md, and
# hooks in docs/hooks.md. Check it with \`landrace validate\`.
version: 1 # the file format; 1 is the only one

# The title the board shows, and what landrace_workflows tells an agent this
# workflow is for.
name: ${JSON.stringify(name)}
description: ${JSON.stringify(`Items labelled ${label}, from todo to done.`)}

# The labels an item started in this workflow is given; eligible must accept them.
admit: [${JSON.stringify(label)}]

# Which items this workflow takes. Every rule must hold, and an item one
# turns away is skipped with its \`else\` as the reason \`landrace status\` prints.
eligible:
  - when: { "node.state.labels": { $in: [${JSON.stringify(label)}] } }
    else: ${JSON.stringify(`no ${label} label`)}

# The modules that read your tracker and run your agent, by path from this
# folder. None yet.
# hooks:
#   - ../../hooks/<module>.ts

stages:
  # Where a new item starts. A stage that runs an agent names its prompt,
  # \`step: steps/<file>.md\`; this one runs none yet.
  - id: todo
    entry: true
    # Applied by your hooks as an item enters. Its position is a label, so
    # every stage sets its own.
    on_enter:
      - { type: tracker.status, value: todo }

  # Where an item's work is done.
  - id: done
    terminal: true
    # What moves an item here: each trigger is a condition on the item's
    # snapshot. This one holds once todo's step has recorded its output.
    triggers:
      - name: todo's step is done
        when: { "run.outputs.todo": { $exists: true } }
    on_enter:
      - { type: tracker.status, value: done }
`;

/**
 * Whether the repository already ignores `.landrace/.env`. Git answers where
 * it can, since a pattern such as `.env` covers the file without naming it —
 * a `.gitignore` above this folder's too. Only a `.gitignore`'s pattern
 * counts: the person's own excludes file, which `validate` counts, and the
 * clone's `.git/info/exclude` ignore it in this clone only, and the entry is
 * for every clone. Outside a repository, or without git, the file's own lines
 * are all there is to read.
 */
async function ignored(cwd: string, text: string | null): Promise<boolean> {
  try {
    // The excludes file off too, since one may itself be named ~/.gitignore.
    const { stdout } = await execFileAsync("git", ["-c", "core.excludesFile=/dev/null", "check-ignore", "-v", ENV_ENTRY], { cwd });
    // `<source>:<line>:<pattern>\t<path>` for the deciding pattern; a "!" one un-ignores.
    return /^"?(?:.*\/)?\.gitignore"?:\d+:(?!!)/.test(stdout);
  } catch (e) {
    if ((e as { code?: unknown }).code === 1) return false;
  }
  return (text ?? "").split(/\r?\n/).some((line) => [ENV_ENTRY, `/${ENV_ENTRY}`].includes(line.trim()));
}

/** The `.landrace/.env` entry, or null when the repository already ignores it. */
async function gitignore(cwd: string): Promise<string | null> {
  const file = join(cwd, ".gitignore");
  const text = await readFile(file, "utf8").catch((e: unknown) => {
    if ((e as { code?: unknown }).code === "ENOENT") return null;
    throw e;
  });
  if (await ignored(cwd, text)) return null;
  if (text === null) {
    await writeFile(file, `${ENV_ENTRY}\n`, { flag: "wx" });
    return `created .gitignore, ignoring ${ENV_ENTRY}`;
  }
  await writeFile(file, `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${ENV_ENTRY}\n`);
  return `added ${ENV_ENTRY} to .gitignore`;
}

/**
 * `landrace init <name>`: the workflow `name` in `<cwd>/.landrace/`, and the
 * workspace around it when there is none. Returns what to print; a refusal
 * throws its sentence before anything is written. Nothing is overwritten:
 * the workflow folder is made without `recursive`, so an existing one is
 * refused rather than written into, and every file is opened exclusively.
 */
export async function runInit(cwd: string, name: string): Promise<string[]> {
  if (!WORKFLOW_ID.test(name)) throw new Error(`${JSON.stringify(name)} is not a usable workflow id: ${WORKFLOW_ID_RULE}`);
  const label = `lr:${name}`;
  // validate refuses a workflow that admits one, so the skeleton would not pass.
  if (isEngineLabel(label)) throw new Error(`"${name}" would admit items labelled ${label}, a label the engine writes itself; choose another name`);

  const fresh = await stat(join(cwd, ".landrace")).then(() => false, () => true);
  const folder = join(".landrace", "workflows", name);
  await mkdir(join(cwd, ".landrace", "workflows"), { recursive: true });
  await mkdir(join(cwd, folder)).catch((e: unknown) => {
    if ((e as { code?: unknown }).code === "EEXIST") throw new Error(`${folder}/ already exists; init never writes into a workflow folder, so choose another name`);
    throw e;
  });
  await mkdir(join(cwd, folder, "steps"));

  const created: string[] = [];
  const write = async (path: string, text: string): Promise<void> => {
    await writeFile(join(cwd, path), text, { flag: "wx" });
    created.push(`created ${path}`);
  };
  if (fresh) await write(join(".landrace", "landrace.yaml"), CONFIG);
  await write(join(folder, "workflow.yaml"), workflowYaml(name, label));
  await write(join(folder, "steps", ".gitkeep"), "");
  const entry = fresh ? await gitignore(cwd) : null;
  if (entry) created.push(entry);

  /*
   * A workflows: list must name every folder, so until it names this one the
   * workspace does not load. init never edits landrace.yaml; it says so. One
   * that will not parse is validate's to report.
   */
  const order = fresh ? undefined : await readFile(join(cwd, ".landrace", "landrace.yaml"), "utf8")
    .then((text) => (parse(text) as { workflows?: unknown } | null)?.workflows)
    .catch(() => undefined);
  const next = `edit ${join(folder, "workflow.yaml")}, add the hooks it loads under .landrace/hooks/, then run landrace validate`;
  return [
    ...created,
    Array.isArray(order) && !order.includes(name)
      ? `next: add "${name}" to workflows: in .landrace/landrace.yaml, which must name every workflow folder or the workspace will not load; then ${next}`
      : `next: ${next}`,
  ];
}
