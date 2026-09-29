import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/**
 * What identifies the repository a piece of local scratch state belongs to.
 *
 * The common git directory, resolved: it is the one path every way into a
 * repository agrees on — the top level, any subdirectory below it, a symlink
 * to either, and a linked worktree, which is the same repository driving the
 * same tickets. Both the lock root and the agent's sandbox used to be keyed
 * on a directory *name* instead, and a name is not an identity: the loop and
 * the MCP server found each other's locks only when they were started from
 * the same place, and two unrelated checkouts called `widgets` shared one
 * root — one blocking the other's tickets, and the other deleting the first
 * one's worktree mid-step.
 *
 * Outside a repository — or with no git on the machine — the resolved working
 * directory itself, which is still a place rather than a name.
 */
function repoIdentity(dir: string): string {
  try {
    const out = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: dir,
      encoding: "utf8",
      // git prints its own diagnosis to stderr when this is not a repository,
      // and that is an ordinary answer here, not something to show anybody.
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // Relative to the directory it was asked from (".git", "../../.git") for
    // an ordinary checkout, absolute for a linked worktree. Both resolve here.
    if (out !== "") return realpathSync(resolve(dir, out));
  } catch {
    // Not a repository, or git is not installed. Either way there is nothing
    // to derive, and a root is still needed.
  }
  return realpathSync(dir);
}

/** The repository's own name, for a human reading $TMPDIR — never the identity itself. */
const nameOf = (identity: string): string => {
  const dir = basename(identity) === ".git" ? dirname(identity) : identity;
  return basename(dir).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40) || "repo";
};

// One git call per directory asked about, not one per operation: `held`,
// `acquire` and `release` each ask for the root, and a tick asks for all
// three per ticket.
const roots = new Map<string, string>();
const identities = new Map<string, string>();

const identityOf = (dir: string): string => {
  const cached = identities.get(dir);
  if (cached !== undefined) return cached;
  const identity = repoIdentity(dir);
  identities.set(dir, identity);
  return identity;
};

/**
 * The repository, as a short digest of its identity: what keeps two
 * repositories' scratch apart, and what a pairing's session id is derived
 * from, so two checkouts pairing on their own ticket 29 never share one.
 */
export const repoDigest = (dir: string): string =>
  createHash("sha256").update(identityOf(dir)).digest("hex").slice(0, 12);

/**
 * `$TMPDIR/landrace/<repo>/` — everything local this repository owns, which
 * §7 names as the lock root and which the agent's worktrees sit beside.
 *
 * tmpdir resolved up front: git and the OS report /var as /private/var on
 * macOS, and a path comparison against an unresolved tmpdir silently never
 * matches. Every path under this is compared against it later, so the root
 * itself has to already be in real terms.
 */
export function sandboxRoot(dir: string): string {
  const cached = roots.get(dir);
  if (cached !== undefined) return cached;

  // The name is for reading; the digest is what keeps two repositories apart,
  // because a path cannot be a path segment.
  const root = join(realpathSync(tmpdir()), "landrace", `${nameOf(identityOf(dir))}-${repoDigest(dir)}`);
  roots.set(dir, root);
  return root;
}
