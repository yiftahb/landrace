// node scripts/release-notes.mjs <tag> <out-file>
//
// Run by .github/workflows/release.yml before anything is published: the tag
// must be `v` + package.json's version, and CHANGELOG.md must hold a non-empty
// `## [<version>]` section, which is written to <out-file> as the GitHub
// Release's notes. A release whose tag, version and changelog disagree stops
// here, before npm sees it.
import { readFileSync, writeFileSync } from "node:fs";

const fail = (message) => {
  console.error(`release-notes: ${message}`);
  process.exit(1);
};

const [tag, out] = process.argv.slice(2);
if (!tag || !out) fail("usage: node scripts/release-notes.mjs <tag> <out-file>");

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
if (tag !== `v${version}`) fail(`the tag ${tag} is not v + package.json's version ${version}`);

const lines = readFileSync("CHANGELOG.md", "utf8").split("\n");
// The exact version in brackets, so `## [1.0.0]` is never `## [1.0.0-rc.1]` or `## [11.0.0]`.
const heading = `## [${version}]`;
const start = lines.findIndex((line) => line === heading || line.startsWith(`${heading} `));
if (start === -1) fail(`CHANGELOG.md has no ${heading} section`);

const rest = lines.slice(start + 1);
const end = rest.findIndex((line) => line.startsWith("## "));
const body = (end === -1 ? rest : rest.slice(0, end))
  // The link definitions at the foot of the file belong to no one section.
  .filter((line) => !/^\[[^\]]+\]: /.test(line))
  .join("\n")
  .trim();
if (body === "") fail(`CHANGELOG.md's ${heading} section is empty`);

writeFileSync(out, `${body}\n`);
