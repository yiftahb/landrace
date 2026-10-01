/*
 * GitHub Pages as a project's docs: where an item's spec page lives on the
 * orphan `gh-pages` branch, the link a person opens, and the contents
 * probes. Everything else a docs integration does is `BaseDocs`'s.
 */
import type { HookContext, RuntimeContext } from "landrace/hooks";
import { BaseDocs } from "landrace/kit";
import { type Client, clientFor, tokenRejected } from "./client.js";

/** An orphan branch: nothing published here is part of main's history, and no checkout is involved. */
const PAGES_BRANCH = "gh-pages";

/**
 * Derived from the item, never stored. There is no artifact id to lose, so
 * the reference survives a crash, a rename and a re-derivation for free.
 */
const pagePath = (item: string): string => `specs/${item}/index.md`;

/** The item a path on the Pages branch is the spec page of, when it is one. */
const itemOfPage = (path: string): string | null => /^specs\/([1-9][0-9]*)\/index\.md$/.exec(path)?.[1] ?? null;

/** The page as a file on GitHub, which anyone who can see the repository can open. */
const fileUrl = (repo: string, item: string): string =>
  `https://github.com/${repo}/blob/${[PAGES_BRANCH, ...pagePath(item).split("/")].map(encodeURIComponent).join("/")}`;

/**
 * Where a Pages site serves the spec pages, or null when it serves none of
 * them. A 200 says a site exists, not that it serves this branch: one built
 * from main's docs folder, or deployed by an Actions workflow, answers every
 * spec path with a 404 — the dead link this exists to stop handing out. The
 * root is GitHub's own `html_url`, so a custom domain needs no configuring.
 */
function pagesRoot(site: unknown): string | null {
  const s = site as { html_url?: unknown; build_type?: unknown; source?: { branch?: unknown; path?: unknown } | null } | null;
  if (s === null || s.build_type === "workflow" || s.source?.branch !== PAGES_BRANCH || s.source.path !== "/") return null;
  if (typeof s.html_url !== "string" || !/^https?:\/\//.test(s.html_url)) {
    throw new Error(`GitHub described the Pages site with no usable html_url (${String(s.html_url)})`);
  }
  return s.html_url.replace(/\/*$/, "/");
}

type SpecLink = (item: string, log: HookContext["log"]) => Promise<string>;

/**
 * A spec page's link, from one question per client: does a Pages site serve
 * the gh-pages branch? The listed node, the read node and the artifact's url
 * all come through here, so they cannot disagree about an item. A private
 * repository with no site 404s at every github.io link, so without a site the
 * link is the file on GitHub, which any viewer of the repository can open.
 *
 * Only an answer is kept, and a 403 is one: this token lacks "Pages: Read",
 * and only a new token changes that, so it links the file until a restart
 * rather than paying a request per call for the same refusal. A 5xx, a
 * dropped connection or a site described with no address says nothing either
 * way, so it costs this call the file link and the next call asks again.
 * Either is said in the log once, not every tick.
 */
function specLinks(gh: Client): SpecLink {
  // ponytail: kept for the process's lifetime — a Pages site enabled or removed, or a token granted Pages: Read, shows after a restart.
  let root: Promise<string | null> | undefined;
  let told = false;
  return async (item, log) => {
    root ??= gh.pagesSite().then(pagesRoot).catch((e: unknown) => {
      const refused = (e as { status?: unknown } | null)?.status === 403;
      if (!refused) root = undefined;
      if (!told) {
        told = true;
        log("github.pages.unknown", {
          reason: `could not tell whether a Pages site serves ${PAGES_BRANCH}, so spec links point at the file ` +
            `on GitHub ${refused ? "until a restart" : "until a later read can"}: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
      return null;
    });
    const at = await root;
    return at === null ? fileUrl(gh.repo, item) : `${at}specs/${item}/`;
  };
}

/** One link cache per client, as there is one client per configuration. */
const links = new WeakMap<Client, SpecLink>();

/**
 * An item's spec, published to GitHub Pages over one client — the one
 * handed in, or the one `ctx.config` builds.
 */
export class GitHubPages extends BaseDocs {
  private readonly client: Client | undefined;

  constructor({ client }: { client?: Client } = {}) {
    super();
    this.client = client;
  }

  private gh(ctx: RuntimeContext): Client {
    return this.client ?? clientFor(ctx);
  }

  async page(item: string, ctx: RuntimeContext): Promise<string | null> {
    return this.gh(ctx).getFile(PAGES_BRANCH, pagePath(item));
  }

  async publish(item: string, content: string, ctx: RuntimeContext): Promise<void> {
    await this.gh(ctx).putFile(PAGES_BRANCH, pagePath(item), content, `landrace: publish the spec for #${item}`);
  }

  async link(item: string, ctx: RuntimeContext): Promise<string> {
    const gh = this.gh(ctx);
    let link = links.get(gh);
    if (!link) links.set(gh, (link = specLinks(gh)));
    return link(item, ctx.log);
  }

  /**
   * Which items have a spec page, from one listing of the whole Pages
   * branch rather than a read per item. A missing branch is simply no pages
   * yet. A listing GitHub cut short is refused rather than read as the
   * whole: part of the pages is a set known to be short, and the board would
   * show a spec on one item and quietly none on the next.
   */
  async published(ctx: RuntimeContext): Promise<Set<string>> {
    const listing = await this.gh(ctx).listFiles(PAGES_BRANCH);
    if (listing === null) return new Set();
    if (listing.truncated) {
      throw new Error(`GitHub truncated its listing of ${PAGES_BRANCH}, so no spec page is reported rather than some of them`);
    }
    return new Set(listing.paths.flatMap((path) => itemOfPage(path) ?? []));
  }

  /**
   * "Contents: Read and write", which reading and publishing the spec and
   * pushing an item's branch all need. A user's fine-grained token had
   * Issues access and Contents read-only: `landrace start` ran, the spec
   * step invoked a paid agent, and only then did publishing fail with a 403 —
   * after the money was spent. So both halves are probed before anything is.
   */
  async check(ctx: RuntimeContext): Promise<void> {
    const gh = this.gh(ctx);
    try {
      // Any path answers the question. Item 0 never exists, so this reads
      // as a 404 on a healthy token rather than risking a real spec
      // directory, which the contents API would answer with a listing
      // `getFile` cannot parse as a file at all.
      await gh.getFile(PAGES_BRANCH, pagePath("0"));
    } catch (e) {
      throw tokenRejected(e) ?? ((e as { status?: unknown } | null)?.status === 403
        ? new Error(`token needs "Contents: Read and write" on ${gh.repo}`)
        : e);
    }

    // The one write the whole check makes, and the reason it has to be a
    // write at all: a fine-grained token cannot report its own permissions
    // the way a classic one's scopes header does.
    try {
      await gh.createEmptyBlob();
    } catch (e) {
      const rejected = tokenRejected(e);
      if (rejected) throw rejected;
      const status = (e as { status?: unknown } | null)?.status;
      if (status === 403) throw new Error(`token needs "Contents: Read and write" on ${gh.repo}`);
      // A fine-grained token with no access to this repository at all gets a
      // 404 here, not a 403 — GitHub will not confirm a private repository
      // exists to a token nobody has shared it with. The read above reads
      // both as a page not there yet, so this is where it surfaces.
      if (status === 404) throw new Error(`token cannot see ${gh.repo} — grant it access to this repository`);
      throw e;
    }
  }
}
