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
 * `JIRA_ASSIGNEE`, optional, is the `jiraAssignee` secret: an account id or
 * an email. Set, the item and child are created assigned to that account,
 * and two more checks list the project through the scoped open and Done
 * queries and find each there, assigned to that account: an email the script
 * looks up on its own, an account id it compares as given.
 *
 * `JIRA_FIELD`, optional, is a custom field's id, `customfield_10050`: the
 * docs role is then `JiraField` over it rather than an in-memory one, and the
 * item's spec is published to the field, read back, and found by the field's
 * listing. With `statuses` in `JIRA_OPTIONS`, the item is moved to the first
 * mapped stage and its Jira status read back.
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
 * that the first is blocked by the second — the blocker's side through
 * Jira's own answer, never a read of an issue in another project — prints
 * the slot and words Jira shows on each end, and checks the blocked issue's
 * own history, in Jira's words, against them; then it unrelates them and
 * reads back none. A run that fails partway names the link it left.
 */
import { Jira, JiraField } from "landrace/integrations/jira";
import { compose } from "landrace/kit";
import { MemoryDocs, MemoryForge } from "landrace/testing";

const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_TOKEN, JIRA_PROJECT, JIRA_OPTIONS, JIRA_CHECK_LINKS, JIRA_LINK_KEYS, JIRA_ASSIGNEE, JIRA_FIELD } = process.env;
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
  secrets: new Map([
    ["jiraBaseUrl", JIRA_BASE_URL], ["jiraEmail", JIRA_EMAIL], ["jiraToken", JIRA_TOKEN],
    ...(JIRA_ASSIGNEE ? [["jiraAssignee", JIRA_ASSIGNEE]] : []),
  ]),
  signal: new AbortController().signal,
  log: (event, data) => console.error(`${event} ${JSON.stringify(data ?? {})}`),
};
const field = JIRA_FIELD ? new JiraField({ project: JIRA_PROJECT, field: JIRA_FIELD }) : null;
const hooks = compose({ tracker: new Jira({ ...options, project: JIRA_PROJECT }), forge: new MemoryForge(), docs: field ?? new MemoryDocs() });

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
/** Tries `run` until it holds, for a search Jira's index has not caught up with yet: a read by key needs no wait, a listing does. */
const eventually = async (run, tries = 10) => {
  for (let i = 1; ; i++) {
    try {
      return await run();
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
};

const site = JIRA_BASE_URL.trim().replace(/\/$/, "");
/** Jira's own answers, unread by the integration. */
const raw = async (path) => {
  const res = await fetch(`${site}${path}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString("base64")}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${await res.text()}`);
  return res.json();
};
const assignee = JIRA_ASSIGNEE?.trim() ?? "";
// This script's own requests carry the token too: to the same sites the integration's client takes, and no other.
const siteOk = Boolean(JIRA_CHECK_LINKS || JIRA_LINK_KEYS || assignee.includes("@") || options.statuses) && await check("JIRA_BASE_URL is an https://<site>.atlassian.net site", async () => {
  expect(/^https:\/\/[a-z0-9][a-z0-9-]*\.atlassian\.net$/i.test(site), `got ${JSON.stringify(site)}`);
});
/** The account `JIRA_ASSIGNEE` names, looked up by this script rather than the integration, so the two are compared, not one read twice. */
let account = assignee.includes("@") ? null : assignee;
if (assignee.includes("@") && siteOk) {
  await check(`JIRA_ASSIGNEE ${assignee} is one Jira account`, async () => {
    const users = (await raw(`/rest/api/3/user/search?query=${encodeURIComponent(assignee)}`)).filter((u) => u.accountType === "atlassian" && u.accountId);
    expect(users.length === 1, `${users.length} users match: ${users.map((u) => u.accountId).join(", ")}`);
    account = users[0].accountId;
    return account;
  });
}
/** The listing's node for `id`, assigned to the account and nobody else, or a refusal saying what was listed. */
const listedAssigned = async (id) => {
  const node = (await hooks.source.list(ctx)).nodes.find((n) => n.id === id);
  expect(node, `${id} is not in the listing`);
  expect(JSON.stringify(node.state.assignees) === JSON.stringify([account]), `${id} is listed assigned to ${JSON.stringify(node.state.assignees)}, not ["${account}"]`);
  return node;
};
const snapshotOf = async (id) => {
  const graph = await hooks.source.read(id, ctx);
  return { graph, node: graph.nodes.find((n) => n.id === id) };
};

const stamp = new Date().toISOString();
const body = `Created by scripts/jira-check.mjs at ${stamp}.\nA second line, {braces} and a \\ backslash.`;
let item;
let child;

await check(`preflight: permissions, issue types, labels field${field ? `, ${JIRA_FIELD} on every edit screen` : ""}`, async () => {
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

  if (field) {
    const spec = `## Spec from jira-check\n\n- a list item with \`code\`\n\n\`\`\`js\nconst at = "${stamp}";\n\`\`\``;
    await check(`publish its spec to ${JIRA_FIELD}, and read it back`, async () => {
      const publish = { type: "artifact.publish", artifact: "spec", body: spec };
      await hooks.spec.apply(publish, on(item.id));
      const state = await hooks.spec.read(on(item.id));
      expect(state.exists === true, `${JIRA_FIELD} reads back empty`);
      expect(await field.page(item.id, ctx) === spec, `read back ${JSON.stringify(await field.page(item.id, ctx))}`);
      return state.url;
    });
    await check(`${JIRA_FIELD}'s listing finds ${item.id}`, () =>
      eventually(async () => expect((await field.published(ctx)).has(item.id), `${item.id} is not listed`)));
  }

  const [mapped] = Object.entries(options.statuses ?? {});
  if (mapped && siteOk) {
    const [stage, status] = mapped;
    await check(`move it to ${stage}: its status is "${status}"`, async () => {
      await hooks.post.apply({ type: "tracker.status", value: stage }, on(item.id, await snapshotOf(item.id)));
      const now = (await raw(`/rest/api/3/issue/${encodeURIComponent(item.id)}?fields=status`)).fields?.status?.name;
      expect(now?.toLowerCase() === status.toLowerCase(), `its status reads back as ${JSON.stringify(now)}`);
      return now;
    });
  }

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

  if (child && account) {
    await check(`the scoped listing holds ${item.id} and ${child.id}, each assigned to ${account}`, () =>
      eventually(async () => {
        await listedAssigned(item.id);
        await listedAssigned(child.id);
      }));
  }

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

  if (account) {
    await check(`the scoped Done lane holds ${item.id}, assigned to ${account}`, () =>
      eventually(async () => {
        const node = await listedAssigned(item.id);
        expect(node.closed === "done", `${item.id} is listed as ${node.closed}`);
      }));
  }
}

if (JIRA_CHECK_LINKS || JIRA_LINK_KEYS) {
  const linkType = options.blockedByLinkType ?? "Blocks";
  const scratch = [];
  let blocked;
  let blocker;
  if (siteOk && JIRA_LINK_KEYS) {
    const keys = JIRA_LINK_KEYS.split(",").map((k) => k.trim());
    await check("JIRA_LINK_KEYS names two issues, the blocked one first and the project's own", async () => {
      expect(keys.length === 2 && keys[0] && keys[1] && keys[0] !== keys[1], `got ${JSON.stringify(JIRA_LINK_KEYS)}; want KEY-12,OTHER-3`);
      expect(keys[0].startsWith(`${JIRA_PROJECT}-`), `${keys[0]} is not a ${JIRA_PROJECT} issue; the blocked one is the project's own`);
      [blocked, blocker] = keys;
      return `${blocked} to be blocked by ${blocker}`;
    });
  } else if (siteOk) {
    await check("create two scratch issues to link", async () => {
      blocker = (await hooks.operator.createItem({ title: `landrace jira-check blocker ${stamp}`, body }, ctx)).id;
      scratch.push(blocker);
      blocked = (await hooks.operator.createItem({ title: `landrace jira-check blocked ${stamp}`, body }, ctx)).id;
      scratch.push(blocked);
      return `${blocked} to be blocked by ${blocker}`;
    });
  }

  /** What the integration reads the blocked issue as blocked by: the edges a read draws from it. Never asked of the blocker, which may be in another project. */
  const blockersOf = async (id) =>
    (await hooks.source.read(id, ctx)).relationships.filter((r) => r.type === "blocked-by" && r.from === id).map((r) => r.to);

  /** An issue's links of the type to `to`, as Jira answers them: what its UI shows. */
  const linksBetween = async (id, to) => ((await raw(`/rest/api/3/issue/${encodeURIComponent(id)}?fields=issuelinks`)).fields?.issuelinks ?? [])
    .filter((l) => l?.type?.name === linkType && (l.inwardIssue?.key === to || l.outwardIssue?.key === to));

  if (blocked && blocker) {
    let related = false;
    /** The link this run made, by id, so a run that fails partway says what it left behind. */
    let made = null;
    await check(`relate: ${blocked} blocked by ${blocker}`, async () => {
      const before = await blockersOf(blocked);
      // A link of yours already there would be removed by the unrelate below: refused rather than undone.
      expect(!before.includes(blocker), `${blocked} is already blocked by ${blocker}; name two issues not linked so`);
      const had = new Set((await linksBetween(blocked, blocker)).map((l) => l.id));
      const problem = await hooks.operator.checkRelate(blocked, "blocked-by", blocker, ctx);
      expect(problem === null, `checkRelate refused it: ${problem}`);
      await hooks.operator.relate(blocked, "blocked-by", blocker, ctx);
      related = true;
      made = (await linksBetween(blocked, blocker)).find((l) => !had.has(l.id))?.id ?? null;
      return made === null ? "no new link to be seen yet" : `link ${made}`;
    });

    if (related) {
      await check(`read back through the integration: ${blocked} is blocked by ${blocker}`, async () => {
        const of = await blockersOf(blocked);
        expect(of.includes(blocker), `${blocked} reads as blocked by ${JSON.stringify(of)}`);
        return `${blocked} blocked by ${JSON.stringify(of)}`;
      });

      await check("the direction Jira shows on each end", async () => {
        const [onBlocked] = await linksBetween(blocked, blocker);
        expect(onBlocked, `${blocked} has no "${linkType}" link to ${blocker}`);
        const slot = onBlocked.inwardIssue?.key === blocker ? "inwardIssue" : "outwardIssue";
        const seen = `on ${blocked}, Jira lists ${blocker} under ${slot}, worded "${blocked} ${slot === "inwardIssue" ? onBlocked.type.inward : onBlocked.type.outward} ${blocker}"`;
        expect(slot === "inwardIssue", `${seen}: the reverse of what the integration writes and reads`);
        const [onBlocker] = await linksBetween(blocker, blocked);
        expect(onBlocker, `${blocker} has no "${linkType}" link to ${blocked}`);
        const back = onBlocker.outwardIssue?.key === blocked ? "outwardIssue" : "inwardIssue";
        expect(back === "outwardIssue", `on ${blocker}, Jira lists ${blocked} under ${back}: the reverse of what the integration reads`);
        return `${seen}; on ${blocker}, ${blocked} sits under outwardIssue, worded "${blocker} ${onBlocker.type.outward} ${blocked}"`;
      });

      // Not the slot-to-words rule the two checks above rest on: what Jira wrote in the blocked issue's history, in its own words.
      await check(`Jira's own history of ${blocked} says it is blocked by ${blocker}`, async () => {
        let latest = null;
        for (let startAt = 0, page = 0; page < 20; page++) {
          const res = await raw(`/rest/api/3/issue/${encodeURIComponent(blocked)}/changelog?startAt=${startAt}&maxResults=100`);
          for (const history of res.values ?? []) {
            for (const item of history.items ?? []) if (item.field === "Link" && item.to === blocker) latest = item.toString;
          }
          startAt += (res.values ?? []).length;
          if (res.isLast !== false || (res.values ?? []).length === 0) break;
        }
        expect(latest !== null, `no "Link" change to ${blocker} in ${blocked}'s history: look at ${site}/browse/${blocked} — it should say "is blocked by ${blocker}"`);
        const inward = (await raw("/rest/api/3/issueLinkType")).issueLinkTypes?.find((t) => t.name === linkType)?.inward ?? "is blocked by";
        expect(latest.toLowerCase().includes(inward.toLowerCase()), `${blocked}'s history says ${JSON.stringify(latest)}, not "${inward}"`);
        return JSON.stringify(latest);
      });

      await check("unrelate, and read back no blocker", async () => {
        await hooks.operator.unrelate(blocked, "blocked-by", blocker, ctx);
        const of = await blockersOf(blocked);
        const left = await linksBetween(blocked, blocker);
        const behind = made === null ? "" : `; remove link ${made} by hand`;
        expect(!of.includes(blocker), `${blocked} still reads as blocked by ${JSON.stringify(of)}${behind}`);
        expect(left.length === 0, `Jira still holds "${linkType}" link(s) ${left.map((l) => l.id).join(", ")} between them${behind}`);
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
