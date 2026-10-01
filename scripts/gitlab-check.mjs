/*
 * The GitLab forge against a live project, end to end:
 *
 *   pnpm build && GITLAB_TOKEN=… GITLAB_PROJECT=group/app [GITLAB_BASE_URL=https://host] \
 *     node scripts/gitlab-check.mjs
 *
 * On a throwaway branch `landrace/{n}` it appends one line to README.md, then
 * drives the forge as a workflow would: the startup check, the merge request
 * opened — and opened again, which GitLab answers 409 and counts as done — a
 * review round's findings on the added line and on the context line above it,
 * the fixer's replies and the reviewer's resolve, reading back after each the
 * counts the review loop gates on. Prints each check as it passes and exits
 * 0; the first that fails exits 1. Whatever happened, the merge request is
 * closed and the branch deleted.
 *
 * `landrace/integrations/gitlab` resolves to dist/ by package self-reference —
 * hence the build. Nothing is pushed: the branch is made by GitLab's own
 * commits API, so no checkout or credential helper is involved.
 */
const token = process.env.GITLAB_TOKEN;
const project = process.env.GITLAB_PROJECT;
const baseUrl = (process.env.GITLAB_BASE_URL || "https://gitlab.com").replace(/\/$/, "");
if (!token || !project) {
  console.error(
    `gitlab-check: set ${token ? "" : "GITLAB_TOKEN (the api scope, Developer on the project) and "}` +
    `GITLAB_PROJECT (its full path, group/app); GITLAB_BASE_URL too, off gitlab.com`,
  );
  process.exit(2);
}

const { GitLab } = await import("landrace/integrations/gitlab");

const n = String(900_000_000 + (Date.now() % 100_000_000));
const branch = `landrace/${n}`;
const ctx = {
  config: {},
  secrets: new Map([["gitlabToken", token], ...(process.env.GITLAB_BASE_URL ? [["gitlabBaseUrl", baseUrl]] : [])]),
  signal: new AbortController().signal,
  log: (event, data) => console.log(`    ${event} ${JSON.stringify(data ?? {})}`),
};
const forge = new GitLab({ project, git: async () => "" });
const effects = forge.effects();

/** The few calls the forge never makes: a file read, a commit that makes the branch, and its deletion. */
async function api(method, path, body) {
  const res = await fetch(`${baseUrl}/api/v4/projects/${encodeURIComponent(project)}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

let step = "";
const ok = (what) => console.log(`ok  ${what}`);
const expect = (cond, what) => {
  if (!cond) throw new Error(what);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let head = "";
let iid = null;
let branchMade = false;

/** What the engine would hand an effect: the item's pull request nodes, and this branch committed. */
const snapshot = async () => ({
  node: { id: n, title: `gitlab-check ${n}` },
  graph: await forge.read([n], ctx, async () => false),
  git: { local: { [branch]: head }, remote: {} },
});
const apply = async (effect) => effects[effect.type].apply(effect, { ...ctx, item: n, snapshot: await snapshot() });
const counts = async () => {
  const pr = (await forge.read([n], ctx, async () => false)).nodes.find((node) => node.id === `pr-${iid}`);
  return `${pr?.state.openThreads}/${pr?.state.awaitingFix}`;
};
const round = (marker, output) => {
  const [kind, r] = marker.split(":");
  return { type: "pull.review", branch, marker, stage: kind === "fix" ? "fix-review" : "code-review", round: Number(r), body: `gitlab-check ${marker}`, output };
};

try {
  step = "check";
  await forge.check(ctx);
  ok(`check: ${project} on ${baseUrl}, token with the api scope and Developer access`);

  step = "branch";
  const info = await api("GET", "");
  const readme = await api("GET", `/repository/files/README.md?ref=${encodeURIComponent(info.default_branch)}`);
  const before = Buffer.from(readme.content, "base64").toString("utf8");
  const text = before.endsWith("\n") || before === "" ? before : `${before}\n`;
  const lines = text === "" ? 0 : text.split("\n").length - 1;
  // A last line with no newline is changed by the append — the diff shows it
  // removed and added — so the unchanged line above the new one is before it.
  const context = before.endsWith("\n") ? lines : lines - 1;
  expect(context > 0, "README.md has no line the diff would show unchanged, to put a context finding on");
  const commit = await api("POST", "/repository/commits", {
    branch, start_branch: info.default_branch, commit_message: `gitlab-check ${n}`,
    actions: [{ action: "update", file_path: "README.md", content: `${text}landrace gitlab-check ${n}\n` }],
  });
  head = commit.id;
  branchMade = true;
  ok(`branch ${branch}: README.md line ${lines + 1} added`);

  step = "pull.open";
  await apply({ type: "pull.open", branch });
  const opened = (await forge.pullsNaming(n, ctx)).filter((p) => !p.merged && !p.closed);
  expect(opened.length === 1 && opened[0].branch === branch, `expected one open merge request from ${branch}, read ${opened.length}`);
  iid = opened[0].number;
  ok(`merge request !${iid} opened into ${info.default_branch}: ${opened[0].link}`);
  await apply({ type: "pull.open", branch });
  expect((await forge.pullsNaming(n, ctx)).length === 1, "opening it again made a second merge request");
  ok("opened again: GitLab's 409 counts as done");

  step = "diff";
  for (let i = 0; ; i++) {
    const readmeDiff = (await forge.changedFiles(iid, ctx)).find((f) => f.path === "README.md");
    if (readmeDiff?.patch) break;
    expect(i < 30, "GitLab had not worked out the merge request's diff after 30s");
    await sleep(1000);
  }
  ok("diff read");

  step = "review";
  await apply(round("review:1", {
    findings: [
      { file: "README.md", line: lines + 1, body: "gitlab-check: a finding on the added line" },
      { file: "README.md", line: context, body: "gitlab-check: a finding on the context line" },
    ],
    resolved: [],
  }));
  const threads = await forge.threads(iid, ctx);
  const placed = threads.map((t) => `${t.path}:${t.line}`).sort();
  expect(JSON.stringify(placed) === JSON.stringify([`README.md:${context}`, `README.md:${lines + 1}`].sort()),
    `expected line threads on README.md:${context} and :${lines + 1}, read ${placed.join(", ") || "none"}`);
  expect((await counts()) === "2/2", `expected 2/2 open/awaiting a fix, read ${await counts()}`);
  ok(`findings threaded on README.md:${lines + 1} (added) and :${context} (context); counts 2/2`);
  expect((await forge.reviews(iid, ctx)).some((body) => body.includes("review:1")), "the review's note is not among our notes");
  ok("review posted as our note, and not counted");

  step = "reply";
  await apply(round("fix:1", { replies: threads.map((t) => ({ thread: t.id, body: "gitlab-check: fixed" })) }));
  expect((await counts()) === "2/0", `expected 2/0 after the replies, read ${await counts()}`);
  ok("replied on both; counts 2/0");

  step = "resolve";
  await apply(round("review:2", { findings: [], resolved: threads.map((t) => t.id) }));
  expect((await counts()) === "0/0", `expected 0/0 after resolving, read ${await counts()}`);
  ok("resolved both; counts 0/0");
} catch (e) {
  console.error(`FAIL ${step}: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  // Each on its own, so a close that fails still leaves the branch deleted.
  const cleanup = async (what, run) => {
    try {
      await run();
      ok(`cleaned up: ${what}`);
    } catch (e) {
      console.error(`FAIL cleanup — ${what} by hand: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    }
  };
  if (iid !== null) await cleanup(`close !${iid}`, () => forge.closePull(iid, ctx));
  if (branchMade) await cleanup(`delete ${branch}`, () => api("DELETE", `/repository/branches/${encodeURIComponent(branch)}`));
}
