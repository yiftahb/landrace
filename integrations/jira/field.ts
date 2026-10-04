/*
 * One Jira issue field as a project's docs: each item's spec is the text of
 * a custom field on its own issue — a multi-line "Technical design", say —
 * where the team already reads and writes it. A field a person filled counts
 * as a spec, which is the point. Everything else a docs integration does is
 * `BaseDocs`'s; the site, the account and the `jiraAssignee` scope are the
 * tracker's, over the same client.
 */
import type { RuntimeContext } from "landrace/hooks";
import { BaseDocs, EffectRefused } from "landrace/kit";
import { fromAdf } from "./adf.js";
import { type Client, clientFor, isMissing, refusesField } from "./client.js";
import { adfOf, type Jira, scopeOf, search } from "./tracker.js";

export interface JiraFieldOptions {
  /**
   * The tracker this sits beside: its project's issues, and only theirs, have
   * a spec. Taken from it rather than spelled again, so a typo cannot pass
   * the preflight against one project and fail every item of the other.
   */
  tracker: Jira;
  /** The custom field the spec is kept in, by its id: `customfield_10050`. A text or a textarea field. */
  field: string;
  fetchImpl?: typeof fetch | undefined;
}

const TEXTAREA = "com.atlassian.jira.plugin.system.customfieldtypes:textarea";
const TEXTFIELD = "com.atlassian.jira.plugin.system.customfieldtypes:textfield";

/** Jira's bound on a single-line text field. */
const MAX_TEXTFIELD = 255;

/** A field as `GET /field` lists it. */
interface Field { id?: unknown; name?: unknown; schema?: { type?: unknown; custom?: unknown } | null }

/** What the field takes by its type: a textarea a document unless its renderer says a string, a text field a string. */
type Shape = "adf" | "string";

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * An item's spec in one custom field of its Jira issue, over the tracker's
 * client — built from the `jiraBaseUrl`, `jiraEmail` and `jiraToken` secrets.
 */
export class JiraField extends BaseDocs {
  private readonly project: string;
  private readonly field: string;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly keyPattern: RegExp;
  /** Each client's reading of the field's metadata, once: a field's type does not change under a running process. */
  private readonly fields = new WeakMap<Client, Promise<Field | null>>();

  constructor({ tracker, field, fetchImpl }: JiraFieldOptions) {
    super();
    // The project is the tracker's, checked there; the field is spelled into a URL and a JQL query, so nothing but its own characters.
    const { project } = tracker;
    if (!/^customfield_[1-9][0-9]*$/.test(field)) throw new Error(`field must be a custom field's id, customfield_<n>, got "${field}"`);
    this.project = project;
    this.field = field;
    this.fetchImpl = fetchImpl;
    this.keyPattern = new RegExp(`^${project}-[1-9][0-9]*$`);
  }

  private jira(ctx: RuntimeContext): Client {
    return clientFor(ctx, this.fetchImpl);
  }

  private keyOf(id: string): string {
    if (!this.keyPattern.test(id)) throw new Error(`"${id}" is not an issue of ${this.project}: only ${this.project}-<n> is`);
    return id;
  }

  /** The field as the site lists it, or null when it has none of that id. */
  private meta(jira: Client): Promise<Field | null> {
    let known = this.fields.get(jira);
    if (!known) {
      known = jira.call<Field[] | null>("GET", "/rest/api/3/field")
        .then((all) => (all ?? []).find((f) => f.id === this.field) ?? null)
        .catch((e: unknown) => {
          this.fields.delete(jira);
          throw e;
        });
      this.fields.set(jira, known);
    }
    return known;
  }

  /** What the field takes, or why it cannot hold a spec. */
  private static shapeOf(field: Field): Shape | string {
    const custom = field.schema?.custom;
    if (custom === TEXTAREA) return "adf";
    if (custom === TEXTFIELD) return "string";
    return `"${String(field.name)}" (${String(field.id)}) is a ${typeof custom === "string" ? custom : String(field.schema?.type)} field, not a text or textarea one`;
  }

  /**
   * The field's text, or null when it is empty. A textarea answers in ADF or
   * as a plain string, by its renderer, so both are read: ADF as Markdown,
   * a string as it is.
   */
  async page(item: string, ctx: RuntimeContext): Promise<string | null> {
    const key = this.keyOf(item);
    let issue: { key?: unknown; fields?: Record<string, unknown> } | null;
    try {
      issue = await this.jira(ctx).call("GET", `/rest/api/3/issue/${key}?fields=${this.field}`);
    } catch (e) {
      if (isMissing(e)) throw new Error(`${key} is not an issue in ${this.project}, or this account cannot see it`);
      throw e;
    }
    // Jira answers a moved issue's old key with the issue under its new one: its field is no spec of this item's.
    if (issue?.key !== key) throw new Error(`${key} has moved to ${String(issue?.key)}; landrace will not follow an issue to a new key`);
    const value = issue.fields?.[this.field];
    const text = typeof value === "string" ? value : value === null || value === undefined ? "" : fromAdf(value);
    return text.trim() === "" ? null : text;
  }

  /**
   * The field, in the shape it takes: a text field a string of at most 255
   * characters, refused before the request since no retry makes it fit; a
   * textarea a document — plain paragraphs past Jira's bound rich, refused
   * past it even so — or, with the plain-text renderer, a string. Which
   * renderer a textarea has is in its field configuration, which only an
   * account with "Administer Jira" may read, so Jira's own answer says it: a
   * document the field refuses by name is written again as a string, and a
   * string it refuses too names both refusals.
   */
  async publish(item: string, content: string, ctx: RuntimeContext): Promise<void> {
    const key = this.keyOf(item);
    const jira = this.jira(ctx);
    const field = await this.meta(jira);
    if (field === null) throw new Error(`the site has no field ${this.field}`);
    const shape = JiraField.shapeOf(field);
    if (shape !== "adf" && shape !== "string") throw new Error(shape);
    if (shape === "string" && content.length > MAX_TEXTFIELD) {
      throw new EffectRefused(`refusing to write a ${content.length}-character spec to ${this.field}: a text field holds at most ${MAX_TEXTFIELD}`);
    }
    const put = (value: unknown) => jira.call("PUT", `/rest/api/3/issue/${key}`, { fields: { [this.field]: value } });
    if (shape === "string") {
      await put(content);
      return;
    }
    try {
      await put(adfOf(content, `spec for ${key}`));
    } catch (asDoc) {
      if (!refusesField(asDoc, this.field)) throw asDoc;
      try {
        await put(content);
      } catch (asString) {
        throw new Error(`${this.field} took the spec neither as a document (${messageOf(asDoc)}) nor as a string (${messageOf(asString)})`);
      }
    }
  }

  async link(item: string, ctx: RuntimeContext): Promise<string> {
    return `${this.jira(ctx).baseUrl}/browse/${this.keyOf(item)}`;
  }

  /** The project's issues whose field is filled, by one query inside the tracker's scope. */
  async published(ctx: RuntimeContext): Promise<Set<string>> {
    const jira = this.jira(ctx);
    const id = this.field.slice("customfield_".length);
    const found = await search(jira, `project = "${this.project}" AND cf[${id}] is not EMPTY${await scopeOf(jira, ctx)} ORDER BY created ASC`, {
      fields: ["id"],
    });
    if (!found.complete) throw new Error(`${this.project} has more issues with ${this.field} filled than one listing carries`);
    return new Set(found.issues.map((i) => i.key));
  }

  /**
   * The field exists, is a text or textarea field, and is on the edit screen
   * of each of the project's issue types — read off one open issue of each, the
   * only way Jira says what an issue's edit screen holds. Open, because a spec
   * is written to one, and a closed status may make issues non-editable, which
   * answers an empty edit screen. A type with no open issue to look at is unchecked, logged as `jira.field.unchecked`, and a project
   * where no type could be checked fails: nothing compared is not a pass.
   * Reads only.
   */
  async check(ctx: RuntimeContext): Promise<void> {
    const jira = this.jira(ctx);
    const field = await this.meta(jira);
    if (field === null) throw new Error(`the site has no field ${this.field}, which the spec is kept in (JiraField's field)`);
    const shape = JiraField.shapeOf(field);
    if (shape !== "adf" && shape !== "string") throw new Error(shape);
    const project = await jira.call<{ issueTypes?: Array<{ id?: unknown; name?: unknown }> } | null>("GET", `/rest/api/3/project/${this.project}`);
    const types = (project?.issueTypes ?? []).flatMap((t) => (typeof t.id === "string" && /^[0-9]+$/.test(t.id) ? [{ id: t.id, name: String(t.name) }] : []));
    const missing: string[] = [];
    const unchecked: string[] = [];
    for (const type of types) {
      const { issues = [] } = await jira.call<{ issues?: Array<{ key?: unknown }> }>("POST", "/rest/api/3/search/jql", {
        jql: `project = "${this.project}" AND issuetype = ${type.id} AND statusCategory != Done`, fields: ["id"], maxResults: 1,
      });
      const key = issues[0]?.key;
      if (typeof key !== "string" || !this.keyPattern.test(key)) {
        unchecked.push(type.name);
        continue;
      }
      try {
        const { fields = {} } = await jira.call<{ fields?: Record<string, unknown> }>("GET", `/rest/api/3/issue/${key}/editmeta`);
        if (!(this.field in fields)) missing.push(type.name);
      } catch (e) {
        throw new Error(`cannot read ${key}'s edit screen, for its "${type.name}" issues: ${messageOf(e)}`);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `${this.field} ("${String(field.name)}") is not on the edit screen of ${this.project}'s ${missing.map((n) => `"${n}"`).join(", ")} issues ` +
        "(or the account may not edit them), so a spec cannot be written there",
      );
    }
    if (unchecked.length === types.length) {
      throw new Error(`there is no open issue of any of ${this.project}'s issue types to read an edit screen from, so whether ${this.field} is on one cannot be told`);
    }
    if (unchecked.length > 0) ctx.log("jira.field.unchecked", { field: this.field, types: unchecked, reason: "no open issue of the type to read its edit screen from" });
  }
}
