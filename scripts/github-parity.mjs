/*
 * The live repository, read through `main`'s GitHub hook and through this
 * checkout's, graph for graph:
 *
 *   pnpm build && GITHUB_TOKEN=… pnpm parity [ref]
 *
 * Both hooks import `landrace/hooks` and `landrace/kit` by package
 * self-reference, which resolves to dist/ — hence the build. The ref's hook
 * (`main` unless named) is copied beside this one for the run, so its imports
 * resolve the same way, and removed after. One context — `tracker` out of
 * .landrace/landrace.yaml, the token out of GITHUB_TOKEN — so both read as the
 * same account. `list()` once, then `read()` of every ticket it listed; each
 * graph's nodes and edges are compared sorted. Prints `equal` and exits 0, or
 * each node and edge that differs and exits 1.
 *
 * ponytail: a read that throws on both sides counts as equal whatever each
 * said — the wording moved with the code; compare messages if that matters.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";

const ref = process.argv[2] ?? "main";
const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error("parity: set GITHUB_TOKEN to a token that can read the repository");
  process.exit(2);
}
if (ref.startsWith("-")) {
  console.error(`parity: "${ref}" is not a ref`);
  process.exit(2);
}

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const { tracker } = parse(readFileSync(join(root, ".landrace", "landrace.yaml"), "utf8"));
const ctx = {
  config: { tracker },
  secrets: new Map([["githubToken", token]]),
  signal: new AbortController().signal,
  log: (event, data) => console.error(`${event} ${JSON.stringify(data ?? {})}`),
};

/** A value with its object keys sorted, so two readings of one node stringify alike. */
const sorted = (v) =>
  Array.isArray(v) ? v.map(sorted)
    : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])]))
      : v;

/** Every node and edge one graph has and the other does not, or has differently. */
function differences(label, before, after) {
  const out = [];
  const nodes = (g) => new Map(g.nodes.map((n) => [n.id, JSON.stringify(sorted(n))]));
  const [was, now] = [nodes(before), nodes(after)];
  for (const id of [...new Set([...was.keys(), ...now.keys()])].sort()) {
    const [x, y] = [was.get(id), now.get(id)];
    if (x === y) continue;
    out.push(x === undefined ? `${label}: node ${id} only in this checkout: ${y}`
      : y === undefined ? `${label}: node ${id} only in ${ref}: ${x}`
        : `${label}: node ${id} differs\n  ${ref}: ${x}\n  this checkout: ${y}`);
  }
  const edges = (g) => new Set(g.relationships.map((r) => `${r.from} -${r.type}-> ${r.to}`));
  const [had, has] = [edges(before), edges(after)];
  for (const e of [...had].sort()) if (!has.has(e)) out.push(`${label}: edge ${e} only in ${ref}`);
  for (const e of [...has].sort()) if (!had.has(e)) out.push(`${label}: edge ${e} only in this checkout`);
  return out;
}

const settled = (promise) => promise.then((graph) => ({ graph }), (e) => ({ error: e instanceof Error ? e.message : String(e) }));

const copy = join(root, ".landrace", "hooks", ".github-parity.ts");
writeFileSync(copy, execFileSync("git", ["show", `${ref}:.landrace/hooks/github.ts`], { cwd: root, encoding: "utf8" }));
try {
  const before = (await import(pathToFileURL(copy).href)).source;
  const after = (await import(pathToFileURL(join(root, ".landrace", "hooks", "github.ts")).href)).source;
  const found = [];

  /** One read through both; the graph `ref`'s hook answered, when it did. */
  const compare = async (label, read) => {
    const x = await settled(read(before));
    const y = await settled(read(after));
    if (x.error !== undefined || y.error !== undefined) {
      if ((x.error === undefined) !== (y.error === undefined)) {
        found.push(`${label}: ${ref} ${x.error === undefined ? "read it" : `threw: ${x.error}`}; ` +
          `this checkout ${y.error === undefined ? "read it" : `threw: ${y.error}`}`);
      } else {
        console.error(`${label}: both threw\n  ${ref}: ${x.error}\n  this checkout: ${y.error}`);
      }
      return x.graph;
    }
    found.push(...differences(label, x.graph, y.graph));
    return x.graph;
  };

  const listed = await compare("list", (source) => source.list(ctx));
  // Nothing listed through `ref` is nothing compared, which is not parity.
  if (listed === undefined && found.length === 0) found.push(`list: ${ref}'s hook could not list the repository, so nothing was compared`);
  for (const id of (listed?.nodes ?? []).filter((n) => n.kind === "ticket").map((n) => n.id)) {
    await compare(`read #${id}`, (source) => source.read(id, ctx));
  }

  console.log(found.length === 0 ? "equal" : found.join("\n"));
  process.exitCode = found.length === 0 ? 0 : 1;
} finally {
  rmSync(copy, { force: true });
}
