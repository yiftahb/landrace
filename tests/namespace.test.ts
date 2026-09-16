import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";

const NAMESPACE = join("src", "namespace.ts");

const filesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : path.endsWith(".ts") ? [path] : [];
  });

const parse = (file: string): ts.SourceFile =>
  ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);

/** `file:line: name`, because a rule you have to go hunting for is a rule that gets switched off. */
function declarationsIn(file: string): string[] {
  const source = parse(file);
  const found: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      found.push(`${file}:${line + 1}: ${node.name.text}`);
    }
    // Keeps descending: a type declared inside a function body is still a type
    // declared outside the namespace, and those are the ones a shallow scan
    // would let through.
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(source, visit);
  return found;
}

/**
 * Every type lives in `src/namespace.ts`.
 *
 * Both halves of the rule are load-bearing and neither is self-evident from
 * reading a file, which is why this is a test rather than a convention:
 *
 *  - A type declared in a module is a type another module has to reach a
 *    sibling layer to name, and the layer this hurts is `src/core/**`, whose
 *    whole guarantee is that it depends on nothing.
 *  - `namespace.ts` is importable *from* core only because it emits nothing.
 *    A single `const` in it turns every core file's `import type` into a real
 *    module edge to whatever that const pulls in — and this file type-imports
 *    the config schema and the hook-kind list, so the edge lands squarely on
 *    two sibling layers. Nothing else in the build says so: the eslint purity
 *    rule inspects the specifier (`../namespace.js`, which is not a sibling)
 *    and would stay silent.
 */
describe("every type lives in src/namespace.ts", () => {
  it("declares no interface or type alias anywhere else under src", () => {
    const strays = filesUnder("src")
      .filter((file) => file !== NAMESPACE)
      .flatMap(declarationsIn);

    expect(strays).toEqual([]);
  });

  it("declares no runtime value in src/namespace.ts", () => {
    // Asked of the emitted JavaScript rather than of the syntax, because the
    // property that matters is what survives compilation: a value declaration,
    // a re-export, or an import that is not `import type` all leave something
    // behind here, and nothing else does.
    const emitted = ts.transpileModule(readFileSync(NAMESPACE, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ESNext,
        isolatedModules: true,
        // Comments survive transpilation and are not what is being asked about.
        removeComments: true,
      },
      fileName: NAMESPACE,
    }).outputText;

    expect(emitted.replace(/export\s*\{\s*\};?/g, "").trim()).toBe("");
  });
});
