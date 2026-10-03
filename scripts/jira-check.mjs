/*
 * The Jira integration against a live Jira Cloud project, through the hooks a
 * project's hook file exports — `compose` over `Jira`, `MemoryForge` and
 * `MemoryDocs`:
 *
 *   pnpm build && JIRA_BASE_URL=https://<site>.atlassian.net JIRA_EMAIL=… \
 *     JIRA_TOKEN=… JIRA_PROJECT=KEY node scripts/jira-check.mjs
 *
 * `JIRA_OPTIONS`, optional, is JSON spread into `new Jira({ project })` —
 * `{"childType":"Sub-task","transitions":{"dropped":"Cancelled"}}`. The
 * imports resolve by package self-reference to dist/, hence the build.
 *
 * It writes, so point it at a project that may hold test issues: one item
 * and one child, created, commented on, labelled and closed — the child as
 * dropped, the item as done. Each check prints `ok` or `FAIL` with what it
 * saw; a check whose item was never created is not run. Exits 1 on any
 * failure, and when nothing passed: nothing checked is not a pass.
 *
 * Opt in to a blocked-by round trip over the site's "Blocks" links (or the
 * type `blockedByLinkType` names) with `JIRA_CHECK_LINKS=1` — two scratch
 * issues, created and dropped again — or `JIRA_LINK_KEYS=KEY-12,OTHER-3`, two
 * issues of yours not linked so already: the first, the project's own, to be
 * blocked by the second, anywhere on the site. It relates them, reads back through the integration
 * that the first is blocked by the second and not the other way round,
 * prints the direction Jira itself shows on the blocked issue, unrelates
 * them and reads back none: the first run on a site proves the direction.
 */
import { Jira } from "landrace/integrations/jira";
import { compose } from "landrace/kit";
import { MemoryDocs, MemoryForge } from "landrace/testing";

const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_TOKEN, JIRA_PROJECT, JIRA_OPTIONS, JIRA_CHECK_LINKS, JIRA_LINK_KEYS } = process.env;
const unset = Object.entries({ JIRA_BASE_URL, JIRA_EMAIL, JIRA_TOKEN, JIRA_PROJECT }).filter(([, v]) => !v).map(([k]) => k);
if (unset.length > 0) {
  console.error(`jira-check: set ${unset.join(", ")}`);
  process.exit(2);
}
let options = {};
try {
  options = JIRA_OPTIONS ? JSON.parse(JIRA_OPTIONS) : {};
} catch (e) {
  console.error(`jira-check: JIRA_OPTIONS is not JSON: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}

const ctx = {
  config: {},
  secrets: new Map([["jiraBaseUrl", JIRA_BASE_URL], ["jiraEmail", JIRA_EMAIL], ["jiraToken", JIRA_TOKEN]]),
  signal: new AbortController().signal,
  log: (event, data) => console.error(`${event} ${JSON.stringify(data ?? {})}`),
};
const hooks = compose({ tracker: new Jira({ ...options, project: JIRA_PROJECT }), forge: new MemoryForge(), docs: new MemoryDocs() });

let passed = 0;
let failed = 0;
/** One check: `run` answers what it saw, or throws what was wrong. */
async function check(name, run) {
  try {
    const saw = await run();
    console.log(`ok    ${name}${saw ? ` — ${saw}` : ""}`);
    passed++;
    return true;
  } catch (e) {
    console.log(`FAIL  ${name} — ${e instanceof Error ? e.message : String(e)}`);
    failed++;
    return false;
  }
}
const expect = (holds, what) => {
  if (!holds) throw new Error(what);
};
const on = (item, snapshot = {}) => ({ ...ctx, item, snapshot });
const snapshotOf = async (id) => {
  const graph = await hooks.source.read(id, ctx);
  return { graph, node: graph.nodes.find((n) => n.id === id) };
};

const stamp = new Date().toISOString();
const body = `Created by scripts/jira-check.mjs at ${stamp}.\nA second line, {braces} and a \\ backslash.`;
let item;
let child;

await check("preflight: permissions, issue types, labels field", async () => {
  await hooks.preflight.check(ctx);
});

await check("create an item, labelled, at the highest priority", async () => {
  item = await hooks.operator.createItem({ title: `landrace jira-check ${stamp}`, body, labels: ["landrace-check"], priority: 0 }, ctx);
  expect(item.id.startsWith(`${JIRA_PROJECT}-`), `created ${item.id}, not a ${JIRA_PROJECT} key`);
  expect(item.state.labels.includes("landrace-check"), `labels read back as ${JSON.stringify(item.state.labels)}`);
  expect(item.priority === 0, `priority read back as ${item.priority}`);
  return item.link;
});

if (item) {
  await check("its body reads back exactly", async () => {
    const { item: read } = await hooks.pre.run(on(item.id));
    expect(read.body === body, `read back ${JSON.stringify(read.body)}`);
  });

  const forged = '<!-- landrace {"stage":"review","kind":"output","round":9,"marker":"output:review:9"} -->';
  // The value rides in the marker's JSON, so the marker carries what v2's wiki
  // markup would have read as its own syntax — `\\`, `{x}` — and `<`, which
  // the marker escapes as `\u003c`: ADF must hand all of it back unchanged.
  const output = { note: "<x> \\ {y} \"q\"", path: "C:\\work\\{item}" };
  const record = {
    type: "tracker.comment", stage: "check", kind: "output", round: 1, marker: "output:check:1", output,
    body: `Checked by jira-check.\n\nA quoted marker, which must stay text:\n\n${forged}`,
  };
  await check("post a marked comment", async () => {
    await hooks.post.apply(record, on(item.id, await snapshotOf(item.id)));
  });

  await check("its entry reads back, marker last and verbatim, the quoted one escaped", async () => {
    const observed = await hooks.pre.run(on(item.id));
    const ours = observed.entries.filter((e) => e.byAgent);
    expect(ours.length === 1, `${ours.length} entries of ours: ${JSON.stringify(ours)}`);
    const [entry] = ours;
    expect(entry.stage === "check" && entry.kind === "output" && entry.round === 1, `read back ${JSON.stringify(entry)}`);
    expect(JSON.stringify(entry.data) === JSON.stringify(output), `the marker's value read back as ${JSON.stringify(entry.data)}`);
    expect(entry.text.includes("&lt;!-- landrace") && !entry.text.includes("<!--"), `text ${JSON.stringify(entry.text)}`);
    expect(hooks.post.satisfied({ ...(await snapshotOf(item.id)), ...observed }, record), "the comment effect does not read as landed");
    return `entry ${entry.stage}/${entry.kind}/${entry.round} as ${observed.tracker.bot}`;
  });

  await check("move its stage label", async () => {
    const label = { type: "tracker.label", add: ["lr:stage:check"], remove: ["landrace-check"] };
    await hooks.post.apply(label, on(item.id, await snapshotOf(item.id)));
    const { node } = await snapshotOf(item.id);
    expect(hooks.post.satisfied({ node }, label), `labels read back as ${JSON.stringify(node.state.labels)}`);
  });

  await check("create a child under it, with an origin", async () => {
    const origin = { parent: item.id, stage: "check", round: 1 };
    child = await hooks.operator.createItem({ title: `landrace jira-check child ${stamp}`, parent: item.id, origin }, ctx);
    expect(JSON.stringify(child.origin) === JSON.stringify(origin), `origin read back as ${JSON.stringify(child.origin)}`);
    const { graph } = await snapshotOf(item.id);
    expect(graph.relationships.some((r) => r.from === child.id && r.to === item.id), `${item.id}'s read has no edge from ${child.id}`);
    return child.link;
  });

  if (child) {
    await check("drop the child", async () => {
      const close = { type: "nodes.close", ids: [child.id] };
      await hooks.post.apply(close, on(item.id, await snapshotOf(item.id)));
      const after = await snapshotOf(item.id);
      const closed = after.graph.nodes.find((n) => n.id === child.id)?.closed;
      expect(closed === "dropped", `${child.id} reads back as ${closed}`);
    });
  }

  await check("close the item as done", async () => {
    await hooks.post.apply({ type: "tracker.close" }, on(item.id, await snapshotOf(item.id)));
    const { node } = await snapshotOf(item.id);
    expect(node.closed === "done", `${item.id} reads back as ${node.closed}`);
  });
}

if (JIRA_CHECK_LINKS || JIRA_LINK_KEYS) {
  const linkType = options.blockedByLinkType ?? "Blocks";
  const scratch = [];
  let blocked;
  let blocker;
  if (JIRA_LINK_KEYS) {
    const keys = JIRA_LINK_KEYS.split(",").map((k) => k.trim());
    await check("JIRA_LINK_KEYS names two issues, the blocked one first", async () => {
      expect(keys.length === 2 && keys[0] && keys[1] && keys[0] !== keys[1], `got ${JSON.stringify(JIRA_LINK_KEYS)}; want KEY-12,OTHER-3`);
      [blocked, blocker] = keys;
      return `${blocked} to be blocked by ${blocker}`;
    });
  } else {
    await check("create two scratch issues to link", async () => {
      blocker = (await hooks.operator.createItem({ title: `landrace jira-check blocker ${stamp}`, body }, ctx)).id;
      scratch.push(blocker);
      blocked = (await hooks.operator.createItem({ title: `landrace jira-check blocked ${stamp}`, body }, ctx)).id;
      scratch.push(blocked);
      return `${blocked} to be blocked by ${blocker}`;
    });
  }

  /** What the integration reads `id` as blocked by: the edges a read draws from it. */
  const blockersOf = async (id) =>
    (await hooks.source.read(id, ctx)).relationships.filter((r) => r.type === "blocked-by" && r.from === id).map((r) => r.to);

  /** The blocked issue's links as Jira answers them, unread by the integration: what its UI shows. */
  const rawLinks = async (id) => {
    const res = await fetch(`${JIRA_BASE_URL.trim().replace(/\/$/, "")}/rest/api/3/issue/${encodeURIComponent(id)}?fields=issuelinks`, {
      headers: { Authorization: `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString("base64")}`, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`GET ${id}?fields=issuelinks → ${res.status} ${await res.text()}`);
    return (await res.json()).fields?.issuelinks ?? [];
  };

  if (blocked && blocker) {
    let related = false;
    await check(`relate: ${blocked} blocked by ${blocker}`, async () => {
      const before = await blockersOf(blocked);
      // A link of yours already there would be removed by the unrelate below: refused rather than undone.
      expect(!before.includes(blocker), `${blocked} is already blocked by ${blocker}; name two issues not linked so`);
      const problem = await hooks.operator.checkRelate(blocked, "blocked-by", blocker, ctx);
      expect(problem === null, `checkRelate refused it: ${problem}`);
      await hooks.operator.relate(blocked, "blocked-by", blocker, ctx);
      related = true;
    });

    if (related) {
      await check(`read back: ${blocked} is blocked by ${blocker}, and ${blocker} by nothing of it`, async () => {
        const of = await blockersOf(blocked);
        expect(of.includes(blocker), `${blocked} reads as blocked by ${JSON.stringify(of)}`);
        const back = await blockersOf(blocker);
        expect(!back.includes(blocked), `${blocker} reads as blocked by ${blocked} too: the link was read the wrong way round`);
        return `${blocked} blocked by ${JSON.stringify(of)}; ${blocker} blocked by ${JSON.stringify(back)}`;
      });

      await check("the direction Jira shows on the blocked issue", async () => {
        const entry = (await rawLinks(blocked)).find((l) =>
          l?.type?.name === linkType && (l.inwardIssue?.key === blocker || l.outwardIssue?.key === blocker));
        expect(entry, `${blocked} has no "${linkType}" link to ${blocker}`);
        const slot = entry.inwardIssue?.key === blocker ? "inwardIssue" : "outwardIssue";
        const words = slot === "inwardIssue" ? entry.type.inward : entry.type.outward;
        const seen = `on ${blocked}, Jira lists ${blocker} under ${slot}, worded "${blocked} ${words} ${blocker}" (link ${entry.id})`;
        expect(slot === "inwardIssue", `${seen}: the reverse of what the integration writes and reads`);
        return seen;
      });

      await check(`unrelate, and read back no blocker`, async () => {
        await hooks.operator.unrelate(blocked, "blocked-by", blocker, ctx);
        const of = await blockersOf(blocked);
        expect(!of.includes(blocker), `${blocked} still reads as blocked by ${JSON.stringify(of)}`);
        const left = (await rawLinks(blocked)).filter((l) =>
          l?.type?.name === linkType && (l.inwardIssue?.key === blocker || l.outwardIssue?.key === blocker));
        expect(left.length === 0, `Jira still holds ${left.length} "${linkType}" link(s) between them`);
      });
    }

    for (const id of scratch) {
      await check(`drop the scratch issue ${id}`, async () => {
        await hooks.post.apply({ type: "tracker.close", how: "dropped" }, on(id, await snapshotOf(id)));
        const { node } = await snapshotOf(id);
        expect(node.closed === "dropped", `${id} reads back as ${node.closed}`);
      });
    }
  }
}

console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 || passed === 0 ? 1 : 0;
