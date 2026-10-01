## Problem

Only `GitHubPages` extends `BaseDocs`.
Notion-kept specs: nothing publishes there, nothing briefs back.

## Decisions

1. Operator shares parent page with Notion integration; `notionToken` secret, redacted.
2. Hook: `docs: new Notion({ parent })` in `compose`.
3. `landrace start`: preflight reads parent, creates database `Landrace specs` there (exists → rewrites title unchanged); failure says why.
4. Publish → row: title `Ticket` = ticket id, rich-text `Source` = markdown, body = blocks. Links open row, else parent.
5. Republish: same text skipped; changed replaces blocks.

- Database: only rows carry custom properties.
- `Notion-Version: 2025-09-03`, current; database's one data source.
- `Source` written last, so half-done publish gets redone.
- Empty `Source` = no page: never published. Duplicate `Ticket` halts: no guessing.
- `Source` read whole via property-item endpoint; pieces ≤2,000 UTF-16 units, surrogate pairs unsplit: exact round trip.
- `link()` reuses lookups' `url`: no per-node query.
- 429 → `Retry-After`, ≤5 tries: deletes are per block.
- Converter: `#`–`###` headings (deeper → `heading_3`), paragraphs, lists (one nesting level), fenced code (unknown language → `plain text`), quotes, inline `code`, absolute http(s) links (others literal: Notion rejects). Rest → verbatim `code`, language `markdown`.
- ≤100 blocks per request, nested counted: API limit.
- `tsup.config.ts`, `package.json`, `tsconfig.json` untouched: folder ships itself.

## Technical design

- `integrations/notion/client.ts` — `NotionOptions`, `createClient`, `clientFor` (per `ctx.config`; missing `notionToken` named).
- `integrations/notion/blocks.ts` — `toBlocks`, `pieces`.
- `integrations/notion/pages.ts` — `Notion extends BaseDocs` with `check`; `parent` 32-hex id; database found in parent's children; creation shared.
- `integrations/notion/index.ts` — exports `Notion`, `createClient`, `NotionOptions`.
- `tests/integrations/notion/fake-notion.ts` — in-memory Notion: documented responses, limits, request log, injected failures.
- `tests/integrations/notion/notion.test.ts`, `tests/integrations/notion/blocks.test.ts` — over fake.
- `scripts/notion-check.mjs` — after `pnpm build`, `NOTION_TOKEN`, `NOTION_PARENT`: check, publish, same text, changed text (>100 blocks, emoji, table), read back; prints each; non-zero exit on failure or nothing checked.
- `README.md` — `#### Notion` under "`.landrace/hooks/*.ts` — the integrations".

## Done when

- Gate passes; `landrace validate .landrace` valid.
- Fake publish → row: `Ticket`, blocks, `Source`.
- Same text: satisfied, zero writes; changed: blocks replaced, `Source` last.
- Failure before `Source`: next apply redoes it, same row.
- `page()` exact for 60,000 characters, emoji astride piece boundary.
- 250 blocks → requests of 100, 100, 50.
- Each supported element → its block; table → verbatim `code`.
- `check()`: unshared parent, rejected token, missing `notionToken` → error naming each.
- Live `scripts/notion-check.mjs` run passes.