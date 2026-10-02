/*
 * Jira Cloud issues as a project's tracker: the JQL, the changelog that says
 * who last edited a body, the workflow's transitions, and the account's
 * permissions. Everything else a tracker does is `BaseTracker`'s — position
 * is still an `lr:stage:*` label, and Jira's status moves only to close an
 * item or reopen it.
 */
import { type Closed, type RuntimeContext, STAGE_LABEL_PREFIX, type ItemPatch } from "landrace/hooks";
import {
  BaseTracker, DONE_WINDOW_MS, ISSUE_PAGE, MAX_ISSUE_PAGES, ITEM_PAGE,
  type ItemRecord, type TrackerComment,
} from "landrace/kit";
import { type AdfDoc, fromAdf, toAdf } from "./adf.js";
import { type Client, clientFor, isMissing } from "./client.js";

export interface JiraOptions {
  /** The project's key: `KEY` in `KEY-12`. Only its issues are items. */
  project: string;
  /** What an item with no parent is created as. "Task" unless named. */
  issueType?: string | undefined;
  /** What a child is created as, under its parent: a sub-task type, "Subtask" unless named. */
  childType?: string | undefined;
  /**
   * The workflow's transitions that close an item as done ("Done") and as
   * dropped ("Won't Do"). A closed issue whose status or resolution carries
   * the dropped one's name reads as dropped.
   */
  transitions?: { done?: string | undefined; dropped?: string | undefined } | undefined;
  fetchImpl?: typeof fetch | undefined;
}

/** Jira's own bound on a comment or a description, counted on the document it is sent as. */
const MAX_ADF_CHARS = 32_767;

/** Every field an item is read from, asked for by name: a search returns ids alone unless told. */
const FIELDS = [
  "summary", "status", "resolution", "labels", "assignee", "creator", "description", "created", "updated",
  "statuscategorychangedate", "parent", "priority",
];

/** What the tracker does, as Jira's permission keys: read, create, label and edit, transition, comment. */
const PERMISSIONS = ["BROWSE_PROJECTS", "CREATE_ISSUES", "EDIT_ISSUES", "TRANSITION_ISSUES", "ADD_COMMENTS"];

/** Bulk changelog takes a thousand issues a request. */
const CHANGELOG_BATCH = 1000;

interface User { accountId?: string }
interface Status { name?: string; statusCategory?: { key?: string } }

/** An issue as search and `GET /issue` answer it, with `FIELDS`. */
interface Issue {
  id: string;
  key: string;
  fields: {
    summary?: string;
    status?: Status;
    resolution?: { name?: string } | null;
    labels?: string[];
    assignee?: User | null;
    creator?: User | null;
    description?: unknown;
    created?: string;
    updated?: string;
    statuscategorychangedate?: string;
    parent?: { key?: string };
    priority?: { id?: string } | null;
  };
}

interface Transition { id: string; name: string; to?: Status }

/** Jira answers names however they were typed; a status or transition is one name whatever its case. */
const same = (a: string | undefined, b: string): boolean => a?.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Every page of a create-metadata list: an issue type or a labels field past
 * the first page is there all the same. Documented as `issueTypes` and
 * `fields`; `values` read too, in case the site answers the other spelling.
 */
async function everyPage<T>(jira: Client, path: string): Promise<T[]> {
  const all: T[] = [];
  for (let page = 0; page < MAX_ISSUE_PAGES; page++) {
    const res = await jira.call<{ issueTypes?: T[]; fields?: T[]; values?: T[]; total?: number; isLast?: boolean }>(
      "GET", `${path}?startAt=${all.length}&maxResults=200`,
    );
    const batch = res.issueTypes ?? res.fields ?? res.values ?? [];
    all.push(...batch);
    if (batch.length === 0 || (res.isLast ?? all.length >= (res.total ?? 0))) return all;
  }
  throw new Error(`${path} has more than ${MAX_ISSUE_PAGES} pages; what it lacks cannot be read`);
}

/**
 * ISO 8601 in UTC. Jira answers in the site's offset — `+0300` — and the
 * engine orders `at` as strings, so two offsets would sort by wall clock
 * rather than by when.
 */
const iso = (at: string | undefined): string | undefined => {
  const ms = at === undefined ? NaN : Date.parse(at);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
};

const offeredList = (offered: Transition[]): string =>
  offered.map((t) => `"${t.name}" (to ${t.to?.name ?? "?"})`).join(", ") || "none";

/**
 * Jira Cloud issues, in one project, over one client per configuration —
 * built from the `jiraBaseUrl`, `jiraEmail` and `jiraToken` secrets.
 */
export class Jira extends BaseTracker {
  private readonly project: string;
  private readonly issueType: string;
  private readonly childType: string;
  private readonly done: string;
  private readonly dropped: string;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly keyPattern: RegExp;
  /** Each client's project priorities, highest first, read once. */
  private readonly priorities = new WeakMap<Client, string[]>();

  constructor({ project, issueType, childType, transitions, fetchImpl }: JiraOptions) {
    super();
    // Spelled into every JQL query and URL, so nothing but a key's own characters.
    if (!/^[A-Z][A-Z0-9_]+$/.test(project)) throw new Error(`project must be a Jira project key such as "KEY", got "${project}"`);
    this.project = project;
    this.issueType = issueType ?? "Task";
    this.childType = childType ?? "Subtask";
    this.done = transitions?.done ?? "Done";
    this.dropped = transitions?.dropped ?? "Won't Do";
    this.fetchImpl = fetchImpl;
    this.keyPattern = new RegExp(`^${project}-[1-9][0-9]*$`);
  }

  private jira(ctx: RuntimeContext): Client {
    return clientFor(ctx, this.fetchImpl);
  }

  /**
   * The engine's id as one of this project's keys, checked before it is put
   * in a URL or a query. Anything else is another tracker's item, or text
   * that would rewrite the request it was spelled into.
   */
  private keyOf(id: string): string {
    if (!this.keyPattern.test(id)) throw new Error(`"${id}" is not an issue of ${this.project}: only ${this.project}-<n> is`);
    return id;
  }

  /** A body as the document Jira takes — refused here, past Jira's bound, rather than by a 400 after the fact. */
  private adf(text: string, what: string): AdfDoc {
    const doc = toAdf(text);
    const size = JSON.stringify(doc).length;
    if (size > MAX_ADF_CHARS) throw new Error(`refusing to send a ${size}-character ${what}: Jira takes at most ${MAX_ADF_CHARS}`);
    return doc;
  }

  async login(ctx: RuntimeContext): Promise<string> {
    return this.jira(ctx).myself();
  }

  /**
   * Every issue a query finds, page by page — and whether the pages ran out
   * before it did. Search is eventually consistent; the ids in `reconcile`
   * (at most 50) are read as they are now rather than as the index has them.
   */
  private async search(jira: Client, jql: string, reconcile: number[] = []): Promise<{ issues: Issue[]; complete: boolean }> {
    const issues: Issue[] = [];
    let nextPageToken: string | undefined;
    for (let page = 0; page < MAX_ISSUE_PAGES; page++) {
      const res = await jira.call<{ issues?: Issue[]; nextPageToken?: string | null }>("POST", "/rest/api/3/search/jql", {
        jql, fields: FIELDS, maxResults: ISSUE_PAGE,
        ...(reconcile.length === 0 ? {} : { reconcileIssues: reconcile }),
        ...(nextPageToken === undefined ? {} : { nextPageToken }),
      });
      issues.push(...(res.issues ?? []));
      if (!res.nextPageToken) return { issues, complete: true };
      nextPageToken = res.nextPageToken;
    }
    return { issues, complete: false };
  }

  /**
   * Who last changed each issue's description, by issue id. The changelog
   * comes oldest first, so the last change seen is the latest. An unknown
   * author is "": somebody, and not us.
   */
  private async editors(jira: Client, ids: string[]): Promise<Map<string, string>> {
    const editors = new Map<string, string>();
    for (let i = 0; i < ids.length; i += CHANGELOG_BATCH) {
      let nextPageToken: string | undefined;
      for (let page = 0; ; page++) {
        // Past the bound the editor is unknown, and an unknown editor would read an edited origin as ours.
        if (page === MAX_ISSUE_PAGES) {
          throw new Error(`more description changes than ${MAX_ISSUE_PAGES} pages carry; who last edited a body cannot be told`);
        }
        const res = await jira.call<{
          issueChangeLogs?: Array<{ issueId?: string; changeHistories?: Array<{ author?: User; items?: Array<{ fieldId?: string }> }> }>;
          nextPageToken?: string | null;
        }>("POST", "/rest/api/3/changelog/bulkfetch", {
          issueIdsOrKeys: ids.slice(i, i + CHANGELOG_BATCH),
          fieldIds: ["description"],
          ...(nextPageToken === undefined ? {} : { nextPageToken }),
        });
        for (const log of res.issueChangeLogs ?? []) {
          for (const change of log.changeHistories ?? []) {
            if (log.issueId && change.items?.some((item) => item.fieldId === "description")) {
              editors.set(log.issueId, change.author?.accountId ?? "");
            }
          }
        }
        if (!res.nextPageToken) break;
        nextPageToken = res.nextPageToken;
      }
    }
    return editors;
  }

  /** The project's priorities, highest first: what landrace's 0..9 index into. */
  private async priorityIds(jira: Client): Promise<string[]> {
    const known = this.priorities.get(jira);
    if (known) return known;
    const { id } = await jira.call<{ id?: string }>("GET", `/rest/api/3/project/${this.project}`);
    const page = await jira.call<{ values?: Array<{ id?: string }>; isLast?: boolean }>(
      "GET", `/rest/api/3/priority/search?projectId=${encodeURIComponent(String(id))}&maxResults=100`,
    );
    // ponytail: one page of a hundred; a scheme past that is not one anybody ranks by.
    if (page.isLast === false) throw new Error(`${this.project} has more priorities than one page carries`);
    const ids = (page.values ?? []).flatMap((p) => (typeof p.id === "string" ? [p.id] : []));
    this.priorities.set(jira, ids);
    return ids;
  }

  /**
   * Done once the status is in Jira's done category, whatever it is called —
   * a closure nobody named still counts — and dropped when the status or the
   * resolution carries the dropped transition's name.
   */
  private closedOf({ status, resolution }: Issue["fields"]): Closed {
    if (status?.statusCategory?.key !== "done") return null;
    return same(status.name, this.dropped) || same(resolution?.name ?? undefined, this.dropped) ? "dropped" : "done";
  }

  /** Issues as the kit reads items, with their editors and priorities. */
  private async records(jira: Client, issues: Issue[]): Promise<ItemRecord[]> {
    if (issues.length === 0) return [];
    const editors = await this.editors(jira, issues.map((i) => i.id));
    const priorities = await this.priorityIds(jira);
    return issues.map(({ id, key, fields }) => {
      const parent = fields.parent?.key;
      const priority = fields.priority?.id === undefined ? -1 : priorities.indexOf(fields.priority.id);
      return {
        id: key,
        title: fields.summary ?? "",
        link: `${jira.baseUrl}/browse/${key}`,
        closed: this.closedOf(fields),
        labels: fields.labels ?? [],
        assignees: fields.assignee?.accountId ? [fields.assignee.accountId] : [],
        body: fromAdf(fields.description),
        // The creator, not the reporter: anyone who may edit an issue may change its reporter.
        author: fields.creator?.accountId,
        // Whoever last changed the description, so an origin a person edited reads as nobody's.
        editor: editors.get(id),
        createdAt: iso(fields.created),
        updatedAt: iso(fields.updated),
        // A parent in another project is no item of this tracker's.
        parent: parent !== undefined && this.keyPattern.test(parent) ? parent : null,
        priority: priority === -1 ? null : priority,
      };
    });
  }

  /**
   * Every open issue in the project, and the Done lane's: issues landrace
   * moved — an `lr:stage:*` label says so — that closed inside the window.
   * That second list is for the board, not the loop, so past its bound it
   * stops quietly rather than failing the tick.
   */
  async items(ctx: RuntimeContext): Promise<ItemRecord[]> {
    const jira = this.jira(ctx);
    const open = await this.search(jira, `project = "${this.project}" AND statusCategory != Done ORDER BY created ASC`);
    if (!open.complete) throw new Error(`${this.project} has more open issues than ${MAX_ISSUE_PAGES} pages carry`);
    const since = Date.now() - DONE_WINDOW_MS;
    const closed = await this.search(
      jira,
      `project = "${this.project}" AND statusCategory = Done AND updated >= -${Math.ceil(DONE_WINDOW_MS / 60_000)}m ORDER BY updated DESC`,
    );
    const done = closed.issues.filter((i) =>
      Date.parse(i.fields.statuscategorychangedate ?? "") >= since &&
      (i.fields.labels ?? []).some((l) => l.startsWith(STAGE_LABEL_PREFIX)));
    // By key, once: an issue closed between the two queries is in both.
    return this.records(jira, [...new Map([...open.issues, ...done].map((i) => [i.key, i])).values()]);
  }

  async item(id: string, ctx: RuntimeContext): Promise<ItemRecord> {
    const key = this.keyOf(id);
    const jira = this.jira(ctx);
    let issue: Issue;
    try {
      issue = await jira.call<Issue>("GET", `/rest/api/3/issue/${key}?fields=${FIELDS.join(",")}`);
    } catch (e) {
      if (isMissing(e)) throw new Error(`${key} is not an issue in ${this.project}, or this account cannot see it`);
      throw e;
    }
    // Jira answers a moved issue's old key with the issue under its new one.
    // The engine's id would then name an issue it no longer is: refused.
    if (issue.key !== key) throw new Error(`${key} has moved to ${issue.key}; landrace will not follow an issue to a new key`);
    const [record] = await this.records(jira, [issue]);
    if (!record) throw new Error(`${key} could not be read`);
    return record;
  }

  /**
   * Closed ones too: "every child closed" counts all of them. Past one read's
   * worth, refused rather than short.
   *
   * A breakdown's children are read straight after it made them, and search
   * may not have them yet — a graph short a child routes as if the split
   * never happened. The parent's own sub-tasks, read off the issue, are
   * never behind, so the search is asked to reconcile them.
   */
  async children(id: string, ctx: RuntimeContext): Promise<ItemRecord[]> {
    const key = this.keyOf(id);
    const jira = this.jira(ctx);
    const parent = await jira.call<{ fields?: { subtasks?: Array<{ id?: string }> } }>("GET", `/rest/api/3/issue/${key}?fields=subtasks`);
    const subtasks = (parent.fields?.subtasks ?? []).flatMap((s) => (s.id === undefined ? [] : [Number(s.id)]));
    if (subtasks.length > ITEM_PAGE) throw new Error(`${key} has more than the ${ITEM_PAGE} children one read carries`);
    const found = await this.search(jira, `project = "${this.project}" AND parent = "${key}" ORDER BY created ASC`, subtasks);
    if (!found.complete || found.issues.length > ITEM_PAGE) {
      throw new Error(`${key} has more than the ${ITEM_PAGE} children one read carries`);
    }
    return this.records(jira, found.issues);
  }

  /** Every page of them: a stage whose entry record sat on the second page would read as never entered. */
  async comments(id: string, ctx: RuntimeContext): Promise<TrackerComment[]> {
    const key = this.keyOf(id);
    const jira = this.jira(ctx);
    const all: TrackerComment[] = [];
    for (let page = 0; page < MAX_ISSUE_PAGES; page++) {
      const res = await jira.call<{ comments?: Array<{ id?: string; author?: User; body?: unknown; created?: string }>; total?: number }>(
        "GET", `/rest/api/3/issue/${key}/comment?startAt=${all.length}&maxResults=${ISSUE_PAGE}&orderBy=created`,
      );
      const batch = res.comments ?? [];
      all.push(...batch.map((c) => ({
        id: c.id,
        body: fromAdf(c.body),
        created_at: iso(c.created) ?? "",
        user: c.author?.accountId ? { login: c.author.accountId } : null,
      })));
      if (batch.length === 0 || all.length >= (res.total ?? 0)) return all;
    }
    throw new Error(`${key} has more comments than ${MAX_ISSUE_PAGES} pages carry`);
  }

  async comment(id: string, body: string, ctx: RuntimeContext): Promise<void> {
    const key = this.keyOf(id);
    await this.jira(ctx).call("POST", `/rest/api/3/issue/${key}/comment`, { body: this.adf(body, `comment on ${key}`) });
  }

  async addLabels(id: string, labels: string[], ctx: RuntimeContext): Promise<void> {
    const key = this.keyOf(id);
    if (labels.length === 0) return;
    await this.jira(ctx).call("PUT", `/rest/api/3/issue/${key}`, { update: { labels: labels.map((add) => ({ add })) } });
  }

  /** Removing a label the issue does not carry is Jira's no-op, so already gone is success. */
  async removeLabel(id: string, label: string, ctx: RuntimeContext): Promise<void> {
    const key = this.keyOf(id);
    await this.jira(ctx).call("PUT", `/rest/api/3/issue/${key}`, { update: { labels: [{ remove: label }] } });
  }

  private async offered(jira: Client, key: string): Promise<Transition[]> {
    return (await jira.call<{ transitions?: Transition[] }>("GET", `/rest/api/3/issue/${key}/transitions`)).transitions ?? [];
  }

  private async transition(jira: Client, key: string, to: Transition): Promise<void> {
    await jira.call("POST", `/rest/api/3/issue/${key}/transitions`, { transition: { id: to.id } });
  }

  /** Whether the issue is closed now, read off the issue rather than the search index, which lags. */
  private async isClosed(jira: Client, key: string): Promise<boolean> {
    const { fields } = await jira.call<Issue>("GET", `/rest/api/3/issue/${key}?fields=status`);
    return fields?.status?.statusCategory?.key === "done";
  }

  /**
   * Through the transition named for `how`, unless it is closed already: the
   * graph a close was planned from came from search, and an item a person
   * closed a moment ago must not be closed again over them. Missing, the
   * transition says which ones the issue offers; two of one name halt rather
   * than pick one; and one into a status Jira does not count as done is
   * refused, since it would close nothing and be planned again every tick.
   */
  async close(id: string, how: "done" | "dropped", ctx: RuntimeContext): Promise<void> {
    const key = this.keyOf(id);
    const jira = this.jira(ctx);
    if (await this.isClosed(jira, key)) return;
    const name = how === "done" ? this.done : this.dropped;
    const offered = await this.offered(jira, key);
    const named = offered.filter((t) => same(t.name, name));
    const [only] = named;
    if (!only) throw new Error(`${key} offers no "${name}" transition; it offers ${offeredList(offered)}`);
    if (named.length > 1) throw new Error(`${key} offers ${named.length} transitions named "${name}"; which one closes it is not a guess`);
    if (only.to?.statusCategory?.key !== "done") {
      throw new Error(`"${name}" takes ${key} to ${only.to?.name ?? "a status"}, which Jira does not count as done`);
    }
    await this.transition(jira, key, only);
  }

  /**
   * An issue of `issueType`, or of `childType` under `parent` — Jira files
   * the link with the issue, so there is nothing to undo when it fails.
   * Priority is the project's own, landrace's index into its list: landrace
   * has ten levels and a project usually five, so past its last, its lowest.
   */
  async create(
    { title, body, parent, priority }: { title: string; body: string; parent: string | undefined; priority: number | undefined },
    ctx: RuntimeContext,
  ): Promise<string> {
    // Checked before anything is created, so a bad parent leaves nothing behind.
    const under = parent === undefined ? undefined : this.keyOf(parent);
    const description = this.adf(body, `description for a new ${this.project} issue`);
    const jira = this.jira(ctx);
    let priorityId: string | undefined;
    if (priority !== undefined) {
      const ids = await this.priorityIds(jira);
      priorityId = ids[Math.min(Math.max(priority, 0), ids.length - 1)];
      if (priorityId === undefined) throw new Error(`${this.project} has no priorities to give a new issue`);
    }
    const created = await jira.call<{ key?: unknown } | null>("POST", "/rest/api/3/issue", {
      fields: {
        project: { key: this.project },
        summary: title,
        issuetype: { name: under === undefined ? this.issueType : this.childType },
        description,
        ...(under === undefined ? {} : { parent: { key: under } }),
        ...(priorityId === undefined ? {} : { priority: { id: priorityId } }),
      },
    });
    const key = created?.key;
    if (typeof key !== "string" || !this.keyPattern.test(key)) {
      throw new Error(`Jira created an issue but answered no ${this.project} key for it: ${JSON.stringify(created)}`);
    }
    return key;
  }

  /**
   * The title and body, and the state by transition: closed through the
   * done one, open through the first the issue offers into a To Do status.
   * A state the item is already in asks for nothing.
   */
  async update(id: string, { title, body, state }: Pick<ItemPatch, "title" | "body" | "state">, ctx: RuntimeContext): Promise<void> {
    const key = this.keyOf(id);
    const fields = {
      ...(title === undefined ? {} : { summary: title }),
      ...(body === undefined ? {} : { description: this.adf(body, `description for ${key}`) }),
    };
    const jira = this.jira(ctx);
    if (Object.keys(fields).length > 0) await jira.call("PUT", `/rest/api/3/issue/${key}`, { fields });
    if (state === undefined) return;
    if (state === "closed") return this.close(key, "done", ctx);
    if (!(await this.isClosed(jira, key))) return;
    const offered = await this.offered(jira, key);
    const reopen = offered.find((t) => t.to?.statusCategory?.key === "new");
    if (!reopen) throw new Error(`${key} offers no transition into a To Do status; it offers ${offeredList(offered)}`);
    await this.transition(jira, key, reopen);
  }

  // Jira's issue links are not mapped: no relationship type is writable, so
  // the base refuses every relate and unrelate before either is reached.
  protected async addRelation(item: string, type: string, other: string): Promise<void> {
    throw new Error(`cannot relate ${item} to ${other} as "${type}": this Jira integration writes no relationship`);
  }

  protected async removeRelation(item: string, type: string, other: string): Promise<void> {
    throw new Error(`cannot unrelate ${item} from ${other} as "${type}": this Jira integration writes no relationship`);
  }

  /**
   * Startup, before anything is paid for: each permission the account lacks
   * on the project, each issue type it does not have, and each type without a
   * labels field — an item's position is a label. Reads only: every write
   * shows in the project's history, so the preflight makes none.
   */
  async check(ctx: RuntimeContext): Promise<void> {
    const jira = this.jira(ctx);
    const problems: string[] = [];
    const { permissions = {} } = await jira.call<{ permissions?: Record<string, { name?: string; havePermission?: boolean }> }>(
      "GET", `/rest/api/3/mypermissions?projectKey=${this.project}&permissions=${PERMISSIONS.join(",")}`,
    );
    for (const key of PERMISSIONS) {
      if (permissions[key]?.havePermission !== true) {
        problems.push(`the account lacks "${permissions[key]?.name ?? key}" (${key}) on ${this.project}`);
      }
    }
    // Create metadata answers only an account that may browse the project and create in it.
    if (permissions.BROWSE_PROJECTS?.havePermission === true && permissions.CREATE_ISSUES?.havePermission === true) {
      const path = `/rest/api/3/issue/createmeta/${this.project}/issuetypes`;
      const types = await everyPage<{ id?: string; name?: string }>(jira, path);
      for (const wanted of new Set([this.issueType, this.childType])) {
        const type = types.find((t) => t.name === wanted);
        if (!type?.id) {
          problems.push(`${this.project} has no issue type "${wanted}"; it has ${types.map((t) => `"${t.name}"`).join(", ") || "none"}`);
          continue;
        }
        const fields = await everyPage<{ fieldId?: string }>(jira, `${path}/${encodeURIComponent(type.id)}`);
        if (!fields.some((f) => f.fieldId === "labels")) {
          problems.push(`${this.project}'s "${wanted}" issues have no labels field, and an item's position is a label`);
        }
      }
    }
    if (problems.length > 0) throw new Error(problems.join("; "));
  }
}
