/*
 * Jira Cloud issues as a project's tracker: the JQL, the changelog that says
 * who last edited a body, the workflow's transitions, the "Blocks" issue
 * links as `blocked-by`, and the account's permissions. Everything else a
 * tracker does is `BaseTracker`'s — position is still an `lr:stage:*` label;
 * Jira's status follows it only where `statuses` maps the stage, and
 * otherwise moves only to close an item or reopen it.
 */
import {
  type Closed, type Effect, FIELD_EFFECT, type HookContext, type ItemPatch, type Json, mayCreateItems, neutraliseMarkers, type Node,
  type PreflightContext, RELATIONS, type RuntimeContext, sameLogin, type Snapshot, STAGE_LABEL_PREFIX, STATUS_EFFECT,
  type TrackerFieldValue, WORKLOG_EFFECT,
} from "landrace/hooks";
import {
  BaseTracker, botLoginOf, type CommentVisibility, type CreateRequest, DONE_WINDOW_MS, EffectRefused, type EffectTable, ISSUE_PAGE, MAX_ISSUE_PAGES,
  ITEM_PAGE, type ItemRecord, type OpenRelations, type RelatedRecord, statusSatisfied, type TrackerComment, type WorklogRecord,
} from "landrace/kit";
import { type AdfDoc, type AdfNode, fromAdf, type Mention, mentionsIn, plainAdf, splitMarker, toAdf } from "./adf.js";
import { type Client, clientFor, isMissing, refusesField } from "./client.js";

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
  /**
   * The issue link type read and written as blocked-by, by its exact name:
   * "Blocks" unless named. Its inward side must read "is blocked by", as
   * Jira's "Blocks" does — the blocker is the link's inward end — and the
   * preflight refuses a type that reads the same both ways. A blocker the
   * account may not browse is left out of an issue's links by Jira, so it is
   * unseen, not unreadable: the account needs "Browse projects" wherever a
   * blocker may be.
   */
  blockedByLinkType?: string | undefined;
  /**
   * A Jira status for a stage, by the stage's `tracker.status` value: after
   * the label, the issue moves through the transition into it. Display only —
   * position stays the label — so a stage with none moves no status, and a
   * transition the issue does not offer is logged and skipped.
   */
  statuses?: Record<string, string> | undefined;
  /**
   * Other projects on the site a `tracker.create` files an issue in — an ENG
   * bug from a support desk — by key. None unless named. An issue filed
   * there is linked to the item, assigned to `jiraAssignee` when it is set,
   * marked as filed by landrace for the item, and never one of this
   * tracker's items.
   */
  createIn?: string[] | undefined;
  /** What an issue filed in a `createIn` project is created as: "Task" unless named. */
  createType?: string | undefined;
  /** The link type between the item and an issue filed for it, by its exact name: "Relates" unless named. Never `blockedByLinkType`. */
  createLinkType?: string | undefined;
  /**
   * A JQL clause ANDed into every search the tracker runs — the open list,
   * the Done lane, the cycle walk — and `JiraField`'s listing, beside
   * `jiraAssignee`: `created >= "2026-10-05"`, say, so a first start does not
   * work a backlog that was handled by hand. From this file only, never from
   * item text. Run once at start, and refused with Jira's own error when it
   * does not parse. A breakdown's children are read whatever it says.
   */
  jql?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

const TEXTAREA = "com.atlassian.jira.plugin.system.customfieldtypes:textarea";
const TEXTFIELD = "com.atlassian.jira.plugin.system.customfieldtypes:textfield";

/** Jira's bound on a single-line text field, and on an issue's summary. */
export const MAX_TEXTFIELD = 255;

/** A field as `GET /field` lists it, or a create screen does under `fieldId`. */
export interface Field { id?: unknown; name?: unknown; schema?: { type?: unknown; items?: unknown; custom?: unknown } | null }

/** A field as an issue's edit screen holds it: what it is, and the options a select offers there. */
export interface EditField { name?: unknown; schema?: Field["schema"]; allowedValues?: Array<{ value?: unknown } | null> | null }

/**
 * What a field takes by its type — a textarea a document unless its renderer
 * says a string, a text field a string — or why it cannot be written from
 * text: what `JiraField` keeps a spec in, and what a `tracker.create` fills.
 */
export function shapeOf(field: Field): "adf" | "string" | string {
  const custom = field.schema?.custom;
  if (custom === TEXTAREA) return "adf";
  if (custom === TEXTFIELD) return "string";
  return `"${String(field.name)}" (${String(field.id)}) is a ${typeof custom === "string" ? custom : String(field.schema?.type)} field, not a text or textarea one`;
}

/**
 * A title cut to Jira's summary bound: an issue filed with the start of a
 * long title beats a refusal, which no retry would get past. Never inside a
 * surrogate pair, which would leave half a character.
 */
function summaryOf(title: string): string {
  if (title.length <= MAX_TEXTFIELD) return title;
  const cut = title.slice(0, MAX_TEXTFIELD);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** Jira's own bound on a comment or a description, counted on the document it is sent as. */
const MAX_ADF_CHARS = 32_767;

/**
 * A body as the document Jira takes. Rich ADF runs several times its
 * Markdown's size, so a body the engine admits can be past Jira's bound
 * rich and well inside it plain: then it is sent plain, raw Markdown on
 * the ticket rather than no answer at all. Past the bound even plain it is
 * refused here, rather than by a 400 after the fact, and as a refusal: no
 * retry makes it fit, so the round is recorded rather than paid for again.
 */
export function adfOf(text: string, what: string, mention?: Mention): AdfDoc {
  const rich = toAdf(text, mention);
  if (JSON.stringify(rich).length <= MAX_ADF_CHARS) return rich;
  const plain = plainAdf(text);
  const size = JSON.stringify(plain).length;
  if (size > MAX_ADF_CHARS) throw new EffectRefused(`refusing to send a ${size}-character ${what}: Jira takes at most ${MAX_ADF_CHARS}`);
  return plain;
}

/** What a `tracker.field` writes into a field, by the field's type. */
type FieldKind = "option" | "options" | "user" | "users" | "number" | "adf" | "string";

const FIELD_KINDS: readonly string[] = ["option", "options", "user", "users", "number", "adf", "string"];

const isKind = (kind: string): kind is FieldKind => FIELD_KINDS.includes(kind);

/**
 * What a `tracker.field` writes into a field by its schema — a select, a
 * multi-select, a user or several, a number, or text as `shapeOf` says text
 * is written — or why it cannot write it, naming the field.
 */
function fieldKindOf(id: string, field: EditField | Field): FieldKind | string {
  const schema = field.schema ?? null;
  const { type, items, custom } = schema ?? {};
  if (type === "option") return "option";
  if (type === "user") return "user";
  if (type === "number") return "number";
  if (type === "array" && items === "option") return "options";
  if (type === "array" && items === "user") return "users";
  const shape = shapeOf({ id, name: field.name, schema });
  if (shape === "adf" || shape === "string") return shape;
  return `"${String(field.name)}" (${id}) is a ${typeof custom === "string" ? custom : String(type)} field; ` +
    `a ${FIELD_EFFECT} sets a select, a multi-select, a user or users, a number, or a text or textarea field`;
}

/** Why a value is not one a field of this kind takes, or null: one string — or a list of one — for a select or a user, a number for a number, text for text. */
function valueProblem(label: string, kind: FieldKind, value: TrackerFieldValue): string | null {
  const shown = JSON.stringify(value);
  if (kind === "option" || kind === "user") {
    const one = typeof value === "string" || (Array.isArray(value) && value.length === 1);
    return one ? null : `${label} is a ${kind === "option" ? "select" : "user"} field, which takes one value, not ${shown}`;
  }
  if (kind === "options" || kind === "users") return typeof value === "number" ? `${label} takes a name or a list of them, not ${shown}` : null;
  if (kind === "number") return typeof value === "number" ? null : `${label} is a number field, and ${shown} is not a number`;
  if (typeof value !== "string") return `${label} is a text field, and ${shown} is not text`;
  if (kind === "string" && value.length > MAX_TEXTFIELD) return `${label} is a text field, which holds at most ${MAX_TEXTFIELD} characters, not ${value.length}`;
  return null;
}

/** The names a value lists: itself, or each of its own. */
const namesOf = (value: TrackerFieldValue): string[] => (Array.isArray(value) ? value : [String(value)]);

/** Why an option is none of a field's, naming the options it has; null when it is one, or the screen lists none to judge by. */
function optionProblem(label: string, name: string, field: EditField, where: string): string | null {
  if (!Array.isArray(field.allowedValues)) return null;
  const allowed = field.allowedValues.flatMap((o) => (typeof o?.value === "string" ? [o.value] : []));
  if (allowed.includes(name)) return null;
  return `"${name}" is no option of ${label}${where}; it has ${allowed.map((o) => `"${o}"`).join(", ") || "none"}`;
}

/**
 * A field's value as an issue answers it, in `node.state.fields`' neutral
 * shape: an option as its value, a user as an account id, a list of either
 * as a list, a textarea's document as Markdown, text and numbers as they
 * are, and an empty one as null. Undefined — left out, so it reads as not
 * read — for a field the answer does not hold, or holds in a shape not
 * among these.
 */
function fieldValueOf(raw: unknown): Json | undefined {
  const scalar = (v: unknown): string | undefined => {
    if (typeof v === "string") return v;
    const { value, accountId } = (v ?? {}) as { value?: unknown; accountId?: unknown };
    if (typeof value === "string") return value;
    return typeof accountId === "string" ? accountId : undefined;
  };
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") return raw.trim() === "" ? null : raw;
  if (Array.isArray(raw)) {
    if (raw.length === 0) return null;
    const all = raw.map(scalar);
    return all.every((v): v is string => v !== undefined) ? all : undefined;
  }
  if ((raw as { type?: unknown }).type === "doc") {
    const text = fromAdf(raw);
    return text.trim() === "" ? null : text;
  }
  return scalar(raw);
}

/** Whether a field read holds nothing. */
const emptyField = (value: Json | undefined): boolean => value === undefined || value === null;

/** A `tracker.field`'s fields, as the effect carries them; `validate` refuses any other shape, so one here is a broken workflow. */
function wantedFields(effect: Effect): Array<[string, TrackerFieldValue]> {
  const { fields } = effect;
  if (fields === null || typeof fields !== "object" || Array.isArray(fields) || Object.keys(fields).length === 0) {
    throw new Error(`a ${FIELD_EFFECT} effect needs fields, a map of field id to its value`);
  }
  return Object.entries(fields).map(([id, value]) => {
    const ok = typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) ||
      (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string"));
    if (!ok) throw new Error(`a ${FIELD_EFFECT} sets ${id} to ${JSON.stringify(value)}; a value is a string, a number or a list of strings`);
    return [id, value as TrackerFieldValue];
  });
}

/**
 * The edit screens of the issue types an item can be: the types of the open
 * issues in the tracker's scope, read by one search under `jiraAssignee` and
 * `jql`, and the tracker's own `itemTypes`. A project's Epics, say, are no
 * item's, and are not looked at. Each type is read off one open issue of it,
 * the only way Jira says what an issue's edit screen holds — open, because a
 * closed status may make issues non-editable, which answers an empty screen.
 * A type with no open issue to look at is `unchecked`. Reads only.
 */
export async function editScreens(
  jira: Client, ctx: RuntimeContext, { project, jql, itemTypes, keyPattern }: { project: string; jql: string | undefined; itemTypes: string[]; keyPattern: RegExp },
): Promise<{ screens: Array<{ type: string; fields: Record<string, EditField> }>; unchecked: string[] }> {
  const scoped = await search(
    jira, `project = "${project}" AND statusCategory != Done${await scopeOf(jira, ctx, jql)} ORDER BY created ASC`, { fields: ["issuetype"] },
  );
  // A type past the last page read may be one of them: not found is not missing.
  if (!scoped.complete) throw new Error(`${project} has more open issues in the tracker's scope than one listing carries, so which types its items are cannot be told`);
  const names = new Set([
    ...scoped.issues.flatMap((i) => {
      const name = (i.fields as { issuetype?: { name?: unknown } | null }).issuetype?.name;
      return typeof name === "string" ? [name] : [];
    }),
    ...itemTypes,
  ]);
  const found = await jira.call<{ issueTypes?: Array<{ id?: unknown; name?: unknown }> } | null>("GET", `/rest/api/3/project/${project}`);
  // A type the tracker names that the project lacks is the tracker's preflight to refuse.
  const types = (found?.issueTypes ?? []).flatMap((t) =>
    (typeof t.id === "string" && /^[0-9]+$/.test(t.id) && names.has(String(t.name)) ? [{ id: t.id, name: String(t.name) }] : []));
  const screens: Array<{ type: string; fields: Record<string, EditField> }> = [];
  const unchecked: string[] = [];
  for (const type of types) {
    const { issues = [] } = await jira.call<{ issues?: Array<{ key?: unknown }> }>("POST", "/rest/api/3/search/jql", {
      jql: `project = "${project}" AND issuetype = ${type.id} AND statusCategory != Done`, fields: ["key"], maxResults: 1,
    });
    const key = issues[0]?.key;
    if (typeof key !== "string" || !keyPattern.test(key)) {
      unchecked.push(type.name);
      continue;
    }
    try {
      const { fields = {} } = await jira.call<{ fields?: Record<string, EditField> }>("GET", `/rest/api/3/issue/${key}/editmeta`);
      screens.push({ type: type.name, fields });
    } catch (e) {
      throw new Error(`cannot read ${key}'s edit screen, for its "${type.name}" issues: ${messageOf(e)}`);
    }
  }
  return { screens, unchecked };
}

/**
 * Every field an item is read from, asked for by name: a search returns ids
 * alone unless told. A read's children are asked for all but their links,
 * which a read never draws.
 */
const CHILD_FIELDS = [
  "summary", "status", "resolution", "labels", "assignee", "creator", "description", "created", "updated",
  "statuscategorychangedate", "parent", "priority",
];
const FIELDS = [...CHILD_FIELDS, "issuelinks"];

/** The fields a read asks for: its own, and those the loaded `tracker.field` effects set, in the same request. */
const withAsked = (own: string[], ctx: RuntimeContext): string[] => [...new Set([...own, ...(ctx.trackerFields ?? [])])];

/**
 * The asked fields of an issue as `ItemRecord.fields` carries them: each
 * one the answer holds, in its neutral shape. None when nothing was asked.
 */
function fieldsRead(fields: Issue["fields"], ctx: RuntimeContext): Pick<ItemRecord, "fields"> {
  const asked = [...(ctx.trackerFields ?? [])];
  if (asked.length === 0) return {};
  const read: Record<string, Json> = {};
  for (const id of asked) {
    const value = fieldValueOf((fields as Record<string, unknown>)[id]);
    if (value !== undefined) read[id] = value;
  }
  return { fields: read };
}

/**
 * Any issue's key on the site: its project's key — a capital, then capitals,
 * digits or "_" — a dash, and its number. A blocker may be in any project the
 * account can see; it is checked against this before it is spelled into a URL.
 */
const SITE_KEY = /^[A-Z][A-Z0-9_]+-[1-9][0-9]*$/;

/**
 * What the tracker does, as Jira's permission keys: read, create, label and
 * edit, transition, comment, and link — a breakdown's related child is
 * created before it is linked, and one whose link is refused is dropped
 * again, in the project's history.
 */
const PERMISSIONS = ["BROWSE_PROJECTS", "CREATE_ISSUES", "EDIT_ISSUES", "TRANSITION_ISSUES", "ADD_COMMENTS", "LINK_ISSUES"];

/**
 * What filing an issue in a `createIn` project takes there: seeing it — the
 * link is read back off the item to find an issue already filed — creating
 * in it, and linking from it.
 */
const CREATE_PERMISSIONS = ["BROWSE_PROJECTS", "CREATE_ISSUES", "LINK_ISSUES"];

/** The entity property an issue filed by `tracker.create` carries: the item it was filed for, and the effect's marker. */
const CREATED_BY = "landrace.created-by";

/**
 * An Atlassian account id: hex, or a prefix and a colon before a UUID. It is
 * spelled into every query as `assignee = "<id>"`, so nothing a quote or a
 * space could rewrite the query with.
 */
const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/;

/** Users one search for an email is read to. */
const USER_PAGE = 100;

/** Jira Service Management's project type: its comments reach the requester unless marked internal. */
const SERVICE_DESK = "service_desk";

/**
 * The comment and worklog property Landrace's marker is kept in, so the text
 * a requester reads never carries it. Only a comment's author, or an account
 * that may edit every comment, can set one — the same people who could edit
 * the body a marker used to live in.
 */
const MARKER_PROPERTY = "landrace.marker";

/** Jira Service Management's own property: `{ internal: true }` keeps a comment from the requester. */
const INTERNAL_PROPERTY = "sd.public.comment";

/**
 * What a comment says when its marker was its whole body — an agent that
 * answered with its json block alone. Jira refuses an empty comment with a
 * 400, which no retry fixes, and the step would be paid for again every
 * tick; read back beside our marker property, it is read as no text.
 */
const NO_TEXT = "(no text)";

/** An entity property as Jira answers one, expanded on a comment or a worklog. */
interface Property { key?: unknown; value?: unknown }

/** The marker a `landrace.marker` property holds, when it holds one marker and nothing else. */
function propertyMarker(properties: Property[] | undefined): { found: boolean; marker: string | null } {
  const property = (properties ?? []).find((p) => p?.key === MARKER_PROPERTY);
  if (property === undefined) return { found: false, marker: null };
  const value = (property.value as { marker?: unknown } | null)?.marker;
  if (typeof value !== "string") return { found: true, marker: null };
  const { text, marker } = splitMarker(value);
  return { found: true, marker: text.trim() === "" ? marker : null };
}

/** A worklog effect's marker: without one, nothing would say it had been logged, and it would be logged again every tick. */
function worklogMarker(effect: Effect): string {
  if (typeof effect.marker !== "string" || effect.marker === "") {
    throw new Error(`a ${WORKLOG_EFFECT} effect with no marker cannot be reconciled: it would be logged again on every tick`);
  }
  return effect.marker;
}

/**
 * `tracker.worklog` is logged already: a worklog we wrote carrying exactly
 * this marker — or, with `skipIfLogged`, any worklog at all, a person's
 * included.
 */
function worklogLogged(worklogs: WorklogRecord[], effect: Effect, bot: string): boolean {
  const marker = worklogMarker(effect);
  if (effect.skipIfLogged === true && worklogs.length > 0) return true;
  return worklogs.some((w) => typeof w.author === "string" && sameLogin(w.author, bot) && w.marker === marker);
}

/**
 * The users an email may be: those Jira finds for it whose email it shows as
 * that one, or hides — Jira keeps most emails private, so one shown none may
 * be the one meant. Null when the search fills a page, and the one meant may
 * be past it.
 */
async function usersWithEmail(jira: Client, email: string): Promise<User[] | null> {
  const found = await jira.call<User[] | null>("GET", `/rest/api/3/user/search?query=${encodeURIComponent(email)}&maxResults=${USER_PAGE}`) ?? [];
  if (found.length >= USER_PAGE) return null;
  return found.filter((u) => u.emailAddress === undefined || same(u.emailAddress, email));
}

/** Issues one `issue/bulkfetch` returns whatever fields it asks for: up to 1000 only when they are named, and this stays inside both. */
const BULK_BATCH = 100;

/** Bulk changelog takes a thousand issues a request. */
const CHANGELOG_BATCH = 1000;

interface User { accountId?: string; displayName?: string; emailAddress?: string }
interface Status { name?: string; statusCategory?: { key?: string } }

/** The issue at a link's other end, as an issue's `issuelinks` names it: its key, and a few of its fields — never its resolution. */
interface LinkEnd { id?: unknown; key?: unknown; fields?: { summary?: unknown; status?: Status } | null }

/** One entry of an issue's `issuelinks`: the link, its type, and the other end, in one slot of two. */
interface LinkEntry { id?: unknown; type?: { name?: unknown } | null; inwardIssue?: LinkEnd | null; outwardIssue?: LinkEnd | null }

/**
 * A blocker as an issue's own links name it: the link's id, which deletes
 * it, the blocker's issue id, which survives a move, and what the link says
 * of the blocker.
 */
interface Blocker { link: string | null; id: string | null; key: string; title: string; status: Status | undefined }

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
    issuelinks?: unknown;
  };
}

interface Transition { id: string; name: string; to?: Status }

/** Jira answers names however they were typed; a status or transition is one name whatever its case. */
export const same = (a: string | undefined, b: string): boolean => a?.trim().toLowerCase() === b.trim().toLowerCase();

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

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A refusal from Jira, by its status: what it answers an account that may not do or see something. */
const isRefused = (e: unknown): boolean => isMissing(e) || (e as { status?: unknown } | null)?.status === 403;

/**
 * The blockers an issue's links name, of the one type read as blocked-by,
 * and whether that was all of them.
 *
 * Which way a link points is Atlassian's: an entry holding its other end as
 * `inwardIssue` is labelled with the type's inward words — "is blocked by" —
 * so that issue blocks this one; one holding it as `outwardIssue` is this
 * issue blocking it, that issue's to read. An entry that cannot be read — no
 * type, both ends or neither, no key, a key no issue has — is left out and
 * the rest said not to be whole: not found is not missing. Jira answers an
 * issue's links in one unpaged array, so an empty one is none, and an answer
 * with no array at all is not whole.
 */
function blockersIn(issuelinks: unknown, type: string): { blockers: Blocker[]; whole: boolean } {
  if (!Array.isArray(issuelinks)) return { blockers: [], whole: false };
  const blockers: Blocker[] = [];
  let whole = true;
  for (const entry of issuelinks as Array<LinkEntry | null>) {
    const name = entry?.type?.name;
    if (typeof name !== "string") {
      whole = false;
      continue;
    }
    if (name !== type) continue;
    const inward = entry?.inwardIssue ?? null;
    const outward = entry?.outwardIssue ?? null;
    if ((inward === null) === (outward === null)) {
      whole = false;
      continue;
    }
    if (inward === null) continue;
    if (typeof inward.key !== "string" || !SITE_KEY.test(inward.key)) {
      whole = false;
      continue;
    }
    blockers.push({
      link: typeof entry?.id === "string" && /^[0-9]+$/.test(entry.id) ? entry.id : null,
      id: typeof inward.id === "string" && /^[0-9]+$/.test(inward.id) ? inward.id : null,
      key: inward.key,
      title: typeof inward.fields?.summary === "string" ? inward.fields.summary : "",
      status: inward.fields?.status ?? undefined,
    });
  }
  return { blockers, whole };
}

/** Each client's assignee, resolved once: its account id, or null when the tracker is not scoped. */
const assignees = new WeakMap<Client, string | null>();

/**
 * The `jiraAssignee` secret as an account id, or null when it is unset or
 * empty. An email is looked up once, and refused when it matches no user or
 * several: Jira keeps most emails private, so a user search answers with
 * none shown, and one of those may be the one meant — two are not a guess.
 * An account id is asked after too, so a typo refuses to start rather than
 * list nobody's issues. Resolved by the preflight and by whatever reads
 * first, never skipped: an unscoped list of everybody's issues is the
 * failure the secret is there to prevent.
 */
export async function assigneeOf(jira: Client, ctx: RuntimeContext): Promise<string | null> {
  const known = assignees.get(jira);
  if (known !== undefined) return known;
  const value = ctx.secrets.get("jiraAssignee")?.trim() ?? "";
  const id = value === "" ? null : await accountFor(jira, value, `jiraAssignee "${value}"`);
  assignees.set(jira, id);
  return id;
}

/** Why a user lookup found no one account: a refusal of the value, told apart from Jira failing to answer. */
class NoAccount extends Error {}

/**
 * The one account an email or an account id is, as `jiraAssignee` and a
 * `tracker.field`'s user value are resolved: refused when it matches no user
 * or several, `what` naming the value in each refusal. An account id is asked
 * after too, so a typo is refused rather than written.
 */
async function accountFor(jira: Client, value: string, what: string): Promise<string> {
  if (!value.includes("@") && !ACCOUNT_ID.test(value)) throw new NoAccount(`${what} is neither an email nor a Jira account id`);
  let users: User[];
  if (value.includes("@")) {
    const found = await usersWithEmail(jira, value);
    if (found === null) throw new NoAccount(`${what} matches more Jira users than one search returns; name one by its account id`);
    users = found;
  } else {
    users = await jira.call<User | null>("GET", `/rest/api/3/user?accountId=${encodeURIComponent(value)}`)
      .then((u) => (u === null ? [] : [u]), (e: unknown) => { if (isMissing(e)) return []; throw e; });
  }
  const [only] = users;
  if (!only) {
    // Jira answers an account without "Browse users and groups" with nobody, not a refusal: asked, so the
    // refusal names the cause that applied.
    const { permissions = {} } = await jira.call<{ permissions?: Record<string, { havePermission?: boolean }> }>(
      "GET", "/rest/api/3/mypermissions?permissions=USER_PICKER",
    );
    if (permissions.USER_PICKER?.havePermission !== true) {
      throw new NoAccount(
        `${what} cannot be looked up: the account lacks the global "Browse users and groups" permission (USER_PICKER), ` +
        "without which Jira finds no user; grant it",
      );
    }
    throw new NoAccount(`${what} matches no Jira user`);
  }
  if (users.length > 1) {
    throw new NoAccount(`${what} matches ${users.length} Jira users: ${users.map((u) => u.displayName ?? u.accountId).join(", ")}; name one by its account id`);
  }
  if (typeof only.accountId !== "string" || !ACCOUNT_ID.test(only.accountId)) {
    throw new NoAccount(`Jira answered ${what} with no usable account id`);
  }
  return only.accountId;
}

/**
 * The clauses every listing query ends its conditions with: the assignee's,
 * and the tracker's own `jql` in parentheses, so an OR in it stays inside.
 */
export async function scopeOf(jira: Client, ctx: RuntimeContext, jql: string | undefined): Promise<string> {
  const id = await assigneeOf(jira, ctx);
  return `${id === null ? "" : ` AND assignee = "${id}"`}${jql === undefined ? "" : ` AND (${jql})`}`;
}

/**
 * Every issue a query finds, page by page — and whether the pages ran out
 * before it did. Search is eventually consistent; the ids in `reconcile`
 * (at most 50) are read as they are now rather than as the index has them.
 */
export async function search(
  jira: Client, jql: string, { reconcile = [], fields = FIELDS }: { reconcile?: number[]; fields?: string[] } = {},
): Promise<{ issues: Issue[]; complete: boolean }> {
  const issues: Issue[] = [];
  let nextPageToken: string | undefined;
  for (let page = 0; page < MAX_ISSUE_PAGES; page++) {
    const res = await jira.call<{ issues?: Issue[]; nextPageToken?: string | null }>("POST", "/rest/api/3/search/jql", {
      jql, fields, maxResults: ISSUE_PAGE,
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
 * The closed blockers' own fields, for their resolutions: those the answer
 * holds, by key, and those fetched, by issue id — or by key, for one whose
 * link gave no id.
 */
interface Resolutions { held: Map<string, Issue["fields"]>; fetched: Map<string, Issue["fields"]> }

/**
 * Jira Cloud issues, in one project, over one client per configuration —
 * built from the `jiraBaseUrl`, `jiraEmail` and `jiraToken` secrets.
 *
 * With the optional `jiraAssignee` secret — an account id or an email, from
 * each developer's own `.env`, since every developer shares the hook file —
 * only that account's issues are items: a project of thousands lists one
 * developer's share, under the bound a list may carry, and what this
 * instance creates is assigned to them. Unset or empty, it lists everyone's.
 */
export class Jira extends BaseTracker {
  /** Read by `JiraField`, so a spec is kept on this tracker's issues and no other project's. */
  readonly project: string;
  /** Read by `JiraField` too, whose listing is scoped as this tracker's is. */
  readonly jql: string | undefined;
  /** Read by `JiraField`, whose preflight checks the types an item can be. */
  readonly issueType: string;
  readonly childType: string;
  private readonly done: string;
  private readonly dropped: string;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly keyPattern: RegExp;
  private readonly linkType: string;
  /** Each client's project priorities, highest first, read once. */
  private readonly priorities = new WeakMap<Client, string[]>();
  /** Each client's project id and type, once Jira has named both. */
  private readonly projects = new WeakMap<Client, { id: string; type: string }>();
  private readonly statuses: ReadonlyMap<string, string>;
  /** Each item and status already logged as not offered or refused: once a process, since a board's status is not worth a flood. */
  private readonly statusSaid = new Set<string>();
  /** The unreadable blockers already logged this tick: a listing begins each one, and clears it. */
  private readonly unreadableSaid = new Set<string>();
  private readonly createProjects: readonly string[];
  private readonly createType: string;
  private readonly createLinkType: string;
  /** Each `tracker.field` user value resolved, by field and value: the account `satisfied` compares an email as. */
  private readonly accounts = new Map<string, string>();

  constructor({
    project, issueType, childType, transitions, blockedByLinkType, statuses, jql, createIn, createType, createLinkType, fetchImpl,
  }: JiraOptions) {
    super();
    // Spelled into every JQL query and URL, so nothing but a key's own characters.
    if (!/^[A-Z][A-Z0-9_]+$/.test(project)) throw new Error(`project must be a Jira project key such as "KEY", got "${project}"`);
    if (jql !== undefined && (typeof jql !== "string" || jql.trim() === "")) {
      throw new Error(`jql must be a JQL clause such as 'created >= "2026-10-05"', got ${JSON.stringify(jql)}`);
    }
    this.project = project;
    this.jql = jql?.trim();
    this.issueType = issueType ?? "Task";
    this.childType = childType ?? "Subtask";
    this.done = transitions?.done ?? "Done";
    this.dropped = transitions?.dropped ?? "Won't Do";
    this.fetchImpl = fetchImpl;
    this.keyPattern = new RegExp(`^${project}-[1-9][0-9]*$`);
    this.linkType = blockedByLinkType ?? "Blocks";
    for (const [stage, status] of Object.entries(statuses ?? {})) {
      if (typeof status !== "string" || !status.trim()) throw new Error(`statuses.${stage} must name a Jira status, got ${JSON.stringify(status)}`);
    }
    this.statuses = new Map(Object.entries(statuses ?? {}));
    // Spelled into URLs and a key's prefix, as `project` is.
    for (const key of createIn ?? []) {
      if (!/^[A-Z][A-Z0-9_]+$/.test(key)) throw new Error(`createIn must name Jira project keys such as "ENG", got "${key}"`);
      if (key === project) throw new Error(`createIn names ${key}, this tracker's own project: its issues are items, filed through the operator`);
    }
    this.createProjects = [...new Set(createIn ?? [])];
    this.createType = createType ?? "Task";
    this.createLinkType = createLinkType ?? "Relates";
    // Read as blocked-by, a filed issue would hold up the item it was filed for.
    if (this.createProjects.length > 0 && this.createLinkType === this.linkType) {
      throw new Error(`createLinkType "${this.createLinkType}" is blockedByLinkType too: an issue filed for an item would read as blocking it`);
    }
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

  async login(ctx: RuntimeContext): Promise<string> {
    return this.jira(ctx).myself();
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

  /**
   * The project's id and type, read once per client — but only once Jira has
   * named both: a type unread is asked again, never remembered as none.
   */
  private async projectOf(jira: Client): Promise<{ id: string | undefined; type: string | undefined }> {
    const known = this.projects.get(jira);
    if (known) return known;
    const { id, projectTypeKey } = await jira.call<{ id?: unknown; projectTypeKey?: unknown }>("GET", `/rest/api/3/project/${this.project}`);
    const project = {
      id: typeof id === "string" ? id : undefined,
      type: typeof projectTypeKey === "string" && projectTypeKey !== "" ? projectTypeKey : undefined,
    };
    if (project.id !== undefined && project.type !== undefined) this.projects.set(jira, { id: project.id, type: project.type });
    return project;
  }

  /** The project's priorities, highest first: what landrace's 0..9 index into. */
  private async priorityIds(jira: Client): Promise<string[]> {
    const known = this.priorities.get(jira);
    if (known) return known;
    const { id } = await this.projectOf(jira);
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

  /** A done blocker its link cannot tell done from dropped: its resolution is read. */
  private needsResolution({ status }: Blocker): boolean {
    return status?.statusCategory?.key === "done" && !same(status.name, this.dropped);
  }

  /**
   * The resolutions of every closed blocker the answer does not hold, in one
   * `issue/bulkfetch` per hundred, by issue id where the link gave one, so a
   * blocker moved since is found all the same. Jira leaves out an issue that
   * is gone or that the account may not see — read as unreadable, never as
   * done — and names in `issueErrors` one it could not return for a reason
   * that passes, which fails the read for the next tick to read again.
   */
  private async resolutions(jira: Client, issues: Issue[], wanted: Blocker[]): Promise<Resolutions> {
    const held = new Map(issues.map((i) => [i.key, i.fields]));
    const ids = [...new Set(wanted.filter((b) => !held.has(b.key)).map((b) => b.id ?? b.key))];
    const fetched = new Map<string, Issue["fields"]>();
    for (let i = 0; i < ids.length; i += BULK_BATCH) {
      const res = await jira.call<{ issues?: Issue[]; issueErrors?: Array<{ id?: unknown; errorMessage?: unknown }> } | null>(
        "POST", "/rest/api/3/issue/bulkfetch", { issueIdsOrKeys: ids.slice(i, i + BULK_BATCH), fields: ["status", "resolution"] },
      );
      const errors = res?.issueErrors ?? [];
      if (errors.length > 0) {
        throw new Error(`Jira could not return ${errors.map((e) => `issue ${String(e.id)}: ${String(e.errorMessage)}`).join("; ")}`);
      }
      for (const issue of res?.issues ?? []) {
        fetched.set(issue.id, issue.fields);
        fetched.set(issue.key, issue.fields);
      }
    }
    return { held, fetched };
  }

  /**
   * A blocker's state. Its link carries its status, with the status's
   * category, but not its resolution: a status outside the done category is
   * open, and a done one named as dropped is dropped. Any other done one is
   * judged by its own fields, as an item's own state is — read off the
   * answer where it holds the issue, fetched where it does not. One Jira did
   * not return, or returned with no status, is unreadable, never done or open.
   */
  private blockerState(blocker: Blocker, { held, fetched }: Resolutions, of: string, ctx: RuntimeContext): { closed: Closed; unreadable: boolean } {
    const category = blocker.status?.statusCategory?.key;
    if (typeof category !== "string") {
      this.sayUnreadable(ctx, of, blocker.key, "Jira's link names it with no status");
      return { closed: null, unreadable: true };
    }
    if (category !== "done") return { closed: null, unreadable: false };
    // Its status's own name already says dropped.
    if (!this.needsResolution(blocker)) return { closed: "dropped", unreadable: false };
    const fields = held.get(blocker.key) ?? fetched.get(blocker.id ?? blocker.key);
    if (fields === undefined) {
      this.sayUnreadable(ctx, of, blocker.key, "Jira did not return it: it is gone, or this account may not see it");
      return { closed: null, unreadable: true };
    }
    if (typeof fields.status?.statusCategory?.key !== "string") {
      this.sayUnreadable(ctx, of, blocker.key, "Jira returned it with no status");
      return { closed: null, unreadable: true };
    }
    return { closed: this.closedOf(fields), unreadable: false };
  }

  /**
   * An unreadable blocker, in the log: whose, which, and what Jira said. Once
   * a tick — the list, every read of the item and every walk past it meet it
   * again — so it is the one line a person looks for.
   */
  private sayUnreadable(ctx: RuntimeContext, item: string, blocker: string, message: string): void {
    const key = JSON.stringify([item, blocker, message]);
    if (this.unreadableSaid.has(key)) return;
    this.unreadableSaid.add(key);
    ctx.log("jira.blocker.unreadable", { item, blocker, message });
  }

  /** An issue's blockers, as the kit reads relationships. */
  private blockersOf(
    jira: Client, key: string, { blockers, whole }: { blockers: Blocker[]; whole: boolean }, resolutions: Resolutions, ctx: RuntimeContext,
  ): Pick<ItemRecord, "related" | "relatedComplete"> {
    if (!whole) this.sayUnreadable(ctx, key, "a link", `Jira answered ${key}'s issue links with one this integration cannot read`);
    const related = blockers.map((blocker): RelatedRecord => {
      const { closed, unreadable } = this.blockerState(blocker, resolutions, key, ctx);
      return {
        type: RELATIONS.blockedBy, to: blocker.key, title: blocker.title, link: `${jira.baseUrl}/browse/${blocker.key}`, closed,
        ...(unreadable ? { unreadable: true as const } : {}),
      };
    });
    return { related, relatedComplete: whole };
  }

  /**
   * Issues as the kit reads items, with their editors and priorities — and
   * their blockers, unless they were read without their links, as a read's
   * children are.
   */
  private async records(jira: Client, issues: Issue[], ctx: RuntimeContext, links = true): Promise<ItemRecord[]> {
    if (issues.length === 0) return [];
    const editors = await this.editors(jira, issues.map((i) => i.id));
    const priorities = await this.priorityIds(jira);
    const parsed = new Map(links ? issues.map((i) => [i.key, blockersIn(i.fields.issuelinks, this.linkType)]) : []);
    const wanted = [...parsed.values()].flatMap((p) => p.blockers).filter((b) => this.needsResolution(b));
    const resolutions = await this.resolutions(jira, issues, wanted);
    const records: ItemRecord[] = [];
    for (const issue of issues) {
      const { id, key, fields } = issue;
      const own = parsed.get(key);
      const parent = fields.parent?.key;
      const priority = fields.priority?.id === undefined ? -1 : priorities.indexOf(fields.priority.id);
      records.push({
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
        ...(own === undefined ? {} : this.blockersOf(jira, key, own, resolutions, ctx)),
        ...fieldsRead(fields, ctx),
      });
    }
    return records;
  }

  /**
   * Every open issue in the project, and the Done lane's: issues landrace
   * moved — an `lr:stage:*` label says so — that closed inside the window.
   * That second list is for the board, not the loop, so past its bound it
   * stops quietly rather than failing the tick. Both are inside `jql`, and,
   * scoped, the assignee's alone: an issue reassigned to somebody else drops out, and
   * this instance starts nothing more on it. A step already running is not
   * stopped — an item its source stops listing is left running — so it
   * finishes and writes while the new assignee's instance may start it too.
   */
  async items(ctx: RuntimeContext): Promise<ItemRecord[]> {
    this.unreadableSaid.clear();
    const jira = this.jira(ctx);
    const mine = await scopeOf(jira, ctx, this.jql);
    const fields = withAsked(FIELDS, ctx);
    const open = await search(jira, `project = "${this.project}" AND statusCategory != Done${mine} ORDER BY created ASC`, { fields });
    if (!open.complete) throw new Error(`${this.project} has more open issues${mine ? " in its scope (jiraAssignee, jql)" : ""} than ${MAX_ISSUE_PAGES} pages carry`);
    const since = Date.now() - DONE_WINDOW_MS;
    const closed = await search(
      jira,
      `project = "${this.project}" AND statusCategory = Done AND updated >= -${Math.ceil(DONE_WINDOW_MS / 60_000)}m${mine} ORDER BY updated DESC`,
      { fields },
    );
    const done = closed.issues.filter((i) =>
      Date.parse(i.fields.statuscategorychangedate ?? "") >= since &&
      (i.fields.labels ?? []).some((l) => l.startsWith(STAGE_LABEL_PREFIX)));
    // By key, once: an issue closed between the two queries is in both.
    return this.records(jira, [...new Map([...open.issues, ...done].map((i) => [i.key, i])).values()], ctx);
  }

  async item(id: string, ctx: RuntimeContext): Promise<ItemRecord> {
    const key = this.keyOf(id);
    const jira = this.jira(ctx);
    let issue: Issue;
    try {
      issue = await jira.call<Issue>("GET", `/rest/api/3/issue/${key}?fields=${withAsked(FIELDS, ctx).map(encodeURIComponent).join(",")}`);
    } catch (e) {
      if (isMissing(e)) throw new Error(`${key} is not an issue in ${this.project}, or this account cannot see it`);
      throw e;
    }
    // Jira answers a moved issue's old key with the issue under its new one.
    // The engine's id would then name an issue it no longer is: refused.
    if (issue.key !== key) throw new Error(`${key} has moved to ${issue.key}; landrace will not follow an issue to a new key`);
    const [record] = await this.records(jira, [issue], ctx);
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
   *
   * Never scoped to `jiraAssignee`: a child handed to somebody else is still
   * the parent's, and "every child closed" read without it would close the
   * parent early. One read's worth is bounded already.
   */
  async children(id: string, ctx: RuntimeContext): Promise<ItemRecord[]> {
    const key = this.keyOf(id);
    const jira = this.jira(ctx);
    const parent = await jira.call<{ fields?: { subtasks?: Array<{ id?: string }> } }>("GET", `/rest/api/3/issue/${key}?fields=subtasks`);
    const subtasks = (parent.fields?.subtasks ?? []).flatMap((s) => (s.id === undefined ? [] : [Number(s.id)]));
    if (subtasks.length > ITEM_PAGE) throw new Error(`${key} has more than the ${ITEM_PAGE} children one read carries`);
    const found = await search(
      jira, `project = "${this.project}" AND parent = "${key}" ORDER BY created ASC`, { reconcile: subtasks, fields: withAsked(CHILD_FIELDS, ctx) },
    );
    if (!found.complete || found.issues.length > ITEM_PAGE) {
      throw new Error(`${key} has more than the ${ITEM_PAGE} children one read carries`);
    }
    return this.records(jira, found.issues, ctx, false);
  }

  /**
   * The walk's own list: every open issue's links and nothing else — one
   * search, every page of it — rather than every open issue's fields and
   * changelog. Refused past its bound, as `items()` is. An issue whose links
   * it could not all read, or whose blocker's link names no status, is
   * `partial`. A closed blocker is no edge, whichever way it closed, so none
   * is read further. Search lags a moment behind a link just made or
   * removed; the next tick's walk sees it.
   *
   * So it parts from the list in one place: a blocker two hops away whose
   * own closed blocker could not be read. The list, judging from each item's
   * full record, counts that blocker's relationships as not all read; this
   * walk needs none of a closed blocker's state and counts them whole. The
   * engine decides from a read, so only the board's fact differs.
   *
   * Scoped, it walks the assignee's open issues alone, inside `jql`, as the
   * list lists them: a cycle through an issue outside goes unseen.
   */
  protected override async openRelations(type: string, ctx: RuntimeContext): Promise<OpenRelations> {
    if (type !== RELATIONS.blockedBy) return super.openRelations(type, ctx);
    const jira = this.jira(ctx);
    const mine = await scopeOf(jira, ctx, this.jql);
    const found = await search(jira, `project = "${this.project}" AND statusCategory != Done${mine} ORDER BY created ASC`, {
      fields: ["issuelinks"],
    });
    if (!found.complete) throw new Error(`${this.project} has more open issues${mine ? " in its scope (jiraAssignee, jql)" : ""} than ${MAX_ISSUE_PAGES} pages carry`);
    const answer: OpenRelations = { open: [], edges: [], partial: [] };
    for (const { key, fields } of found.issues) {
      const { blockers, whole } = blockersIn(fields?.issuelinks, this.linkType);
      answer.open.push(key);
      const categories = blockers.map((b) => ({ to: b.key, category: b.status?.statusCategory?.key }));
      if (!whole || categories.some((c) => typeof c.category !== "string")) answer.partial.push(key);
      for (const { to, category } of categories) if (typeof category === "string" && category !== "done") answer.edges.push({ from: key, to });
    }
    return answer;
  }

  /**
   * Every page of them: a stage whose entry record sat on the second page
   * would read as never entered. A comment's `landrace.marker` property is
   * read back onto the end of its text, where the engine reads a marker;
   * with one there, a marker in the text is text, escaped. Without one — a
   * comment written before the property — the text's own is read.
   */
  async comments(id: string, ctx: RuntimeContext): Promise<TrackerComment[]> {
    const key = this.keyOf(id);
    const jira = this.jira(ctx);
    const all: TrackerComment[] = [];
    for (let page = 0; page < MAX_ISSUE_PAGES; page++) {
      const res = await jira.call<{
        comments?: Array<{ id?: string; author?: User; body?: unknown; created?: string; properties?: Property[] }>; total?: number;
      }>("GET", `/rest/api/3/issue/${key}/comment?startAt=${all.length}&maxResults=${ISSUE_PAGE}&orderBy=created&expand=properties`);
      const batch = res.comments ?? [];
      all.push(...batch.map((c) => {
        const text = fromAdf(c.body);
        const { found, marker } = propertyMarker(c.properties);
        const own = marker !== null && text === NO_TEXT ? "" : text;
        return {
          id: c.id,
          body: !found ? text : `${neutraliseMarkers(own)}${marker === null ? "" : `\n\n${marker}`}`,
          created_at: iso(c.created) ?? "",
          user: c.author?.accountId ? { login: c.author.accountId } : null,
        };
      }));
      if (batch.length === 0 || all.length >= (res.total ?? 0)) return all;
    }
    throw new Error(`${key} has more comments than ${MAX_ISSUE_PAGES} pages carry`);
  }

  /**
   * The text as ADF, its marker as the `landrace.marker` property. On a
   * service desk, marked internal unless the effect says public: a record or
   * a note nobody chose to show the requester is never shown them. Elsewhere
   * every comment is the team's, and visibility is not asked. A project whose
   * type Jira does not name is refused before anything is posted — public is
   * never a guess.
   */
  async comment(id: string, body: string, ctx: RuntimeContext, { visibility }: { visibility?: CommentVisibility } = {}): Promise<void> {
    const key = this.keyOf(id);
    const jira = this.jira(ctx);
    const { type } = await this.projectOf(jira);
    if (type === undefined) {
      throw new Error(`Jira answered ${this.project} with no project type, so whether a comment on ${key} would reach its requester cannot be told; nothing was posted`);
    }
    const split = splitMarker(body);
    // What the marker was set apart by goes with it, so the text reads back with the marker exactly as it was.
    const { marker } = split;
    const trimmed = marker === null ? split.text : split.text.trimEnd();
    const text = marker !== null && trimmed.trim() === "" ? NO_TEXT : trimmed;
    const properties = [
      ...(marker === null ? [] : [{ key: MARKER_PROPERTY, value: { marker } }]),
      ...(type === SERVICE_DESK && visibility !== "public" ? [{ key: INTERNAL_PROPERTY, value: { internal: true } }] : []),
    ];
    await jira.call("POST", `/rest/api/3/issue/${key}/comment`, {
      body: adfOf(text, `comment on ${key}`, await this.mentions(jira, text)),
      ...(properties.length === 0 ? {} : { properties }),
    });
  }

  /**
   * Each `@[…]` outside code a comment holds, as a mention: an account id as
   * written, an email as the one user it is — none or several, and it stays
   * text, as `jiraAssignee` would refuse it.
   */
  private async mentions(jira: Client, text: string): Promise<Mention> {
    const nodes = new Map<string, AdfNode>();
    for (const token of mentionsIn(text)) {
      if (!token.includes("@")) {
        if (ACCOUNT_ID.test(token)) nodes.set(token, { type: "mention", attrs: { id: token, text: `@[${token}]` } });
        continue;
      }
      const [only, ...more] = (await usersWithEmail(jira, token)) ?? [];
      if (only === undefined || more.length > 0 || typeof only.accountId !== "string" || !ACCOUNT_ID.test(only.accountId)) continue;
      nodes.set(token, { type: "mention", attrs: { id: only.accountId, text: `@${only.displayName ?? token}` } });
    }
    return (token) => nodes.get(token) ?? null;
  }

  /** Every worklog on the issue, every page, its marker read off its `landrace.marker` property. */
  private async worklogs(jira: Client, key: string): Promise<WorklogRecord[]> {
    const all: WorklogRecord[] = [];
    for (let page = 0; page < MAX_ISSUE_PAGES; page++) {
      const res = await jira.call<{
        worklogs?: Array<{ id?: unknown; author?: User; timeSpentSeconds?: unknown; properties?: Property[] }>; total?: number;
      }>("GET", `/rest/api/3/issue/${key}/worklog?startAt=${all.length}&maxResults=${ISSUE_PAGE}&expand=properties`);
      const batch = res.worklogs ?? [];
      all.push(...batch.map((w) => {
        const value = (w.properties ?? []).find((p) => p?.key === MARKER_PROPERTY)?.value as { marker?: unknown } | null | undefined;
        return {
          id: String(w.id),
          author: w.author?.accountId ?? null,
          seconds: typeof w.timeSpentSeconds === "number" ? w.timeSpentSeconds : 0,
          marker: typeof value?.marker === "string" ? value.marker : null,
        };
      }));
      if (batch.length === 0 || all.length >= (res.total ?? 0)) return all;
    }
    throw new Error(`${key} has more worklogs than ${MAX_ISSUE_PAGES} pages carry`);
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
   * Scoped, it is assigned to `jiraAssignee`, a child too: unassigned, the
   * list would never see it.
   */
  async create(
    { title, body, parent, priority }: { title: string; body: string; parent: string | undefined; priority: number | undefined },
    ctx: RuntimeContext,
  ): Promise<string> {
    // Checked before anything is created, so a bad parent leaves nothing behind.
    const under = parent === undefined ? undefined : this.keyOf(parent);
    const description = adfOf(body, `description for a new ${this.project} issue`);
    const jira = this.jira(ctx);
    let priorityId: string | undefined;
    if (priority !== undefined) {
      const ids = await this.priorityIds(jira);
      priorityId = ids[Math.min(Math.max(priority, 0), ids.length - 1)];
      if (priorityId === undefined) throw new Error(`${this.project} has no priorities to give a new issue`);
    }
    const assignee = await assigneeOf(jira, ctx);
    const created = await jira.call<{ key?: unknown } | null>("POST", "/rest/api/3/issue", {
      fields: {
        project: { key: this.project },
        summary: title,
        issuetype: { name: under === undefined ? this.issueType : this.childType },
        description,
        ...(under === undefined ? {} : { parent: { key: under } }),
        ...(priorityId === undefined ? {} : { priority: { id: priorityId } }),
        ...(assignee === null ? {} : { assignee: { accountId: assignee } }),
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
      ...(body === undefined ? {} : { description: adfOf(body, `description for ${key}`) }),
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

  override createsIn(): string[] {
    return [...this.createProjects];
  }

  /**
   * One request: the issue, its link to the item, its assignee and the
   * property saying landrace filed it for this item — Jira takes all four at
   * once, so a refused link files nothing. Unlabelled, and in another
   * project, so it is never one of this tracker's items. A request Jira
   * refuses is refused here too: no retry makes it fit.
   */
  protected override async createIn(request: CreateRequest, ctx: RuntimeContext): Promise<string> {
    const item = this.keyOf(request.item);
    const jira = this.jira(ctx);
    const assignee = await assigneeOf(jira, ctx);
    const fields = await this.fieldsOf(jira, request);
    const send = (plain: ReadonlySet<string>) => jira.call<{ key?: unknown } | null>("POST", "/rest/api/3/issue", {
      fields: {
        project: { key: request.project },
        summary: summaryOf(request.title),
        issuetype: { name: this.createType },
        description: adfOf(request.body, `description for a new ${request.project} issue`),
        ...Object.fromEntries(fields.map(({ id, text, doc }) => [id, doc === null || plain.has(id) ? text : doc])),
        ...(assignee === null ? {} : { assignee: { accountId: assignee } }),
      },
      update: { issuelinks: [{ add: { type: { name: this.createLinkType }, outwardIssue: { key: item } } }] },
      properties: [{ key: CREATED_BY, value: { item, marker: request.marker } }],
    });
    let created: { key?: unknown } | null;
    try {
      try {
        created = await send(new Set());
      } catch (asDocs) {
        /*
         * A textarea's renderer is in its field configuration, which only an
         * account with "Administer Jira" may read, so Jira's refusal of the
         * document by name says it takes a string, as `JiraField` learns it.
         * A 400 filed nothing, so asking again files one issue.
         */
        const plain = new Set(fields.filter((f) => f.doc !== null && refusesField(asDocs, f.id)).map((f) => f.id));
        if (plain.size === 0) throw asDocs;
        created = await send(plain);
      }
    } catch (e) {
      const status = (e as { status?: unknown } | null)?.status;
      if (status === 400 || isRefused(e)) throw new EffectRefused(`Jira refused to file an issue in ${request.project}: ${messageOf(e)}`);
      throw e;
    }
    const key = created?.key;
    if (typeof key !== "string" || !new RegExp(`^${request.project}-[1-9][0-9]*$`).test(key)) {
      throw new Error(`Jira filed an issue but answered no ${request.project} key for it: ${JSON.stringify(created)}`);
    }
    return key;
  }

  /**
   * Each field a `tracker.create` fills, in the shape it takes: a textarea a
   * document, as `JiraField` writes a spec — the string beside it, for a
   * plain-text renderer — and a text field a string of at most 255
   * characters. A field the site lacks, one that is not text, or a value past
   * its bound is refused before the request: no retry makes it fit.
   */
  private async fieldsOf(jira: Client, request: CreateRequest): Promise<Array<{ id: string; text: string; doc: AdfDoc | null }>> {
    const asked = Object.entries(request.fields ?? {});
    if (asked.length === 0) return [];
    const all = await jira.call<Field[] | null>("GET", "/rest/api/3/field") ?? [];
    return asked.map(([id, text]) => {
      const field = all.find((f) => f.id === id);
      if (field === undefined) throw new EffectRefused(`the site has no field ${id}, which a tracker.create fills in ${request.project}`);
      const shape = shapeOf(field);
      if (shape === "adf") return { id, text, doc: adfOf(text, `${id} for a new ${request.project} issue`) };
      if (shape !== "string") throw new EffectRefused(shape);
      if (text.length > MAX_TEXTFIELD) {
        throw new EffectRefused(`refusing to write a ${text.length}-character ${id}: a text field holds at most ${MAX_TEXTFIELD}`);
      }
      return { id, text, doc: null };
    });
  }

  /**
   * The issue already filed for this item and marker: of the item's links of
   * `createLinkType` into the project, the one whose property says so. Links
   * that cannot be read refuse rather than answer none — a second issue is
   * the failure this is here to prevent.
   */
  protected override async createdBy(request: CreateRequest, ctx: RuntimeContext): Promise<string | null> {
    const item = this.keyOf(request.item);
    const jira = this.jira(ctx);
    const issue = await jira.call<Issue | null>("GET", `/rest/api/3/issue/${item}?fields=issuelinks`);
    const links = issue?.fields?.issuelinks;
    if (!Array.isArray(links)) throw new Error(`${item}'s links could not be read, so whether an issue was already filed for it cannot be told`);
    const keys = new Set<string>();
    for (const entry of links as Array<LinkEntry | null>) {
      if (entry?.type?.name !== this.createLinkType) continue;
      for (const end of [entry.inwardIssue, entry.outwardIssue]) {
        if (typeof end?.key === "string" && SITE_KEY.test(end.key) && end.key.startsWith(`${request.project}-`)) keys.add(end.key);
      }
    }
    for (const key of keys) {
      let property: { value?: { item?: unknown; marker?: unknown } } | null;
      try {
        property = await jira.call<{ value?: { item?: unknown; marker?: unknown } } | null>(
          "GET", `/rest/api/3/issue/${key}/properties/${CREATED_BY}`,
        );
      } catch (e) {
        if (isMissing(e)) continue;
        throw e;
      }
      if (property?.value?.item === item && property.value.marker === request.marker) return key;
    }
    return null;
  }

  /**
   * `tracker.status` too, the issue's status by name, when a stage maps one:
   * what the status effect is judged by. Worklogs are not observed: Jira
   * answers their read with an error where time tracking is off, which would
   * fail every item's read on a site that never logs time.
   */
  override provides(): string[] {
    const own = super.provides();
    return this.statuses.size === 0 ? own : [...own, "tracker.status"];
  }

  override async observe(ctx: HookContext): Promise<Record<string, unknown>> {
    const observed = await super.observe(ctx);
    if (this.statuses.size === 0) return observed;
    const status = await this.statusOf(this.jira(ctx), this.keyOf(ctx.item));
    return { ...observed, tracker: { ...(observed.tracker as Record<string, unknown>), status } };
  }

  /** The issue's status by name, read off the issue rather than search, which lags a transition just made. */
  private async statusOf(jira: Client, key: string): Promise<string | undefined> {
    return (await jira.call<Issue>("GET", `/rest/api/3/issue/${key}?fields=status`)).fields?.status?.name;
  }

  /**
   * `tracker.status` as the base moves it — the stage label — and then, for a
   * mapped stage, the issue's status: satisfied once the label is there and
   * the issue is in the mapped status, whatever its case.
   */
  override effects(): EffectTable {
    const base = super.effects();
    const label = base[STATUS_EFFECT];
    if (!label) return base;
    return {
      ...base,
      [WORKLOG_EFFECT]: {
        // Judged in apply, over the worklogs read there: the snapshot holds
        // none (see provides), and a route's effect is applied with no
        // reconcile first, so a check here alone would never stop a POST.
        satisfied: () => false,
        // A 403 is the account without "Work on issues", or time tracking
        // off, and so is a 404 on reading the worklogs of an issue this tick
        // just read: no retry logs it, so the round is recorded refused
        // rather than its step paid for again.
        apply: async (effect, ctx) => {
          const key = this.keyOf(ctx.item);
          const { seconds } = effect;
          if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds <= 0) {
            throw new Error(`a ${WORKLOG_EFFECT} effect logs a whole number of seconds above zero, not ${JSON.stringify(seconds)}`);
          }
          const jira = this.jira(ctx);
          const refused = (e: unknown, statuses: unknown[]): unknown => (!statuses.includes((e as { status?: unknown } | null)?.status) ? e : new EffectRefused(
            `Jira refused to log time on ${key}: the account needs "Work on issues" on ${this.project}, with time tracking on (Jira answered: ${messageOf(e)})`,
          ));
          let worklogs: WorklogRecord[];
          try {
            worklogs = await this.worklogs(jira, key);
          } catch (e) {
            throw refused(e, [403, 404]);
          }
          if (worklogLogged(worklogs, effect, botLoginOf(ctx.snapshot))) return;
          try {
            await jira.call("POST", `/rest/api/3/issue/${key}/worklog`, {
              timeSpentSeconds: seconds,
              properties: [{ key: MARKER_PROPERTY, value: { marker: worklogMarker(effect) } }],
            });
          } catch (e) {
            throw refused(e, [403]);
          }
        },
      },
      [FIELD_EFFECT]: {
        // Off `node.state.fields`, which every read fills with the fields the loaded
        // tracker.field effects set: a field missing there was not read, and not read
        // is not empty. A user given by email is its account once apply or the
        // preflight has resolved it; until then it does not hold, and apply judges
        // it again over the issue as it is.
        satisfied: (snapshot: Snapshot, effect) => {
          const read = (snapshot.node as Node | undefined)?.state.fields;
          if (read === null || typeof read !== "object" || Array.isArray(read)) return false;
          return wantedFields(effect).every(([id, want]) => {
            if (!Object.hasOwn(read, id)) return false;
            const have = read[id];
            return effect.onlyIfEmpty === true ? !emptyField(have) : this.holds(id, want, have);
          });
        },
        apply: (effect, ctx) => this.setFields(effect, ctx),
      },
      [STATUS_EFFECT]: {
        satisfied: (snapshot: Snapshot, effect) => {
          if (!statusSatisfied(snapshot, effect)) return false;
          const wanted = this.statuses.get(String(effect.value));
          if (wanted === undefined) return true;
          const status = (snapshot.tracker as { status?: unknown } | undefined)?.status;
          return typeof status === "string" && same(status, wanted);
        },
        // The transition is resolved before the label moves, and taken after it: a
        // throw after the label would place the item in its new stage next tick,
        // where this effect, and every on_enter effect after it, is never planned again.
        // So a POST Jira refuses — a validator, a screen's required field — is
        // logged and skipped like an unoffered one: the status is display.
        apply: async (effect, ctx) => {
          const wanted = this.statuses.get(String(effect.value));
          const into = wanted === undefined ? null : await this.transitionInto(ctx.item, wanted, ctx);
          await label.apply(effect, ctx);
          if (!into || wanted === undefined) return;
          const key = this.keyOf(ctx.item);
          try {
            await this.transition(this.jira(ctx), key, into);
          } catch (err) {
            if (!this.sayOnce(key, wanted)) return;
            ctx.log("jira.status.refused", { item: key, status: wanted, transition: into.name, error: (err as Error).message });
          }
        },
      },
    };
  }

  /**
   * Whether a field read holds a `tracker.field`'s value: the names each
   * lists, compared as sets — a select's one value, a multi-select's list —
   * text trimmed, a number as its digits, and a user's email as the account
   * it was resolved to, by field.
   */
  private holds(id: string, want: TrackerFieldValue, have: Json | undefined): boolean {
    if (emptyField(have)) return false;
    const wanted = new Set(namesOf(want).map((name) => (this.accounts.get(JSON.stringify([id, name.toLowerCase()])) ?? name).trim()));
    const held = new Set((Array.isArray(have) ? have : [have]).map((v) => String(v).trim()));
    return wanted.size === held.size && [...wanted].every((name) => held.has(name));
  }

  /** A user value's account, resolved once a process for each field and value, so `satisfied` reads an email as its account. */
  private async accountOf(jira: Client, id: string, value: string): Promise<string> {
    const cached = JSON.stringify([id, value.toLowerCase()]);
    const known = this.accounts.get(cached);
    if (known !== undefined) return known;
    const account = await accountFor(jira, value, `"${value}", which a ${FIELD_EFFECT} sets ${id} to,`);
    this.accounts.set(cached, account);
    return account;
  }

  /**
   * `tracker.field`: judged over the issue as it is now — a route's effect
   * is applied with no reconcile first, and `satisfied` cannot resolve an
   * email — then every field not yet holding its value written in one
   * request, each in the shape its type takes: `{ value }` for a select, a
   * list of them for a multi-select, `{ accountId }` for a user (an email
   * resolved to exactly one), a list of those for several, a number as it
   * is, a text field a string and a textarea a document, as `JiraField`
   * writes one — a string where Jira refuses the document by name, for a
   * plain-text renderer. With `onlyIfEmpty`, only the fields empty on the
   * issue now. A field off the issue's edit screen, of any other type, given
   * a value it does not take, or that Jira refuses, is refused: no retry
   * puts it there. Everything is checked before anything is written.
   */
  private async setFields(effect: Effect, ctx: HookContext): Promise<void> {
    const key = this.keyOf(ctx.item);
    const wanted = wantedFields(effect);
    const onlyIfEmpty = effect.onlyIfEmpty === true;
    const jira = this.jira(ctx);
    const asked = ["issuetype", ...wanted.map(([id]) => id)].map(encodeURIComponent).join(",");
    const issue = await jira.call<{ fields?: Record<string, unknown> } | null>("GET", `/rest/api/3/issue/${key}?fields=${asked}`);
    const { fields: screen = {} } = await jira.call<{ fields?: Record<string, EditField> } | null>("GET", `/rest/api/3/issue/${key}/editmeta`) ?? {};
    const writes: Array<{ id: string; value: unknown; text: string | null }> = [];
    for (const [id, want] of wanted) {
      const field = Object.hasOwn(screen, id) ? screen[id] : undefined;
      if (field === undefined) {
        const type = (issue?.fields?.issuetype as { name?: unknown } | null | undefined)?.name;
        throw new EffectRefused(`${key} is a "${String(type)}" issue, whose edit screen has no ${id} (or the account may not edit it), so a ${FIELD_EFFECT} cannot set it`);
      }
      const kind = fieldKindOf(id, field);
      if (!isKind(kind)) throw new EffectRefused(kind);
      const label = `"${String(field.name)}" (${id})`;
      const problem = valueProblem(label, kind, want) ??
        (kind === "option" || kind === "options" ? namesOf(want).map((name) => optionProblem(label, name, field, "")).find((p) => p !== null) ?? null : null);
      if (problem !== null) throw new EffectRefused(problem);
      const have = fieldValueOf(issue?.fields?.[id]);
      if (onlyIfEmpty && !emptyField(have)) continue;
      writes.push({ id, ...(await this.fieldJson(jira, key, id, kind, want)) });
      if (!onlyIfEmpty && this.holds(id, want, have)) writes.pop();
    }
    if (writes.length === 0) return;
    const send = (plain: ReadonlySet<string>) => jira.call("PUT", `/rest/api/3/issue/${key}`, {
      fields: Object.fromEntries(writes.map(({ id, value, text }) => [id, text !== null && plain.has(id) ? text : value])),
    });
    try {
      try {
        await send(new Set());
      } catch (asDocs) {
        // A textarea's renderer is in its field configuration, which only "Administer Jira" may read: Jira's refusal of the document by name says it takes a string.
        const plain = new Set(writes.filter((w) => w.text !== null && refusesField(asDocs, w.id)).map((w) => w.id));
        if (plain.size === 0) throw asDocs;
        await send(plain);
      }
    } catch (e) {
      const status = (e as { status?: unknown } | null)?.status;
      if (status === 400 || isRefused(e)) {
        throw new EffectRefused(`Jira refused to set ${writes.map((w) => w.id).join(", ")} on ${key}: ${messageOf(e)}`);
      }
      throw e;
    }
  }

  /** A checked value as the request carries it, and a textarea's text beside its document, for a plain-text renderer. */
  private async fieldJson(jira: Client, key: string, id: string, kind: FieldKind, want: TrackerFieldValue): Promise<{ value: unknown; text: string | null }> {
    const account = async (name: string): Promise<{ accountId: string }> => {
      try {
        return { accountId: await this.accountOf(jira, id, name) };
      } catch (e) {
        if (e instanceof NoAccount) throw new EffectRefused(e.message);
        throw e;
      }
    };
    switch (kind) {
      case "option": return { value: { value: namesOf(want)[0] }, text: null };
      case "options": return { value: namesOf(want).map((value) => ({ value })), text: null };
      case "user": return { value: await account(namesOf(want)[0] ?? ""), text: null };
      case "users": {
        const accounts: Array<{ accountId: string }> = [];
        for (const name of namesOf(want)) accounts.push(await account(name));
        return { value: accounts, text: null };
      }
      case "adf": return { value: adfOf(String(want), `${id} on ${key}`), text: String(want) };
      default: return { value: want, text: null };
    }
  }

  /**
   * The values the loaded `tracker.field` effects set, at start: each field
   * on the site and of a type one sets, each value of the shape it takes,
   * each user resolving to exactly one account, and each option among the
   * field's allowed values on the edit screen of every issue type an item
   * can be — read off an open issue of each, as `JiraField` reads them. A
   * type whose screen lacks the field is logged, `jira.tracker-field.missing`,
   * and its items are refused when the effect is applied; a type with no open
   * issue to look at is logged, `jira.tracker-field.unchecked`; and options
   * no screen could be read for are refused: nothing compared is not a pass.
   */
  private async fieldProblems(jira: Client, ctx: PreflightContext, declared: Array<[string, readonly TrackerFieldValue[]]>): Promise<string[]> {
    const problems: string[] = [];
    const all = await jira.call<Field[] | null>("GET", "/rest/api/3/field") ?? [];
    const options: Array<{ id: string; label: string; names: string[] }> = [];
    for (const [id, values] of declared) {
      const field = all.find((f) => f.id === id);
      if (field === undefined) {
        problems.push(`the site has no field ${id}, which a ${FIELD_EFFECT} sets`);
        continue;
      }
      const kind = fieldKindOf(id, field);
      if (!isKind(kind)) {
        problems.push(kind);
        continue;
      }
      const label = `"${String(field.name)}" (${id})`;
      for (const value of values) {
        const problem = valueProblem(label, kind, value);
        if (problem !== null) {
          problems.push(problem);
          continue;
        }
        if (kind === "user" || kind === "users") {
          for (const name of namesOf(value)) {
            try {
              await this.accountOf(jira, id, name);
            } catch (e) {
              if (!(e instanceof NoAccount)) throw e;
              problems.push(e.message);
            }
          }
        }
        if (kind === "option" || kind === "options") options.push({ id, label, names: namesOf(value) });
      }
    }
    if (options.length === 0) return problems;
    const ids = [...new Set(options.map((o) => o.id))];
    const { screens, unchecked } = await editScreens(jira, ctx, {
      project: this.project, jql: this.jql, itemTypes: [this.issueType, this.childType], keyPattern: this.keyPattern,
    });
    if (screens.length === 0) {
      problems.push(`there is no open issue of any issue type an item of ${this.project} can be to read an edit screen from, so whether ${ids.join(", ")} offer the options a ${FIELD_EFFECT} sets cannot be told`);
      return problems;
    }
    if (unchecked.length > 0) ctx.log("jira.tracker-field.unchecked", { fields: ids, types: unchecked, reason: "no open issue of the type to read its edit screen from" });
    for (const { type, fields } of screens) {
      for (const id of ids) {
        if (!Object.hasOwn(fields, id)) {
          ctx.log("jira.tracker-field.missing", {
            field: id, type, reason: "not on the type's edit screen, or the account may not edit it: a tracker.field setting it on these items is refused",
          });
        }
      }
    }
    const said = new Set<string>();
    for (const { id, label, names } of options) {
      for (const { type, fields } of screens) {
        const field = Object.hasOwn(fields, id) ? fields[id] : undefined;
        if (field === undefined) continue;
        for (const name of names) {
          const problem = optionProblem(label, name, field, ` on ${this.project}'s "${type}" issues`);
          if (problem !== null && !said.has(problem)) {
            said.add(problem);
            problems.push(problem);
          }
        }
      }
    }
    return problems;
  }

  /**
   * The one transition into `wanted`, or none when the issue is in it
   * already. Two into it halt rather than pick one. None offered is logged
   * once per item and status a process and skipped: the status is display,
   * and an item does not stop for it.
   */
  private async transitionInto(id: string, wanted: string, ctx: RuntimeContext): Promise<Transition | null> {
    const key = this.keyOf(id);
    const jira = this.jira(ctx);
    const status = await this.statusOf(jira, key);
    if (same(status, wanted)) return null;
    const offered = await this.offered(jira, key);
    const into = offered.filter((t) => same(t.to?.name, wanted));
    const [only] = into;
    if (!only) {
      if (!this.sayOnce(key, wanted)) return null;
      ctx.log("jira.status.unoffered", { item: key, status: wanted, from: status, offered: offeredList(offered) });
      return null;
    }
    if (into.length > 1) {
      throw new Error(`${key} offers ${into.length} transitions into "${wanted}": ${into.map((t) => `"${t.name}"`).join(", ")}; which one moves it is not a guess`);
    }
    return only;
  }

  /** True the first time a process is told of an item and status it cannot move into, so a refusal is logged once. */
  private sayOnce(key: string, wanted: string): boolean {
    const said = JSON.stringify([key, wanted.trim().toLowerCase()]);
    if (this.statusSaid.has(said)) return false;
    this.statusSaid.add(said);
    return true;
  }

  /** Jira's issue links of `blockedByLinkType`, read off each issue's own `issuelinks`. */
  protected override readRelations(): string[] {
    return [RELATIONS.blockedBy];
  }

  protected override writableRelations(): string[] {
    return [RELATIONS.blockedBy];
  }

  /**
   * Any issue on the site: a blocker may be in another project, and is read
   * and written as one of this tracker's own. The walk goes through it, but
   * finds nothing there — it lists the configured project's open issues
   * alone — so a cycle through another project goes unseen.
   */
  protected override ownsId(id: string): boolean {
    return SITE_KEY.test(id);
  }

  /**
   * A link with the blocker as `inwardIssue` and the blocked issue as
   * `outwardIssue`: Jira gives the outward words, "blocks", to the issue
   * sent as `inwardIssue`. One already there is done — Jira says it answers
   * a duplicate as created, and it is not asked.
   */
  protected async addRelation(item: string, type: string, other: string, ctx: RuntimeContext): Promise<void> {
    await this.linking(`relate ${item} to ${other}`, item, type, other, ctx, async (jira, { blockers }) => {
      if (blockers.some((b) => b.key === other)) return;
      try {
        await jira.call("POST", "/rest/api/3/issueLink", {
          type: { name: this.linkType }, inwardIssue: { key: other }, outwardIssue: { key: item },
        });
      } catch (e) {
        // Both ends were just read: a 404 now is Jira's answer for an account without "Link issues", or a type the site lacks.
        if (isRefused(e)) throw this.mayNotLink(e, other, isMissing(e) ? `or the site has no "${this.linkType}" link type` : "");
        throw e;
      }
    });
  }

  /**
   * Every link of the type from `other` to `item`, deleted by its id. None
   * is done — but only off links read whole: one that could not be read may
   * be it. Jira answers 404 both for a link already gone and for an account
   * without "Link issues", so a 404 is read again to tell which.
   */
  protected async removeRelation(item: string, type: string, other: string, ctx: RuntimeContext): Promise<void> {
    await this.linking(`unrelate ${item} from ${other}`, item, type, other, ctx, async (jira, { blockers, whole }) => {
      const links = blockers.filter((b) => b.key === other);
      if (links.length === 0 && !whole) throw new Error(`${item}'s links could not all be read, so whether ${other} blocks it cannot be told`);
      for (const { link } of links) {
        if (link === null) throw new Error(`Jira answered ${item}'s link to ${other} with no usable id`);
        try {
          await jira.call("DELETE", `/rest/api/3/issueLink/${link}`);
        } catch (e) {
          if (!isRefused(e)) throw e;
          const still = isMissing(e) ? (await this.linksOf(jira, item)).blockers.some((b) => b.link === link) : true;
          if (still) throw this.mayNotLink(e, other);
        }
      }
    });
  }

  /**
   * What a link write would refuse, asked before anything is written — by
   * the very lookup the write makes, so the two cannot disagree about what
   * the other end is.
   */
  protected override async relationProblem(item: string | null, type: string, other: string, ctx: RuntimeContext): Promise<string | null> {
    try {
      await this.blockerOf(item, type, other, ctx);
      return null;
    } catch (e) {
      return messageOf(e);
    }
  }

  /** One link write, once both ends are known, over the blocked issue's links as they are now — or a refusal saying why there is none. */
  private async linking(
    what: string, item: string, type: string, other: string, ctx: RuntimeContext,
    write: (jira: Client, links: { blockers: Blocker[]; whole: boolean }) => Promise<void>,
  ): Promise<void> {
    try {
      await this.blockerOf(item, type, other, ctx);
      const jira = this.jira(ctx);
      await write(jira, await this.linksOf(jira, item));
    } catch (e) {
      throw new Error(`cannot ${what} as "${type}": ${messageOf(e)}`);
    }
  }

  /** The blocked issue's own links, read off the issue rather than search, which lags a link just made. */
  private async linksOf(jira: Client, item: string): Promise<{ blockers: Blocker[]; whole: boolean }> {
    const issue = await jira.call<Issue | null>("GET", `/rest/api/3/issue/${this.keyOf(item)}?fields=issuelinks`);
    // Jira answers a moved issue's old key with the issue under its new one: a link written there is on an issue the id no longer names.
    if (issue?.key !== item) throw new Error(`${item} has moved to ${String(issue?.key)}; landrace will not follow an issue to a new key`);
    return blockersIn(issue.fields?.issuelinks, this.linkType);
  }

  /**
   * Why `item` — one of the project's, or null for one not yet created —
   * cannot be blocked by `other`, thrown; nothing when it can. The other end
   * may be any issue on the site the account can see, under the key it has:
   * one Jira answers under another has moved, and a link to it would read
   * back under a key nobody asked for.
   */
  private async blockerOf(item: string | null, type: string, other: string, ctx: RuntimeContext): Promise<void> {
    if (type !== RELATIONS.blockedBy) throw new Error(`this Jira integration writes only "${RELATIONS.blockedBy}"`);
    if (item !== null) this.keyOf(item);
    if (!SITE_KEY.test(other)) throw new Error(`"${other}" is not a Jira issue key`);
    let found: { key?: unknown } | null;
    try {
      found = await this.jira(ctx).call<{ key?: unknown } | null>("GET", `/rest/api/3/issue/${other}?fields=status`);
    } catch (e) {
      // Jira answers 403 or 404 for an issue the account may not see, as it does for none at all.
      if (isRefused(e)) throw new Error(`${other} is not an issue on this site, or this account cannot see it`);
      throw e;
    }
    if (found?.key !== other) throw new Error(`${other} has moved to ${String(found?.key)}; landrace will not follow an issue to a new key`);
  }

  /**
   * A link write Jira refused, as the permission it takes, in Jira's own
   * words too. Jira checks "Link issues" on one end's project for a new link
   * and on either's for a removal, and does not say which it found missing:
   * a blocker elsewhere names both projects.
   */
  private mayNotLink(e: unknown, other: string, or = ""): Error {
    const there = other.slice(0, other.lastIndexOf("-"));
    const projects = there === this.project ? this.project : `${this.project}, or on ${there}, the blocker's project`;
    return new Error(`the account needs the "Link issues" permission on ${projects}${or ? `, ${or}` : ""} (Jira answered: ${messageOf(e)})`);
  }

  /**
   * Startup, before anything is paid for: each permission the account lacks
   * on the project, each issue type it does not have, and each type without a
   * labels field — an item's position is a label. `childType` only when a
   * loaded step may create children, or the caller cannot say: projects name
   * it differently, a service desk may have none, and nothing else makes one. Scoped by `jiraAssignee`,
   * an assignee that resolves to no one user, or that cannot be looked up for
   * want of "Browse users and groups", or that the project cannot assign
   * issues to, "Assign Issues", and each type without an assignee field too. For each `createIn` project, the
   * same of filing an issue there: "Browse projects", "Create issues" and "Link issues", the assignee,
   * `createType`, `createLinkType` on the site, and each field a loaded route's `tracker.create` there
   * fills (`fieldsFrom`) on `createType`'s create screen and a text or textarea one. Each value a loaded
   * `tracker.field` sets, as `fieldProblems` checks it. Reads only: every write shows in the
   * project's history, so the preflight makes none.
   */
  async check(ctx: PreflightContext): Promise<void> {
    const jira = this.jira(ctx);
    const problems: string[] = [];
    const value = ctx.secrets.get("jiraAssignee")?.trim() ?? "";
    const scoped = value !== "";
    let assignee: string | null = null;
    try {
      assignee = await assigneeOf(jira, ctx);
    } catch (e) {
      problems.push(messageOf(e));
    }
    const asked = scoped ? [...PERMISSIONS, "ASSIGN_ISSUES"] : PERMISSIONS;
    const { permissions = {} } = await jira.call<{ permissions?: Record<string, { name?: string; havePermission?: boolean }> }>(
      "GET", `/rest/api/3/mypermissions?projectKey=${this.project}&permissions=${asked.join(",")}`,
    );
    for (const key of asked) {
      if (permissions[key]?.havePermission !== true) {
        problems.push(`the account lacks "${permissions[key]?.name ?? key}" (${key}) on ${this.project}`);
      }
    }
    // A user read finds an account with no access to the project, or a deactivated one, too: it would list
    // nothing, and the first create would fail with "cannot be assigned issues" after a step is paid for.
    if (assignee !== null && permissions.BROWSE_PROJECTS?.havePermission === true) {
      const assignable = await jira.call<User[] | null>(
        "GET", `/rest/api/3/user/assignable/search?project=${this.project}&accountId=${encodeURIComponent(assignee)}`,
      ) ?? [];
      if (!assignable.some((u) => u.accountId === assignee)) {
        problems.push(`jiraAssignee "${value}" is account ${assignee}, which ${this.project} cannot assign issues to`);
      }
    }
    // Create metadata answers only an account that may browse the project and create in it.
    if (permissions.BROWSE_PROJECTS?.havePermission === true && permissions.CREATE_ISSUES?.havePermission === true) {
      const path = `/rest/api/3/issue/createmeta/${this.project}/issuetypes`;
      const types = await everyPage<{ id?: string; name?: string }>(jira, path);
      const creates = ctx.capabilities === undefined || mayCreateItems([...ctx.capabilities]);
      for (const wanted of new Set(creates ? [this.issueType, this.childType] : [this.issueType])) {
        const type = types.find((t) => t.name === wanted);
        if (!type?.id) {
          problems.push(`${this.project} has no issue type "${wanted}"; it has ${types.map((t) => `"${t.name}"`).join(", ") || "none"}`);
          continue;
        }
        const fields = await everyPage<{ fieldId?: string }>(jira, `${path}/${encodeURIComponent(type.id)}`);
        if (!fields.some((f) => f.fieldId === "labels")) {
          problems.push(`${this.project}'s "${wanted}" issues have no labels field, and an item's position is a label`);
        }
        if (scoped && !fields.some((f) => f.fieldId === "assignee")) {
          problems.push(`${this.project}'s "${wanted}" issues have no assignee field, and jiraAssignee assigns each one created`);
        }
      }
    }
    // A service desk's comments reach the requester unless marked internal, so its type decides every comment's
    // visibility; one Jira does not name would refuse every comment, so it refuses to start instead.
    if (permissions.BROWSE_PROJECTS?.havePermission === true) {
      const { type } = await this.projectOf(jira);
      if (type === undefined) {
        problems.push(`Jira answered ${this.project} with no project type, so whether a comment would reach its requester cannot be told`);
      } else if (type === SERVICE_DESK) {
        ctx.log("jira.service-desk", { project: this.project, comments: "internal, unless a route's tracker.comment says visibility: public" });
      }
    }
    // A clause Jira cannot parse would fail every tick's list: asked once, for one issue (Jira refuses to be asked for none), it fails here instead.
    if (this.jql !== undefined) {
      try {
        await jira.call("POST", "/rest/api/3/search/jql", { jql: `project = "${this.project}" AND (${this.jql})`, fields: ["key"], maxResults: 1 });
      } catch (e) {
        problems.push(`jql ${JSON.stringify(this.jql)} does not run in ${this.project}: ${messageOf(e)}`);
      }
    }
    // A mapped status the workflow lacks would be logged as not offered on every item, and never reached.
    if (this.statuses.size > 0 && permissions.BROWSE_PROJECTS?.havePermission === true) {
      const types = await jira.call<Array<{ statuses?: Status[] }> | null>("GET", `/rest/api/3/project/${this.project}/statuses`) ?? [];
      const known = [...new Set(types.flatMap((t) => t.statuses ?? []).flatMap((st) => (st.name === undefined ? [] : [st.name])))];
      for (const [stage, status] of this.statuses) {
        if (!known.some((name) => same(name, status))) {
          problems.push(`statuses.${stage} "${status}" is no status of ${this.project}'s workflow; it has ${known.map((n) => `"${n}"`).join(", ") || "none"}`);
        }
      }
    }
    // Each project `tracker.create` files in, as the project's own: every permission it takes there, the issue
    // type, and, scoped, that the assignee can be given issues there and the type has an assignee field.
    for (const there of this.createProjects) {
      const wanted = scoped ? [...CREATE_PERMISSIONS, "ASSIGN_ISSUES"] : CREATE_PERMISSIONS;
      const { permissions: granted = {} } = await jira.call<{ permissions?: Record<string, { name?: string; havePermission?: boolean }> }>(
        "GET", `/rest/api/3/mypermissions?projectKey=${there}&permissions=${wanted.join(",")}`,
      );
      for (const key of wanted) {
        if (granted[key]?.havePermission !== true) {
          problems.push(`the account lacks "${granted[key]?.name ?? key}" (${key}) on ${there}, where createIn files issues`);
        }
      }
      if (assignee !== null && granted.BROWSE_PROJECTS?.havePermission === true) {
        const assignable = await jira.call<User[] | null>(
          "GET", `/rest/api/3/user/assignable/search?project=${there}&accountId=${encodeURIComponent(assignee)}`,
        ) ?? [];
        if (!assignable.some((u) => u.accountId === assignee)) {
          problems.push(`jiraAssignee "${value}" is account ${assignee}, which ${there} cannot assign issues to`);
        }
      }
      if (granted.BROWSE_PROJECTS?.havePermission !== true || granted.CREATE_ISSUES?.havePermission !== true) continue;
      const path = `/rest/api/3/issue/createmeta/${there}/issuetypes`;
      const types = await everyPage<{ id?: string; name?: string }>(jira, path);
      const type = types.find((t) => t.name === this.createType);
      if (!type?.id) {
        problems.push(`${there} has no issue type "${this.createType}" (createType); it has ${types.map((t) => `"${t.name}"`).join(", ") || "none"}`);
        continue;
      }
      // The fields the loaded routes' tracker.create fills here, each on the create screen and each text.
      const mapped = [...(ctx.createFields?.get(there) ?? [])];
      if (scoped || mapped.length > 0) {
        const fields = await everyPage<{ fieldId?: string; name?: unknown; schema?: Field["schema"] }>(jira, `${path}/${encodeURIComponent(type.id)}`);
        if (scoped && !fields.some((f) => f.fieldId === "assignee")) {
          problems.push(`${there}'s "${this.createType}" issues have no assignee field, and jiraAssignee assigns each one filed`);
        }
        for (const id of mapped) {
          const field = fields.find((f) => f.fieldId === id);
          if (field === undefined) {
            problems.push(`${there}'s "${this.createType}" issues have no ${id} on their create screen, and a tracker.create fills it`);
            continue;
          }
          const shape = shapeOf({ id, name: field.name, schema: field.schema ?? null });
          if (shape !== "adf" && shape !== "string") problems.push(shape);
        }
      }
    }
    // blocked-by is read off links of one type: a site without it would read every item as blocked by nothing.
    // The blocker is the link's inward end, so the type's inward side must say so; one that reads the same both ways cannot.
    try {
      const { issueLinkTypes = [] } = await jira.call<{ issueLinkTypes?: Array<{ name?: string; inward?: string; outward?: string }> }>(
        "GET", "/rest/api/3/issueLinkType",
      );
      const type = issueLinkTypes.find((t) => t.name === this.linkType);
      if (!type) {
        problems.push(
          `the site has no issue link type "${this.linkType}" (blockedByLinkType), which blocked-by is read from; ` +
          `it has ${issueLinkTypes.map((t) => `"${t.name}"`).join(", ") || "none"}`,
        );
      } else if (same(type.inward, type.outward ?? "")) {
        problems.push(
          `"${this.linkType}" (blockedByLinkType) reads "${type.inward ?? ""}" both ways, so which end blocks cannot be told; ` +
          'name a type whose inward side reads "is blocked by", as Jira\'s "Blocks" does',
        );
      } else {
        ctx.log("jira.blocked-by.link-type", { linkType: this.linkType, blocker: "inward", inward: type.inward, outward: type.outward });
      }
      if (this.createProjects.length > 0 && !issueLinkTypes.some((t) => t.name === this.createLinkType)) {
        problems.push(
          `the site has no issue link type "${this.createLinkType}" (createLinkType), which links an issue createIn files to its item; ` +
          `it has ${issueLinkTypes.map((t) => `"${t.name}"`).join(", ") || "none"}`,
        );
      }
    } catch (e) {
      if (!isMissing(e)) throw e;
      problems.push(`issue linking is disabled on this site, and blocked-by is read off "${this.linkType}" links (blockedByLinkType)`);
    }
    const fieldValues = [...(ctx.fieldValues ?? [])];
    if (fieldValues.length > 0) problems.push(...await this.fieldProblems(jira, ctx, fieldValues));
    if (problems.length > 0) throw new Error(problems.join("; "));
  }
}
