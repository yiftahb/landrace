/*
 * Jira Cloud's REST v3, as much of it as the Jira integration calls, behind a
 * `fetchImpl` — every answer in the shape Atlassian documents it, so the
 * integration is tested over its own HTTP boundary and nothing of it is
 * imitated. Times are Jira's: a local offset, `+0300`, never `Z`.
 *
 * Only the JQL the integration writes is understood; anything else is a 400,
 * as Jira answers a query it cannot parse, so a query that drifts fails here
 * rather than quietly matching everything.
 */

export interface FakeUser { accountId: string; displayName: string }

/** The account the token belongs to: who landrace posts as. */
export const BOT: FakeUser = { accountId: "5b10ac8d82e05b22cc7d4ef5", displayName: "landrace" };
/** A person on the project. */
export const PERSON: FakeUser = { accountId: "557058:f58131cb-b67d-43c7-b30d-6b58d40bd077", displayName: "Mia Krystof" };

export const SITE = "https://acme.atlassian.net";
export const EMAIL = "landrace@acme.example";
export const TOKEN = "ATATT3xFfGF0-fake-api-token-0123456789";

/** An ADF node, as loosely as Jira itself accepts one. */
export interface Adf { type: string; text?: string; attrs?: Record<string, unknown>; content?: Adf[]; version?: number }

interface Status { id: string; name: string; category: "new" | "indeterminate" | "done" }

export const STATUSES: Record<string, Status> = {
  "To Do": { id: "10000", name: "To Do", category: "new" },
  "In Progress": { id: "3", name: "In Progress", category: "indeterminate" },
  Done: { id: "10001", name: "Done", category: "done" },
  "Won't Do": { id: "10002", name: "Won't Do", category: "done" },
};

const CATEGORIES = {
  new: { id: 2, key: "new", colorName: "blue-gray", name: "To Do" },
  indeterminate: { id: 4, key: "indeterminate", colorName: "yellow", name: "In Progress" },
  done: { id: 3, key: "done", colorName: "green", name: "Done" },
} as const;

export interface FakeTransition { id: string; name: string; to: string }

export interface FakeComment { id: string; author: FakeUser; body: Adf; created: string }

export interface FakeIssue {
  id: string;
  key: string;
  summary: string;
  description: Adf | null;
  status: string;
  resolution: string | null;
  labels: string[];
  assignee: FakeUser | null;
  creator: FakeUser;
  reporter: FakeUser;
  created: string;
  updated: string;
  statusChanged: string;
  parent: string | null;
  priority: string | null;
  issuetype: string;
  comments: FakeComment[];
  /** Description changes, oldest first: what `changelog/bulkfetch` answers from. */
  history: Array<{ id: string; author: FakeUser; created: string }>;
}

export interface FakeIssueType { id: string; name: string; subtask: boolean; fields: string[] }

export interface FakeLinkType { id: string; name: string; inward: string; outward: string }

/**
 * One issue link, its two ends named by the slot `POST /issueLink` sent each
 * in. Jira gives the type's outward words to the issue sent as `inwardIssue`:
 * of "Blocks", `inward` blocks `outward` — `outward` is blocked by `inward`.
 */
export interface FakeLink { id: string; type: string; inward: string; outward: string }

export const MINUTE = 60_000;
export const DAY = 86_400_000;

/** Epoch ms as Jira writes it: local time at +03:00, with the offset spelled `+0300`. */
export const jiraTime = (ms: number): string =>
  new Date(ms + 3 * 3_600_000).toISOString().replace("Z", "+0300");

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

const noContent = (): Response => new Response(null, { status: 204 });

const errors = (status: number, errorMessages: string[], fieldErrors: Record<string, string> = {}): Response =>
  json({ errorMessages, errors: fieldErrors }, status);

const user = (u: FakeUser) => ({
  self: `${SITE}/rest/api/3/user?accountId=${u.accountId}`,
  accountId: u.accountId,
  avatarUrls: { "48x48": "https://avatar-management.example/48.png" },
  displayName: u.displayName,
  active: true,
  timeZone: "Asia/Jerusalem",
  accountType: "atlassian",
});

const statusJson = (name: string) => {
  const s = STATUSES[name] as Status;
  return {
    self: `${SITE}/rest/api/3/status/${s.id}`,
    description: "",
    iconUrl: `${SITE}/images/icons/statuses/generic.png`,
    name: s.name,
    untranslatedName: s.name,
    id: s.id,
    statusCategory: { self: `${SITE}/rest/api/3/statuscategory/${CATEGORIES[s.category].id}`, ...CATEGORIES[s.category] },
  };
};

const PERMISSION_NAMES: Record<string, string> = {
  BROWSE_PROJECTS: "Browse Projects",
  CREATE_ISSUES: "Create Issues",
  EDIT_ISSUES: "Edit Issues",
  TRANSITION_ISSUES: "Transition Issues",
  ADD_COMMENTS: "Add Comments",
  LINK_ISSUES: "Link Issues",
};

/** One ADF paragraph of plain text, the way a person's comment arrives. */
export const paragraphs = (...texts: string[]): Adf => ({
  type: "doc",
  version: 1,
  content: texts.map((text) => ({ type: "paragraph", content: text === "" ? [] : [{ type: "text", text }] })),
});

export function createFakeJira(project = "KEY") {
  let clock = Date.now() - DAY;
  const tick = (): string => jiraTime((clock += 1000));
  let nextId = 10_000;
  let nextNumber = 1;
  let nextComment = 100_000;
  let nextHistory = 50_000;
  let nextLink = 20_000;

  const issues = new Map<string, FakeIssue>();
  const moved = new Map<string, string>();
  /** Issues search has not indexed yet: it finds them only when asked to reconcile them. */
  const unindexed = new Set<string>();
  const calls: Array<{ method: string; path: string; body: unknown }> = [];

  const fake = {
    calls,
    issues,
    /** Who the token is; set to null to have Jira refuse it. */
    me: BOT as FakeUser | null,
    /** The page Jira cuts every list at, whatever was asked for. */
    pageSize: 100,
    /**
     * Search is eventually consistent: on, an issue created through the API
     * is missing from `search/jql` until a search names it in `reconcileIssues`.
     */
    indexLag: false,
    permissions: Object.fromEntries(Object.keys(PERMISSION_NAMES).map((k) => [k, true])) as Record<string, boolean>,
    issueTypes: [
      { id: "10001", name: "Task", subtask: false, fields: ["summary", "issuetype", "project", "description", "labels", "priority"] },
      { id: "10002", name: "Subtask", subtask: true, fields: ["summary", "issuetype", "project", "parent", "description", "labels", "priority"] },
      { id: "10003", name: "Bug", subtask: false, fields: ["summary", "issuetype", "project", "description"] },
    ] as FakeIssueType[],
    priorities: [
      { id: "1", name: "Highest" }, { id: "2", name: "High" }, { id: "3", name: "Medium" },
      { id: "4", name: "Low" }, { id: "5", name: "Lowest" },
    ],
    /** Offered from every status but the one an issue is in. */
    transitions: [
      { id: "11", name: "To Do", to: "To Do" },
      { id: "21", name: "In Progress", to: "In Progress" },
      { id: "31", name: "Done", to: "Done" },
      { id: "41", name: "Won't Do", to: "Won't Do" },
    ] as FakeTransition[],
    /** The site's link types, as `GET /issueLinkType` lists them: Jira Cloud's defaults. */
    linkTypes: [
      { id: "10000", name: "Blocks", inward: "is blocked by", outward: "blocks" },
      { id: "10001", name: "Cloners", inward: "is cloned by", outward: "clones" },
      { id: "10002", name: "Duplicate", inward: "is duplicated by", outward: "duplicates" },
      { id: "10003", name: "Relates", inward: "relates to", outward: "relates to" },
    ] as FakeLinkType[],
    links: [] as FakeLink[],
    /** Off, the site has issue linking disabled: every issueLink endpoint answers 404, as Jira documents. */
    linking: true,
    /**
     * Off, the account lacks "Link issues": a link write answers 404, which
     * is what Jira documents for that refusal, not a 403.
     */
    canLink: true,
    /** A status to answer a request with instead of its own answer, when it returns one: a refusal, a fault. */
    failOn: null as ((method: string, path: string) => number | null) | null,
    /** Issues `issue/bulkfetch` leaves out of its answer, as Jira does one gone or one the account may not see. */
    unreturned: new Set<string>(),
    /** Issues `issue/bulkfetch` names in `issueErrors` instead: a retriable failure, or a payload limit. */
    retriable: new Set<string>(),

    /** A link a person made in Jira's UI, its ends in the slots `POST /issueLink` takes them in. */
    link(type: string, inward: string, outward: string): FakeLink {
      const made = { id: String(nextLink++), type, inward, outward };
      fake.links.push(made);
      return made;
    },

    /** An issue as a person on the project would have filed it. */
    add(seed: Partial<FakeIssue> = {}): FakeIssue {
      const at = tick();
      const issue: FakeIssue = {
        id: String(nextId++),
        key: `${project}-${nextNumber++}`,
        summary: "An issue",
        description: null,
        status: "To Do",
        resolution: null,
        labels: [],
        assignee: null,
        creator: PERSON,
        reporter: PERSON,
        created: at,
        updated: at,
        statusChanged: at,
        parent: null,
        priority: "3",
        issuetype: "Task",
        comments: [],
        history: [],
        ...seed,
      };
      issues.set(issue.key, issue);
      return issue;
    },

    issue(key: string): FakeIssue {
      const issue = issues.get(key);
      if (!issue) throw new Error(`the fake has no ${key}`);
      return issue;
    },

    /** A person's comment, in whatever ADF they wrote it in. */
    say(key: string, author: FakeUser, body: Adf): void {
      const issue = fake.issue(key);
      issue.comments.push({ id: String(nextComment++), author, body, created: tick() });
    },

    /** A person rewrites the description in Jira's editor. */
    edit(key: string, author: FakeUser, description: Adf): void {
      const issue = fake.issue(key);
      issue.description = description;
      issue.updated = tick();
      issue.history.push({ id: String(nextHistory++), author, created: issue.updated });
    },

    /** Moved to another project: Jira answers the old key with the issue under its new one, links included. */
    move(key: string, to: string): void {
      const issue = fake.issue(key);
      issues.delete(key);
      issue.key = to;
      issues.set(to, issue);
      moved.set(key, to);
      for (const l of fake.links) {
        if (l.inward === key) l.inward = to;
        if (l.outward === key) l.outward = to;
      }
    },

    /** Only the requests that change something. */
    writes: () => calls.filter((c) => c.method !== "GET" && !c.path.startsWith("/rest/api/3/search/jql") &&
      !c.path.startsWith("/rest/api/3/changelog/bulkfetch") && !c.path.startsWith("/rest/api/3/issue/bulkfetch")),

    fetchImpl: (async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, path: url.pathname + url.search, body });
      if (url.origin !== SITE) throw new Error(`the fake answers only ${SITE}, not ${url.origin}`);
      const auth = new Headers(init?.headers).get("Authorization");
      if (fake.me === null || auth !== `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64")}`) {
        return new Response("Client must be authenticated to access this resource.", { status: 401 });
      }
      const forced = fake.failOn?.(method, url.pathname);
      if (forced !== null && forced !== undefined) return errors(forced, [`the fake was told to answer ${method} ${url.pathname} with ${forced}`]);
      return route(method, url, body);
    }) as unknown as typeof fetch,
  };

  const visible = (key: string): FakeIssue | undefined => issues.get(moved.get(key) ?? key);

  const linkTypeJson = (t: FakeLinkType) => ({ id: t.id, name: t.name, inward: t.inward, outward: t.outward, self: `${SITE}/rest/api/3/issueLinkType/${t.id}` });

  /** The other end of a link, as an issue's `issuelinks` names it: key, and the few fields Jira carries — no resolution. */
  const linkedJson = (key: string) => {
    const other = fake.issue(key);
    return {
      id: other.id,
      key: other.key,
      self: `${SITE}/rest/api/3/issue/${other.id}`,
      fields: {
        summary: other.summary,
        status: statusJson(other.status),
        priority: { self: `${SITE}/rest/api/3/priority/${other.priority ?? "3"}`, iconUrl: `${SITE}/images/icons/priorities/medium.svg`, name: "Medium", id: other.priority ?? "3" },
        issuetype: { id: "10001", name: other.issuetype, subtask: other.issuetype === "Subtask" },
      },
    };
  };

  /**
   * An issue's links, each with the other end in the slot it was sent in:
   * the blocked issue (sent as `outwardIssue`) carries its blocker under
   * `inwardIssue`, which Atlassian says to label with the type's inward
   * words — "is blocked by".
   */
  const linksJson = (issue: FakeIssue) => fake.links.flatMap((l) => {
    const type = fake.linkTypes.find((t) => t.name === l.type);
    if (!type) return [];
    const at = { id: l.id, self: `${SITE}/rest/api/3/issueLink/${l.id}`, type: linkTypeJson(type) };
    return [
      ...(l.outward === issue.key ? [{ ...at, inwardIssue: linkedJson(l.inward) }] : []),
      ...(l.inward === issue.key ? [{ ...at, outwardIssue: linkedJson(l.outward) }] : []),
    ];
  });

  /** An issue as the search and the issue endpoints answer it: only the fields asked for. */
  const issueJson = (issue: FakeIssue, fields: string[]) => {
    const all: Record<string, unknown> = {
      summary: issue.summary,
      status: statusJson(issue.status),
      resolution: issue.resolution === null ? null : {
        self: `${SITE}/rest/api/3/resolution/1`, id: "1", description: "", name: issue.resolution,
      },
      labels: issue.labels,
      assignee: issue.assignee === null ? null : user(issue.assignee),
      creator: user(issue.creator),
      reporter: user(issue.reporter),
      description: issue.description,
      created: issue.created,
      updated: issue.updated,
      statuscategorychangedate: issue.statusChanged,
      priority: issue.priority === null ? null : {
        self: `${SITE}/rest/api/3/priority/${issue.priority}`,
        iconUrl: `${SITE}/images/icons/priorities/medium.svg`,
        name: fake.priorities.find((p) => p.id === issue.priority)?.name ?? "?",
        id: issue.priority,
      },
      issuetype: { id: "10001", name: issue.issuetype, subtask: issue.issuetype === "Subtask" },
      issuelinks: linksJson(issue),
      // Read off the issue itself, so never behind the way search can be.
      subtasks: [...issues.values()]
        .filter((s) => s.parent === issue.key && fake.issueTypes.some((t) => t.name === s.issuetype && t.subtask))
        .map((s) => ({
          id: s.id, key: s.key, self: `${SITE}/rest/api/3/issue/${s.id}`,
          fields: { summary: s.summary, status: statusJson(s.status), issuetype: { name: s.issuetype, subtask: true } },
        })),
      ...(issue.parent === null ? {} : {
        parent: {
          id: issues.get(issue.parent)?.id ?? "99999",
          key: issue.parent,
          self: `${SITE}/rest/api/3/issue/${issue.parent}`,
          fields: { summary: issues.get(issue.parent)?.summary ?? "elsewhere" },
        },
      }),
    };
    return {
      expand: "renderedFields,names,schema,operations,editmeta,changelog,versionedRepresentations",
      id: issue.id,
      self: `${SITE}/rest/api/3/issue/${issue.id}`,
      key: issue.key,
      fields: Object.fromEntries(fields.filter((f) => f in all).map((f) => [f, all[f]])),
    };
  };

  /** The JQL the integration writes, clause by clause; anything else is Jira's 400. */
  const matcher = (jql: string): ((issue: FakeIssue) => boolean) | null => {
    const [where = "", order] = jql.split(" ORDER BY ");
    if (order !== undefined && !/^(created|updated) (ASC|DESC)$/.test(order)) return null;
    const tests: Array<(issue: FakeIssue) => boolean> = [];
    for (const clause of where.split(" AND ")) {
      let m: RegExpExecArray | null;
      if ((m = /^project = "([A-Z][A-Z0-9_]*)"$/.exec(clause))) {
        const p = m[1] as string;
        tests.push((i) => i.key.startsWith(`${p}-`));
      } else if (clause === "statusCategory != Done") {
        tests.push((i) => STATUSES[i.status]?.category !== "done");
      } else if (clause === "statusCategory = Done") {
        tests.push((i) => STATUSES[i.status]?.category === "done");
      } else if ((m = /^updated >= -([0-9]+)m$/.exec(clause))) {
        const since = Date.now() - Number(m[1]) * MINUTE;
        tests.push((i) => Date.parse(i.updated) >= since);
      } else if ((m = /^parent = "([A-Z][A-Z0-9_]*-[0-9]+)"$/.exec(clause))) {
        const parent = m[1] as string;
        tests.push((i) => i.parent === parent);
      } else {
        return null;
      }
    }
    return (issue) => tests.every((t) => t(issue));
  };

  /** One page and the token for the next, as Jira's token-paged endpoints answer. */
  const page = <T>(all: T[], token: unknown, asked: unknown): { items: T[]; next: string | null } => {
    const start = typeof token === "string" ? Number(token.replace("page-", "")) : 0;
    const size = Math.min(typeof asked === "number" ? asked : 50, fake.pageSize);
    const items = all.slice(start, start + size);
    return { items, next: start + size < all.length ? `page-${start + size}` : null };
  };

  const transitionsOf = (issue: FakeIssue) => fake.transitions.filter((t) => t.to !== issue.status);

  function route(method: string, url: URL, body: unknown): Response {
    const path = url.pathname;
    const q = url.searchParams;
    const b = (body ?? {}) as Record<string, unknown>;
    let m: RegExpExecArray | null;

    if (method === "GET" && path === "/rest/api/3/myself") {
      return json({ ...user(fake.me as FakeUser), emailAddress: EMAIL, locale: "en_US", groups: { size: 1, items: [] } });
    }

    if (method === "GET" && path === "/rest/api/3/mypermissions") {
      const keys = (q.get("permissions") ?? "").split(",").filter(Boolean);
      if (keys.length === 0) return errors(400, ["The permissions parameter is required."]);
      const permissions: Record<string, unknown> = {};
      for (const key of keys) {
        if (!(key in PERMISSION_NAMES)) return errors(400, [`Invalid permission key: ${key}`]);
        permissions[key] = {
          id: String(Object.keys(PERMISSION_NAMES).indexOf(key) + 10), key, name: PERMISSION_NAMES[key],
          type: "PROJECT", description: "", havePermission: fake.permissions[key] === true,
        };
      }
      return json({ permissions });
    }

    if (method === "GET" && (m = /^\/rest\/api\/3\/issue\/createmeta\/([^/]+)\/issuetypes(?:\/([^/]+))?$/.exec(path))) {
      if (m[1] !== project) return errors(404, ["No project could be found with key or id '" + m[1] + "'."]);
      const startAt = Number(q.get("startAt") ?? 0);
      const maxResults = Math.min(Number(q.get("maxResults") ?? 50), fake.pageSize);
      if (m[2] === undefined) {
        const issueTypes = fake.issueTypes.slice(startAt, startAt + maxResults).map((t) => ({
          self: `${SITE}/rest/api/3/issuetype/${t.id}`, id: t.id, description: "", iconUrl: `${SITE}/icon.svg`,
          name: t.name, untranslatedName: t.name, subtask: t.subtask, hierarchyLevel: t.subtask ? -1 : 0,
        }));
        return json({ maxResults, startAt, total: fake.issueTypes.length, issueTypes });
      }
      const type = fake.issueTypes.find((t) => t.id === m?.[2]);
      if (!type) return errors(404, ["Issue type with id '" + m[2] + "' does not exist."]);
      const fields = type.fields.slice(startAt, startAt + maxResults).map((id) => ({
        required: id === "summary" || id === "issuetype" || id === "project",
        schema: { type: id === "labels" ? "array" : "string", system: id },
        name: id[0]?.toUpperCase() + id.slice(1), key: id, fieldId: id, hasDefaultValue: false, operations: ["set"],
      }));
      return json({ maxResults, startAt, total: type.fields.length, fields });
    }

    if (method === "GET" && path === `/rest/api/3/project/${project}`) {
      return json({ self: `${SITE}/rest/api/3/project/10000`, id: "10000", key: project, name: "Acme", projectTypeKey: "software", simplified: false, style: "classic" });
    }

    if (method === "GET" && path === "/rest/api/3/priority/search") {
      if (q.getAll("projectId").join() !== "10000") return errors(400, ["projectId must name the project"]);
      const values = fake.priorities.map((p, i) => ({
        self: `${SITE}/rest/api/3/priority/${p.id}`, statusColor: "#cfcfcf", description: p.name,
        iconUrl: `${SITE}/images/icons/priorities/${p.name.toLowerCase()}.svg`, name: p.name, id: p.id, isDefault: i === 2,
      }));
      return json({ self: `${SITE}/rest/api/3/priority/search`, maxResults: 50, startAt: 0, total: values.length, isLast: true, values });
    }

    if (method === "POST" && path === "/rest/api/3/search/jql") {
      const matches = typeof b.jql === "string" ? matcher(b.jql) : null;
      if (!matches) return errors(400, [`Error in the JQL Query: ${String(b.jql)}`]);
      const fields = Array.isArray(b.fields) ? (b.fields as string[]) : [];
      const reconcile = b.reconcileIssues ?? [];
      if (!Array.isArray(reconcile) || reconcile.length > 50 || !reconcile.every((n) => typeof n === "number")) {
        return errors(400, ["reconcileIssues takes at most 50 issue ids, as numbers"]);
      }
      const indexed = (i: FakeIssue): boolean => !unindexed.has(i.key) || reconcile.includes(Number(i.id));
      const [, field = "created", direction = "ASC"] = /ORDER BY (created|updated) (ASC|DESC)$/.exec(String(b.jql)) ?? [];
      const at = (i: FakeIssue): number => Date.parse(field === "updated" ? i.updated : i.created);
      const found = [...issues.values()].filter((i) => indexed(i) && matches(i))
        .sort((x, y) => (direction === "DESC" ? -1 : 1) * (at(x) - at(y)) || Number(x.id) - Number(y.id));
      const { items, next } = page(found, b.nextPageToken, b.maxResults);
      return json({ issues: items.map((i) => issueJson(i, fields)), ...(next === null ? {} : { nextPageToken: next }), isLast: next === null });
    }

    if (method === "POST" && path === "/rest/api/3/changelog/bulkfetch") {
      const asked = new Set(Array.isArray(b.issueIdsOrKeys) ? (b.issueIdsOrKeys as string[]) : []);
      if (asked.size > 1000) return errors(400, ["You can request the changelogs of up to 1000 issues."]);
      const filtered = Array.isArray(b.fieldIds) && (b.fieldIds as string[]).includes("description");
      const changes = [...issues.values()]
        .filter((i) => asked.has(i.id) || asked.has(i.key))
        .flatMap((i) => (filtered ? i.history : []).map((h) => ({ issue: i, h })))
        .sort((x, y) => Date.parse(x.h.created) - Date.parse(y.h.created) || Number(x.issue.id) - Number(y.issue.id));
      const { items, next } = page(changes, b.nextPageToken, b.maxResults ?? 1000);
      const byIssue = new Map<string, unknown[]>();
      for (const { issue, h } of items) {
        const list = byIssue.get(issue.id) ?? [];
        list.push({
          id: h.id, author: user(h.author), created: h.created,
          items: [{ field: "description", fieldtype: "jira", fieldId: "description", from: null, fromString: "", to: null, toString: "" }],
        });
        byIssue.set(issue.id, list);
      }
      return json({
        issueChangeLogs: [...byIssue].map(([issueId, changeHistories]) => ({ issueId, changeHistories })),
        nextPageToken: next,
      });
    }

    /*
     * Documented: up to 1000 ids or keys when the fields are named, ascending
     * id order, a moved or differently cased key found all the same; one gone
     * or not permitted is left out of both lists, and one Jira could not
     * return for a reason that passes is in `issueErrors`.
     */
    if (method === "POST" && path === "/rest/api/3/issue/bulkfetch") {
      const asked = Array.isArray(b.issueIdsOrKeys) ? (b.issueIdsOrKeys as unknown[]).map(String) : null;
      const fields = Array.isArray(b.fields) ? (b.fields as string[]) : [];
      if (asked === null || asked.length > (fields.length > 0 ? 1000 : 100)) return errors(400, ["issueIdsOrKeys is required, and at most 1000 with named fields"]);
      const found = new Map<string, FakeIssue>();
      for (const one of asked) {
        const issue = [...issues.values()].find((i) => i.id === one) ?? visible(one.toUpperCase());
        if (issue && !fake.unreturned.has(issue.key)) found.set(issue.id, issue);
      }
      const all = [...found.values()].sort((x, y) => Number(x.id) - Number(y.id));
      return json({
        expand: "",
        issues: all.filter((i) => !fake.retriable.has(i.key)).map((i) => issueJson(i, fields)),
        issueErrors: all.filter((i) => fake.retriable.has(i.key)).map((i) => ({ id: i.id, errorMessage: "Retry the request later." })),
      });
    }

    if (method === "POST" && path === "/rest/api/3/issue") {
      const f = (b.fields ?? {}) as Record<string, { key?: string; name?: string; id?: string } | string | Adf | undefined>;
      if ((f.project as { key?: string } | undefined)?.key !== project) return errors(400, [], { project: "Specify a valid project ID or key" });
      const type = fake.issueTypes.find((t) => t.name === (f.issuetype as { name?: string } | undefined)?.name);
      if (!type) return errors(400, [], { issuetype: "Specify an issue type" });
      for (const field of Object.keys(f)) {
        if (!type.fields.includes(field)) return errors(400, [], { [field]: `Field '${field}' cannot be set. It is not on the appropriate screen, or unknown.` });
      }
      const parent = (f.parent as { key?: string } | undefined)?.key;
      if (type.subtask && parent === undefined) return errors(400, [], { parent: "Given parent work item does not belong to appropriate hierarchy." });
      if (parent !== undefined && !issues.has(parent)) return errors(400, [], { parent: "Parent not found" });
      const priority = (f.priority as { id?: string } | undefined)?.id;
      if (priority !== undefined && !fake.priorities.some((p) => p.id === priority)) return errors(400, [], { priority: "Specify a valid priority" });
      const me = fake.me as FakeUser;
      const issue = fake.add({
        summary: String(f.summary ?? ""),
        description: (f.description as Adf | undefined) ?? null,
        creator: me,
        reporter: me,
        issuetype: type.name,
        parent: parent ?? null,
        priority: priority ?? "3",
      });
      if (fake.indexLag) unindexed.add(issue.key);
      return json({ id: issue.id, key: issue.key, self: `${SITE}/rest/api/3/issue/${issue.id}` }, 201);
    }

    if ((m = /^\/rest\/api\/3\/issue\/([^/]+)(\/comment|\/transitions)?$/.exec(path))) {
      const issue = visible(decodeURIComponent(m[1] as string));
      if (!issue) return errors(404, ["Issue does not exist or you do not have permission to see it."]);
      const me = fake.me as FakeUser;

      if (m[2] === undefined && method === "GET") {
        return json(issueJson(issue, (q.get("fields") ?? "").split(",")));
      }

      if (m[2] === undefined && method === "PUT") {
        const f = (b.fields ?? {}) as Record<string, unknown>;
        for (const field of Object.keys(f)) {
          if (field !== "summary" && field !== "description") return errors(400, [], { [field]: `Field '${field}' cannot be set.` });
        }
        if (typeof f.summary === "string") issue.summary = f.summary;
        if (f.description !== undefined) {
          issue.description = f.description as Adf;
          issue.history.push({ id: String(nextHistory++), author: me, created: tick() });
        }
        const ops = ((b.update ?? {}) as { labels?: Array<{ add?: string; remove?: string }> }).labels ?? [];
        for (const op of ops) {
          if (op.add !== undefined) {
            if (/\s/.test(op.add)) return errors(400, [], { labels: "The label 'x y' contains spaces which is invalid." });
            if (!issue.labels.includes(op.add)) issue.labels.push(op.add);
          }
          if (op.remove !== undefined) issue.labels = issue.labels.filter((l) => l !== op.remove);
        }
        issue.updated = tick();
        return noContent();
      }

      if (m[2] === "/comment" && method === "GET") {
        const startAt = Number(q.get("startAt") ?? 0);
        const maxResults = Math.min(Number(q.get("maxResults") ?? 5000), fake.pageSize);
        const comments = issue.comments.slice(startAt, startAt + maxResults).map((c) => ({
          self: `${SITE}/rest/api/3/issue/${issue.id}/comment/${c.id}`, id: c.id, author: user(c.author), body: c.body,
          updateAuthor: user(c.author), created: c.created, updated: c.created, jsdPublic: true,
        }));
        return json({ startAt, maxResults, total: issue.comments.length, comments });
      }

      if (m[2] === "/comment" && method === "POST") {
        const doc = b.body as Adf | undefined;
        const problem = adfProblem(doc);
        if (problem) return errors(400, [], { comment: problem });
        if (JSON.stringify(doc).length > 32_767) {
          return errors(400, [], { comment: "The entered text is too long. It exceeds the allowed limit of 32,767 characters." });
        }
        const comment = { id: String(nextComment++), author: me, body: doc as Adf, created: tick() };
        issue.comments.push(comment);
        return json({ self: `${SITE}/rest/api/3/issue/${issue.id}/comment/${comment.id}`, id: comment.id, author: user(me), body: comment.body, created: comment.created, updated: comment.created, jsdPublic: true }, 201);
      }

      if (m[2] === "/transitions" && method === "GET") {
        return json({
          expand: "transitions",
          transitions: transitionsOf(issue).map((t) => ({
            id: t.id, name: t.name, to: statusJson(t.to), hasScreen: false, isGlobal: true, isInitial: false,
            isAvailable: true, isConditional: false, isLooped: false,
          })),
        });
      }

      if (m[2] === "/transitions" && method === "POST") {
        const id = (b.transition as { id?: string } | undefined)?.id;
        const t = transitionsOf(issue).find((x) => x.id === id);
        if (!t) return errors(400, [`Transition id '${String(id)}' is not valid for this issue.`]);
        issue.status = t.to;
        issue.resolution = STATUSES[t.to]?.category === "done" ? t.to : null;
        issue.updated = issue.statusChanged = tick();
        return noContent();
      }
    }

    if (method === "GET" && path === "/rest/api/3/issueLinkType") {
      if (!fake.linking) return errors(404, ["Issue linking is disabled."]);
      return json({ issueLinkTypes: fake.linkTypes.map(linkTypeJson) });
    }

    /*
     * Documented: 201 with no body, and a duplicate of a link already there is
     * answered as created. A refusal of any kind — linking off, an issue the
     * account cannot see, no "Link issues", no such type — is a 404.
     */
    if (method === "POST" && path === "/rest/api/3/issueLink") {
      if (!fake.linking) return errors(404, ["Issue linking is disabled."]);
      const name = (b.type as { name?: unknown } | undefined)?.name;
      const type = fake.linkTypes.find((t) => t.name === name);
      if (!type) return errors(404, [`No issue link type with name '${String(name)}' found.`]);
      const inward = visible(String((b.inwardIssue as { key?: unknown } | undefined)?.key));
      const outward = visible(String((b.outwardIssue as { key?: unknown } | undefined)?.key));
      if (!inward || !outward) return errors(404, ["Issue does not exist or you do not have permission to see it."]);
      if (!fake.canLink) return errors(404, ["You do not have the permission to link issues."]);
      if (!fake.links.some((l) => l.type === type.name && l.inward === inward.key && l.outward === outward.key)) {
        fake.link(type.name, inward.key, outward.key);
      }
      return new Response(null, { status: 201 });
    }

    if (method === "DELETE" && (m = /^\/rest\/api\/3\/issueLink\/([^/]+)$/.exec(path))) {
      if (!fake.linking) return errors(404, ["Issue linking is disabled."]);
      const at = fake.links.findIndex((l) => l.id === m?.[1]);
      if (at === -1) return errors(404, [`No issue link with id '${m[1]}' exists.`]);
      if (!fake.canLink) return errors(404, ["You do not have the permission to link issues."]);
      fake.links.splice(at, 1);
      return noContent();
    }

    return errors(404, [`the fake has no ${method} ${path}`]);
  }

  return fake;
}

export type FakeJira = ReturnType<typeof createFakeJira>;

/** What Jira refuses in a document it is sent: a non-doc root, an empty text node, a block inside a paragraph. */
function adfProblem(doc: Adf | undefined): string | null {
  if (doc?.type !== "doc" || doc.version !== 1 || !Array.isArray(doc.content)) return "Comment body is not valid ADF";
  for (const block of doc.content) {
    if (block.type !== "paragraph") continue;
    for (const inline of block.content ?? []) {
      if (inline.type === "text" && !inline.text) return "INVALID_INPUT: text nodes must not be empty";
      if (inline.type !== "text" && inline.type !== "hardBreak") return `INVALID_INPUT: ${inline.type} in a paragraph`;
    }
  }
  return null;
}
