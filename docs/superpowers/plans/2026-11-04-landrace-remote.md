# Landrace Remote Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Landrace instance serves many people from a remote host. Each person signs in through OIDC, connects their own accounts in an Integrations tab, and gets their own board and MCP over one HTTP front door. Local single-developer setups keep working.

**Architecture:** One HTTP front door (`/` UI, `/mcp` Streamable HTTP MCP) replaces stdio MCP. A **person** model with per-person secrets and vars, filled from **connections** (pasted or OAuth credentials, or identities looked up by email) that live in `~/.landrace/credentials/`, sits on top of today's single-instance runtime. A **roster** runs one loaded workspace per person, sharing one agent-slot pool in rotation. OIDC sign-in and MCP OAuth turn on remote mode last, so every earlier merge is safe and local-only.

**Tech Stack:** TypeScript (ESM), Node, jest (ts-jest ESM), `@modelcontextprotocol/sdk` 1.30 (`StreamableHTTPServerTransport`, `server/auth`), `express@^5` (made a direct dependency in Task 9), `openid-client@^6` (new in Task 9), zod.

**Spec:** `docs/superpowers/specs/2026-11-04-remote-design.md`. Read it before any task; every task argues from it.

**Execution:** each task is one Landrace item (a GitHub issue labelled `lr:auto`), and each is blocked by the one before it. They are built strictly in order, one at a time. Each task ends with green `pnpm test`, `pnpm typecheck`, `pnpm lint` and `pnpm build`.

## Global Constraints

- Local `landrace.yaml` + `.env` setups keep working unchanged. The **only** breaking change is that stdio `landrace mcp` is removed for editors (Task 2); release it as **2.0.0**.
- Default bind stays `127.0.0.1:4545`, with today's Host and Origin checks; `--ui-port` keeps working.
- Credentials live at `~/.landrace/credentials/<person>.json`: file mode `0600`, directory `0700`, atomic writes.
- Claude per-person auth goes through `CLAUDE_CODE_OAUTH_TOKEN`. `ANTHROPIC_API_KEY` never enters an agent environment, and `--bare` is never passed. A `claude setup-token` token lives for **365 days**.
- Slack identity is resolved with `users.lookupByEmail`. Slack bot posts use `chat.postMessage`. The incoming-webhook mode stays.
- Telemetry stays configured by the existing `OTEL_*` and `LANDRACE_ENABLE_TELEMETRY` env vars. Person fields are exported as `landrace.person` and `landrace.personEmail` (one convention everywhere).
- Personal values never reach a log, an OTEL record, a comment, a prompt or another person's step. The one exception is a person's own Claude token in their own step's environment.
- Forge, tracker and chat writes stay the bot's (instance secrets). Admission (`admit`, `eligible`) is unchanged, and nothing auto-admits.
- The engine stays generic: no project, company or tracker-instance names in code, docs or tests.
- Remote mode means `people.oidc` is configured. Until Task 9, a non-loopback bind is refused.

## Review Focus

1. **Binding the front door to a non-loopback host with no `people.oidc`** must be refused at validate and start (`serve.unauthenticated`), never served unauthenticated. Owned by Task 2.
2. **An editor config still pointing at stdio `landrace mcp`** must get the migration message and exit 1, not hang or half-start. Owned by Task 2.
3. **A corrupt or unreadable credentials file** must mark that person's connections `failed` with a reason. It must not crash the runner or affect other people. Owned by Task 3.
4. **A Claude token that expires or is revoked mid-life** must turn the connection `failed` or `expired` and log `agent.limited` or `connection.failed`. It must not count as a round, and it must stop that person's runs. Owned by Task 5.
5. **One item claimed by two people** (several GitHub assignees) must halt as ambiguous (`item.ambiguous`), with neither person running it. Owned by Task 7.

---

### Task 1: Identity and limits in telemetry

**Files:**
- Modify: `src/namespace.ts` (add `Person`; add `with` to `RedactingLogger`; add `agent.limited`, `integration.limited` to `EventName`)
- Modify: `src/conventions.ts` (`LOCAL_PERSON_ID`)
- Modify: `src/config/schema.ts` (`people.local`), `src/config/load.ts` (resolve `people.local.email` as `$VAR`, like `agent.git`)
- Create: `src/people/person.ts`, `src/runner/limits.ts`
- Modify: `src/runner/events.ts` (`with`), `src/telemetry/otel.ts` (WARN on `.limited`), `src/cli/start.ts` (stamp the local person), `src/runner/converge.ts:449-461` (emit `agent.limited`)
- Modify: `src/kit/http.ts` (`reportLimit`, exported through `landrace/kit`). Call it on 429, and on GitHub's 403 rate limit, in `integrations/{github,gitlab,jira,notion}/client.ts` and `integrations/slack/index.ts`
- Test: `tests/people/person.test.ts`, `tests/runner/limits.test.ts`, `tests/runner/events.test.ts`, `tests/telemetry/otel.test.ts`, `tests/kit/http.test.ts`
- Docs: `docs/configuration.md` (`people.local`), the telemetry section listing the new attributes and events

**Interfaces:**
- Produces:
  - `interface Person { id: string; email?: string; name?: string }`
  - `LOCAL_PERSON_ID = "local"`
  - `localPerson(loaded: LoadedConfig): Person`
  - `personFields(p: Person): { person: string; personEmail?: string }`
  - `RedactingLogger.with(fields: Record<string, string>): RedactingLogger`: every event gets these fields unless it already carries the key
  - `limitKindOf(text: string): "usage" | "rate" | "overloaded" | null`
  - `reportLimit(ctx: Pick<RuntimeContext, "log">, info: { integration: string; status: number; where: string; retryAfter?: string }): void`, which logs `integration.limited`
- Config: `people: { local?: { email?: string; name?: string } }`, optional. `email` may be `$VAR`, and an unset var is the problem `people.local.email`.

- [ ] **Step 1: Write failing tests**
```ts
// tests/runner/limits.test.ts
expect(limitKindOf("Claude AI usage limit reached|1767225600")).toBe("usage");
expect(limitKindOf("API Error: 429 Too Many Requests")).toBe("rate");
expect(limitKindOf("API Error: 529 Overloaded")).toBe("overloaded");
expect(limitKindOf("TypeError: x is undefined")).toBeNull();
// tests/runner/events.test.ts — "with stamps person fields without overriding an event's own"
const events: LandraceEvent[] = []; const log = createLogger({ sink: (e) => events.push(e) }).with({ person: "local", personEmail: "a@b.c" });
log("item.claimed", { item: "1" }); log("item.claimed", { item: "2", person: "other" });
expect(events[0]).toMatchObject({ person: "local", personEmail: "a@b.c" }); expect(events[1].person).toBe("other");
// tests/telemetry/otel.test.ts — person fields export as landrace.person / landrace.personEmail; *.limited is WARN
// tests/kit/http.test.ts — reportLimit logs integration.limited with integration, status, where, retryAfter
// tests/people/person.test.ts — localPerson: id "local", email from people.local.email ($VAR resolved); no people block → { id: "local" }
```
- [ ] **Step 2:** Run `npx jest tests/runner/limits.test.ts tests/runner/events.test.ts tests/telemetry/otel.test.ts tests/kit/http.test.ts tests/people/person.test.ts`. Expected: FAIL (missing exports).
- [ ] **Step 3:** Implement the interfaces above. In `converge.ts`, where an executor rejection becomes `kind: "unavailable"`, log `agent.limited` `{item, workflow, stage, round, kind}` when `limitKindOf(message)` is non-null. Behaviour stays unchanged: still no durable record and no round counted. In `start.ts`, wrap the logger handed to the workspace runtime (item, step, hook and notify events) with `log.with(personFields(localPerson(loaded)))`. Startup and config events keep the unstamped logger. Extend the OTEL WARN regex to `/\.(failed|denied|blocked|limited)$/`.
- [ ] **Step 4:** Run the tests from Step 2, then `pnpm test && pnpm typecheck && pnpm lint`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: person identity and limit events in logs and telemetry`.

---

### Task 2: One front door: HTTP MCP on the UI port (breaking)

**Files:**
- Modify: `src/config/schema.ts` (`serve`), `src/cli/start.ts` (`--ui-port` overrides `serve.port`; serve UI and MCP together; tools from the running runtime; wake via `schedule.wake`)
- Create: `src/front/server.ts`, `src/front/mcp.ts`, `src/front/hosts.ts`
- Modify: `src/ui/server.ts` (host from options instead of the `HOST` const; the Host check and `foreignWrite` Origin check use `allowedHosts`)
- Modify: `src/cli/mcp.ts` (extract `toolWorkflowsOf`; `runMcp` without `--child`/`--pairing` prints `STDIO_REMOVED` and exits 1), `src/cli/index.ts` (hidden `--pairing` flag), `src/cli/start.ts:339` (`childServerCommand` adds `--pairing`)
- Modify: `src/kit/executor.ts` (`resolveStepServers` refuses an HTTP MCP entry whose origin is a front-door origin), `integrations/claude/index.ts` (every tier denies `WebFetch(domain:<host>)` for each front-door host), `src/cli/validate.ts` (`serveProblems`; refuse sandbox hosts that include a front-door host)
- Modify: `.agsync/mcp/landrace.yaml` (HTTP server at `http://127.0.0.1:4545/mcp`, in agsync's HTTP form; run `agsync sync`), `README.md`, `docs/cli.md` (`landrace mcp`, "Connecting an editor"), `docs/security.md` (The board), `CHANGELOG.md` (an `[Unreleased]` entry under `### Changed`, marked **Breaking**). Don't bump `package.json`: the release PR does that, and the release that carries this change is 2.0.0.
- Test: `tests/front/server.test.ts`, `tests/front/mcp.test.ts`, `tests/front/hosts.test.ts`, `tests/cli/mcp.test.ts`, `tests/kit/executor.test.ts`, `tests/integrations/claude.test.ts`, `tests/cli/validate.test.ts`

**Interfaces:**
- Consumes: `boardListener(opts, portOf)`, `createMcpServer(tools, version)`, `createTools(workflows, ctx, opts)`
- Produces:
  - Config: `serve: { host: string = "127.0.0.1"; port: number = 4545; publicUrl?: string (url) }`
  - `isLoopback(host: string): boolean`: true for `127.0.0.0/8`, `::1`, `localhost`
  - `allowedHosts(serve: { host: string; port: number; publicUrl?: string }): string[]`: `host:port`; plus `localhost:port` and `127.0.0.1:port` when loopback; plus the `publicUrl` host
  - `frontDoorOrigins(serve): string[]`
  - `serveProblems(config: RuntimeConfig): Problem[]`, rule `serve.unauthenticated`: a non-loopback host while `people.oidc` is absent
  - `interface McpEndpoint { handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> }`
  - `createMcpEndpoint(opts: { toolsFor: (workflow?: string) => Tools; version: string; log: RedactingLogger }): McpEndpoint`: stateful Streamable HTTP, one `McpServer` per session, `?workflow=<id>` scoping
  - `serveFrontDoor(opts: UiOptions & { host: string; publicUrl?: string; mcp: McpEndpoint }): Promise<UiServer>`: `/mcp` goes to `mcp.handle`, everything else to `boardListener`
  - `toolWorkflowsOf(runtime: WorkspaceRuntime): ToolWorkflow[]`
  - `STDIO_REMOVED` (exact copy):
    > ``landrace mcp no longer serves editors over stdio. Run `landrace start` and connect to its MCP endpoint, for example:\n  claude mcp add --transport http landrace http://127.0.0.1:4545/mcp``

- [ ] **Step 1: Write failing tests**
```ts
// tests/front/hosts.test.ts
expect(isLoopback("127.0.0.1")).toBe(true); expect(isLoopback("0.0.0.0")).toBe(false);
expect(allowedHosts({ host: "127.0.0.1", port: 4545 })).toEqual(expect.arrayContaining(["127.0.0.1:4545", "localhost:4545"]));
expect(serveProblems(cfg({ serve: { host: "0.0.0.0", port: 80 } })).map((p) => p.rule)).toEqual(["serve.unauthenticated"]);
// tests/front/mcp.test.ts — over a real loopback server: an SDK StreamableHTTPClientTransport client lists the 15 landrace_* tools; ?workflow=a lists tools describing workflow a only
// tests/front/server.test.ts — GET / serves the page; GET /board.json works; POST /mcp reaches mcp.handle; Host: evil.example → 421
// tests/cli/mcp.test.ts — runMcp with no --child/--pairing writes STDIO_REMOVED to stderr and exits 1; with --pairing it still serves stdio
// tests/kit/executor.test.ts — resolveStepServers refuses { type: "http", url: "http://127.0.0.1:4545/mcp" } when that is the front door
// tests/integrations/claude.test.ts — read-tier and write-tier argv settings both deny WebFetch(domain:127.0.0.1) and WebFetch(domain:localhost)
// tests/cli/validate.test.ts — agent sandbox hosts containing "127.0.0.1" or the publicUrl host → a problem
```
- [ ] **Step 2:** Run the tests listed above with `npx jest …`. Expected: FAIL.
- [ ] **Step 3:** Implement. `start.ts` builds the endpoint with `toolsFor = (wf) => createTools(toolWorkflowsOf(runtime).filter(...), runtime.ctx, { lock, sandbox, activity, wake: () => schedule.wake(), scope: wf })`. Startup refuses `serveProblems`, as it does today's unsound config. The wake file stays for `--pairing` stdio servers.
- [ ] **Step 4:** Run `pnpm test && pnpm typecheck && pnpm lint && pnpm build`, then a live check: `node dist/cli.js start` in a scratch repo, then `claude mcp add --transport http lr-test http://127.0.0.1:4545/mcp` and `claude mcp list`. Expected: tests PASS, and the server shows connected.
- [ ] **Step 5:** Commit `feat!: serve the operator MCP over HTTP on the board's port`.

---

### Task 3: People core: per-person keys, connections, credential store

**Files:**
- Modify: `src/config/schema.ts` (`secrets` and `vars` values accept the per-person object form), `src/config/load.ts` (object form: resolve `env` when present; never "missing" just because `env` is unset)
- Modify: `src/hooks/contracts.ts` (`defineConnection`, hook kind `connection`), `src/hooks/load.ts` (`Registry.connections`), `src/namespace.ts` (types below)
- Create: `src/people/keys.ts`, `src/people/store.ts`, `src/people/resolve.ts`
- Modify: `src/cli/start.ts` and `src/cli/validate.ts` (resolve the local person and merge the values before `loadWorkspace`; report `connection.*` problems; instance problems still throw at start as today), `src/runner/events.ts` (credential values join redaction)
- Modify: `src/kit/executor.ts` (`DEFAULT_DENY` gains `~/.landrace/credentials`), `integrations/claude/index.ts` (read-tier runs also get `permissions.deny` `Read(...)` rules for every denied path, not only write-tier runs)
- Test: `tests/people/keys.test.ts`, `tests/people/store.test.ts`, `tests/people/resolve.test.ts`, `tests/config/load.test.ts`, `tests/hooks/load.test.ts`, `tests/integrations/claude.test.ts`, `tests/cli/validate.test.ts`
- Docs: `docs/configuration.md` (per-person keys), `docs/hooks.md` (`defineConnection`)

**Interfaces:**
- Consumes: `Person`, `LOCAL_PERSON_ID`, `localPerson`
- Produces:
  - Config value form for `secrets` and `vars`: `string | { perPerson: true; env?: string; connection: "<connId>.<field>" }`. The string form keeps today's meaning: instance-wide.
  - `perPersonKeys(config: RuntimeConfig): Array<{ kind: "secret" | "var"; name: string; env?: string; connection: { id: string; field: string } }>`
  - Connection definition:
    ```ts
    interface ConnectionDef {
      id: string;
      label: string;
      kind: "credential" | "identity";
      fields: readonly string[];
      required?: "always" | "remote";
      paste?: { hint: string };
      lifetimeDays?: number;
      resolve?: (email: string, ctx: RuntimeContext) => Promise<Record<string, string> | null>;
      check?: (value: ConnectionValue, ctx: RuntimeContext) => Promise<string | null>;
    }
    ```
    - `defineConnection(def: ConnectionDef)` registers one.
    - Connections referenced by per-person keys are required. `required: "remote"` makes a connection required only in remote mode.
  - `ConnectionValue = { fields: Record<string, string>; source: "paste" | "oauth" | "lookup" | "override"; connectedAt: string; expiresAt?: string; failedAt?: string; failure?: string; refresh?: { token: string } }`
  - `ConnectionStatus = { id: string; label: string; kind: ConnectionDef["kind"]; state: "connected" | "missing" | "expired" | "failed"; detail?: string; expiresAt?: string }`
  - `PersonCredentials = { person: Person; connections: Record<string, ConnectionValue>; problem?: string }`
  - `createCredentialStore(root = join(homedir(), ".landrace", "credentials")): CredentialStore`
    - `read(personId): Promise<PersonCredentials>`
    - `put(personId, person: Person, connId, value: ConnectionValue): Promise<void>`
    - `remove(personId, connId): Promise<void>`
    - `list(): Promise<Person[]>`
    - File `<root>/<encodeURIComponent(id)>.json` with mode 0600, directory 0700, written via tmp + rename. A corrupt file yields `{ connections: {}, problem }`.
  - `resolvePerson(loaded: LoadedConfig, registry: Registry, person: Person, creds: PersonCredentials, mode: { remote: boolean }, now = new Date()): PersonResolution`
    - `PersonResolution = { secretValues: Map<string, string>; vars: Map<string, string>; statuses: ConnectionStatus[]; problems: Problem[]; ready: boolean }`
    - Local: a set `env` wins; otherwise the connection supplies the value.
    - Remote: connection only. A set `env` is the warning `people.env-ignored`.
    - Rules: `connection.unknown`, `connection.missing`, `connection.expired` (`connectedAt + lifetimeDays` is past), `connection.failed`.

- [ ] **Step 1: Write failing tests**
```ts
// tests/people/store.test.ts — put then read round-trips; file mode is 0o600 and dir 0o700; corrupt JSON → { connections: {}, problem: /credentials file/ }; list() returns the stored persons
// tests/people/resolve.test.ts
//   local, env set → value from env even when a connection exists
//   local, env unset, connection present → value from connection, state "connected"
//   remote, env set → value from connection, problem rule "people.env-ignored"
//   lifetimeDays 365, connectedAt 366 days ago → state "expired", ready false
//   corrupt creds → every required status "failed" with the store's problem
//   key referencing "nope.token" with no such def → rule "connection.unknown"
// tests/config/load.test.ts — an existing string-form config loads exactly as before (snapshot of LoadedConfig unchanged)
// tests/integrations/claude.test.ts — read-tier settings deny Read(~/.landrace/credentials) and Read(~/.landrace/credentials/**)
```
- [ ] **Step 2:** Run those tests. Expected: FAIL.
- [ ] **Step 3:** Implement. `start` and `validate` read the local person's credentials, call `resolvePerson`, merge `secretValues` and `vars` over the loaded maps before `loadWorkspace`, and pass credential values to `log.redact`.
- [ ] **Step 4:** Run `pnpm test && pnpm typecheck && pnpm lint`. Expected: PASS, including every existing config and validate test unchanged.
- [ ] **Step 5:** Commit `feat: per-person keys, connection declarations and the credential store`.

---

### Task 4: Integrations tab: connect by pasting, board gated until ready

**Files:**
- Create: `src/people/panel.ts`, `src/runner/slot.ts`
- Modify: `src/ui/server.ts` (routes below; `UiOptions.people`), `src/ui/page.ts` (Integrations tab; board hidden while not ready), `src/cli/start.ts`:
  - serve the front door even when the local person isn't ready;
  - tick only when ready;
  - rebuild the runtime on connect or disconnect through `RuntimeSlot`;
  - the schedule reads `slot.current()` each tick
- Modify: `src/namespace.ts` (`EventName`: `person.connected`, `person.disconnected`)
- Test: `tests/ui/people.test.ts`, `tests/runner/slot.test.ts`, `tests/cli/start.test.ts`
- Docs: `docs/board-pane.md` (Integrations tab), `docs/cli.md` (`start` with unready connections)

**Interfaces:**
- Consumes: `CredentialStore`, `resolvePerson`, `ConnectionStatus`, `Registry.connections`
- Produces:
  - `MeView = { person: Person; connections: ConnectionStatus[]; ready: boolean; hints: Record<string, string> }`
  - `PeoplePanel = { me(caller: Person): Promise<MeView>; connect(caller: Person, id: string, fields: Record<string, string>): Promise<ConnectionStatus>; disconnect(caller: Person, id: string): Promise<void> }`
  - `createPeoplePanel(opts: { store; registry; loaded; mode; ctx: RuntimeContext; onChange: (personId: string) => Promise<void>; log }): PeoplePanel`
    - `connect` runs `def.check`, stores with `source: "paste"`, and logs `person.connected` (`{ connection: id }`, never values).
  - `RuntimeSlot = { current(): WorkspaceRuntime | null; reload(): Promise<void> }`
  - `createRuntimeSlot(build: () => Promise<WorkspaceRuntime | null>): RuntimeSlot`
  - Routes:
    - `GET /people/me` → `MeView`
    - `POST /connect/:id`, with action header `connect`, JSON `{ fields }`, body ≤ 16 KiB → `ConnectionStatus`
    - `POST /disconnect/:id`, with action header `disconnect`
    - Locally the caller is always the local person.
  - `board.json` while not ready → `{ ready: false }`, and the page shows only Integrations.

- [ ] **Step 1: Write failing tests**
```ts
// tests/ui/people.test.ts — GET /people/me lists a missing required connection, ready:false; POST /connect/x with fields → state "connected", ready:true; POST without the action header → 403; body > 16 KiB → 413; the stored file holds the value and no log event does
// tests/runner/slot.test.ts — reload swaps current(); a build that throws keeps the previous runtime and the error propagates
// tests/cli/start.test.ts — start with a missing connection serves the front door and does not tick; after connect, the next wake ticks
```
- [ ] **Step 2:** Run those tests. Expected: FAIL.
- [ ] **Step 3:** Implement. The tab is vanilla JS in `APP_JS`, following the existing panel patterns: one row per connection showing its state, the paste form with its `hint` for credentials, and a read-only value for identities.
- [ ] **Step 4:** Run `pnpm test && pnpm typecheck && pnpm lint && pnpm build`, then a live check: a scratch workspace with one per-person secret; `start` shows only Integrations; pasting a value shows the board.
- [ ] **Step 5:** Commit `feat: Integrations tab and runtime reload on connect`.

---

### Task 5: Built-in connections: Claude, tracker and chat identity, Slack bot, forge personal token

**Files:**
- Modify: `integrations/claude/index.ts` (export `claudeConnection`; per-person env)
- Modify: `src/kit/executor.ts`:
  - `BaseExecutor.connection`;
  - `childEnv(extra, git, personal)`;
  - `ExecutorContext.personEnv`;
  - auth-failure detection marks the connection failed
- Modify: `integrations/jira/tracker.ts` (export `accountFor`), `integrations/jira/index.ts` (export `jiraConnection`)
- Modify: `integrations/slack/index.ts` (bot mode; export `slackConnection`)
- Modify: `integrations/gitlab/index.ts` and `integrations/github/index.ts` (export `gitlabUserConnection` and `githubUserConnection`)
- Modify: `src/people/resolve.ts` (identity connections with `resolve` are looked up from `person.email` and stored with `source: "lookup"`), `src/cli/start.ts` (warn `connection.expiring` at most once a day when ≤ 30 days remain), `src/namespace.ts` (events `connection.expiring`, `connection.failed`)
- Test: `tests/integrations/claude.test.ts`, `tests/integrations/slack.test.ts`, `tests/integrations/jira/*.test.ts`, `tests/integrations/gitlab/*.test.ts`, `tests/integrations/github/*.test.ts`, `tests/kit/executor.test.ts`, `tests/people/resolve.test.ts`
- Docs: `docs/integrations.md` (each connection; Slack bot scopes `chat:write`, `users:read.email`; a note that subscription-token policy is between the deployer and Anthropic). It also says that Notion (`notionToken`) and Codex declare no per-person connection in v1; both stay instance-wide.

**Interfaces:**
- Consumes: `defineConnection`, `ConnectionDef`, `ConnectionValue`, `CredentialStore.put`
- Produces:
  - `claudeConnection`: `{ id: "claude", kind: "credential", fields: ["token"], required: "remote", lifetimeDays: 365, paste: { hint: "Run `claude setup-token` and paste the token it prints" } }`
  - `BaseExecutor.connection?: { id: string; env: Record<string, string> }`, mapping an env var name to a field. For Claude: `{ id: "claude", env: { CLAUDE_CODE_OAUTH_TOKEN: "token" } }`.
  - `ExecutorContext.personEnv?: Record<string, string>`, built from the item's person's connection. Locally, with no claude connection, it is absent and today's login is used.
  - `isAuthFailure(text: string): boolean`: `/invalid (api key|bearer token)|authentication_error|OAuth token (has )?expired|401/i`. On a match, store `failedAt` and `failure` and log `connection.failed`. It is not a round.
  - `jiraConnection`: `{ id: "jira", kind: "identity", fields: ["accountId"], resolve: (email, ctx) => accountFor(...) }`
  - `slackConnection`: `{ id: "slack", kind: "identity", fields: ["userId"], resolve: users.lookupByEmail via slackBotToken }`
  - Slack notifier: when `slackBotToken` is set, `POST https://slack.com/api/chat.postMessage { channel: slackNotifyUser, text }`, and `ok:false` throws `slack: <error>`. Otherwise the webhook mode is unchanged.
  - `gitlabUserConnection` / `githubUserConnection`: `{ id: "gitlab" | "github", kind: "credential", fields: ["token"], paste: { hint }, check: GET /user must be 200 }`

- [ ] **Step 1: Write failing tests**
```ts
// claude: the spawned env holds CLAUDE_CODE_OAUTH_TOKEN from personEnv and never ANTHROPIC_API_KEY even when the parent has it; argv never contains --bare
// executor: an agent error "OAuth token has expired" → connection.failed logged, store.put called with failedAt; step result is the existing "unavailable" (no round)
// slack: bot mode posts chat.postMessage with Authorization: Bearer <slackBotToken> and channel = slackNotifyUser; webhook mode unchanged (existing tests untouched)
// slack identity: lookupByEmail → { userId }; no slackBotToken → resolve returns null and status "missing" with detail naming slackBotToken
// jira identity: resolve(email) → { accountId } through accountFor
// resolve: identity with resolve + person.email → stored with source "lookup" and state "connected"
// expiry: connectedAt 340 days ago → one connection.expiring event per day, not per tick
```
- [ ] **Step 2:** Run those tests. Expected: FAIL.
- [ ] **Step 3:** Implement the interfaces above.
- [ ] **Step 4:** Run `pnpm test && pnpm typecheck && pnpm lint`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: built-in Claude, Jira, Slack and forge connections`.

---

### Task 6: OAuth connect for forge credentials

**Files:**
- Create: `src/people/oauth.ts`
- Modify: `src/hooks/contracts.ts` (`ConnectionDef.oauth`), `integrations/gitlab/index.ts` and `integrations/github/index.ts` (OAuth specs), `src/ui/server.ts` (routes), `src/ui/page.ts` (a Connect button when OAuth is configured, otherwise the paste form), `src/cli/start.ts` (a background refresher)
- Test: `tests/people/oauth.test.ts`, `tests/ui/people.test.ts`
- Docs: `docs/integrations.md` (creating the OAuth apps; callback `<publicUrl>/connect/<id>/callback`)

**Interfaces:**
- Consumes: `ConnectionDef`, `CredentialStore`, `PeoplePanel`
- Produces:
  - `OAuthSpec = { authorizeUrl: string; tokenUrl: string; scopes: string[]; clientIdSecret: string; clientSecretSecret: string; field: string }`. Client id and secret are read from instance secrets by those names; when they're unset, the connection falls back to pasting.
  - GitLab: `${gitlabBaseUrl || "https://gitlab.com"}/oauth/authorize` and `/oauth/token`, scopes `["api"]`, secrets `gitlabOauthClientId` and `gitlabOauthClientSecret`.
  - GitHub: `https://github.com/login/oauth/authorize` and `https://github.com/login/oauth/access_token`, scopes `["repo"]`, secrets `githubOauthClientId` and `githubOauthClientSecret`.
  - `beginConnect(def: ConnectionDef, person: Person, redirectUri: string): { url: string; state: string }`: PKCE S256; state is 32 random bytes, kept in memory with a 10-minute TTL and bound to the person.
  - `finishConnect(def, state: string, code: string, redirectUri: string): Promise<{ personId: string; value: ConnectionValue }>`
  - `refreshIfNeeded(def, value: ConnectionValue, now = new Date()): Promise<ConnectionValue | null>`: refreshes when `expiresAt - 10 min <= now`; returns null when nothing changed.
  - Routes: `GET /connect/:id/start` → 302 to the provider; `GET /connect/:id/callback?code&state` → store, then 302 to `/#integrations`.
  - The redirect URI is `${publicUrl ?? "http://" + host + ":" + port}/connect/<id>/callback`.
  - The refresher runs every 60 s and updates the person's live `secretValues` map in place.

- [ ] **Step 1: Write failing tests**
```ts
// oauth.test.ts — begin: url has code_challenge_method=S256, state, redirect_uri, scope; finish with a fake token endpoint → value { fields: { token }, source: "oauth", expiresAt, refresh }
// unknown/expired/other-person state → rejected; refreshIfNeeded near expiry posts grant_type=refresh_token and returns the new value
// ui: no client id secret → /people/me offers paste for gitlab; with it → offers connect URL /connect/gitlab/start
```
- [ ] **Step 2:** Run those tests. Expected: FAIL.
- [ ] **Step 3:** Implement with `fetch` and `node:crypto`. Add no new dependency.
- [ ] **Step 4:** Run `pnpm test && pnpm typecheck && pnpm lint`, then a live check with a real GitLab OAuth app on loopback. Expected: PASS, and the token is stored.
- [ ] **Step 5:** Commit `feat: OAuth connect for forge credentials`.

---

### Task 7: Many people in one runner

**Files:**
- Create: `src/people/roster.ts`, `src/runner/pool.ts`
- Modify: `src/cli/start.ts`:
  - `buildWorkspaceRuntime(dir, opts)` takes `person` and `resolution`;
  - `ctx.config` is a fresh shallow copy per person, so `WeakMap` client caches are per person;
  - the logger is `log.with(personFields(person))`;
  - the tick loop goes over the roster
- Modify: `src/runner/tick.ts` (agent slots come from a shared `SlotPool`), `src/agent/worktree.ts` (`pathFor(item, repoRoot, scope?)`)
- Modify: `src/front/server.ts` and `src/ui/server.ts` (route each request to the caller's runtime through `callerOf`; an item not on the caller's board → 404), `src/front/mcp.ts` (sessions bound to the caller), `src/mcp/server.ts` (`createMcpServer(tools, version, opts?: { pairing?: boolean })`)
- Modify: `src/namespace.ts` (`EventName`: `item.ambiguous`)
- Test: `tests/people/roster.test.ts`, `tests/runner/pool.test.ts`, `tests/runner/tick.test.ts`, `tests/agent/worktree.test.ts`, `tests/front/server.test.ts`, `tests/front/mcp.test.ts`
- Docs: `docs/architecture.md` (the roster), `docs/configuration.md` (`tick.concurrency` as a shared cap)

**Interfaces:**
- Consumes: `CredentialStore.list/read`, `resolvePerson`, `RuntimeSlot`, `personFields`, `McpEndpoint`
- Produces:
  - `PersonRuntime = { person: Person; slot: RuntimeSlot; board: Board; statuses: ConnectionStatus[] }`
  - `createRoster(opts: { dir; loaded; registry; store; mode: { remote: boolean }; build: (person: Person, r: PersonResolution) => Promise<WorkspaceRuntime | null>; log }): Roster`
    - `Roster = { people(): PersonRuntime[]; get(personId: string): PersonRuntime | undefined; reload(personId: string): Promise<void>; sync(): Promise<void> }`
    - Locally, the roster is exactly `[local]`. Remotely, it is every person in the store.
  - `createSlotPool(capacity: number): SlotPool`
    - `SlotPool = { take(personId: string): boolean; release(personId: string): void; order(personIds: string[]): string[] }`
    - `order` rotates the starting person every call (round-robin). Capacity is `tick.concurrency`.
  - `ambiguousClaims(claims: Array<{ personId: string; items: string[] }>): Map<string, string[]>`: an item held by more than one person is excluded everywhere and logged as `item.ambiguous` `{ item, people }`.
  - `pathFor(item, repoRoot, scope?: string)`: `<root>/<scope>/<item>` when `scope` is set. The local person passes no scope, so paths are unchanged.
  - `callerOf: (req: IncomingMessage) => Person | null`. Locally it always returns the local person.
  - `createMcpEndpoint` options change to `toolsFor: (caller: Person, workflow?: string) => Tools`, and `serveFrontDoor` options gain `callerOf`.
  - `HookContext.person?: Person`: the item's (or caller's) person, on every per-person ctx. `ctx.secrets.get` on a per-person key returns that person's value.
  - Pairing (UI routes and the MCP tools `landrace_pair`, `landrace_finish`, `landrace_release`) is off whenever `mode.remote` holds.

- [ ] **Step 1: Write failing tests**
```ts
// pool: capacity 2, three people asking → grants spread across people; order() rotates; release frees
// roster: store with alice (ready) and bob (missing claude) → only alice's runtime ticks; bob's board shows ready:false
// roster: alice and bob ctx.config objects are different instances; each gets its own jiraAssignee secret
// ambiguity: item "7" claimed by alice and bob → excluded from both, item.ambiguous logged once per tick
// worktree: pathFor("7", root, "alice") → <root>/alice/7; pathFor("7", root) unchanged
// front: alice's request for bob's item → 404; MCP session for alice lists only alice's items; remote mode → no landrace_pair tool
// events from bob's runtime carry person "bob"; startup and config events carry no person
// alice's credentials file corrupt → alice's statuses failed, bob still ticks, the runner does not throw
// inside bob's runtime a hook sees ctx.person.id === "bob"
```
- [ ] **Step 2:** Run those tests. Expected: FAIL.
- [ ] **Step 3:** Implement the interfaces above. Notify needs no change: each person's ctx carries their own notify values.
- [ ] **Step 4:** Run `pnpm test && pnpm typecheck && pnpm lint`. Expected: PASS, with all existing single-runtime tests unchanged.
- [ ] **Step 5:** Commit `feat: one runner, many people`.

---

### Task 8: Isolation between people's steps

**Files:**
- Create: `src/people/isolation.ts`
- Modify: `src/kit/executor.ts` (merge the per-person deny list into the run's deny paths for every tier), `integrations/claude/index.ts` (apply the deny list to read-tier and write-tier runs), `src/cli/start.ts` (pass the roster's other people into the executor context)
- Test: `tests/people/isolation.test.ts`, `tests/integrations/claude.test.ts`, `tests/security/isolation.test.ts`
- Docs: `docs/security.md`, a new section "People on one instance", with the residual risk stated as in spec §9

**Interfaces:**
- Consumes: `Roster`, `pathFor(item, root, scope)`
- Produces:
  - `claudeProjectDirOf(cwd: string): string` → `~/.claude/projects/<cwd with every non-alphanumeric char replaced by "-">`
  - `denyForPerson(self: Person, others: Person[], roots: { worktrees: string; credentials: string; claudeProjects: string }): Promise<string[]>`
    - Returns the credentials root, each other person's worktree scope directory, and each existing Claude project directory whose name starts with `claudeProjectDirOf(<worktrees>/<other.id>)`.
    - It is computed when each step starts.
  - `ExecutorContext.denyPaths?: string[]`, merged with `DEFAULT_DENY`

- [ ] **Step 1: Write failing tests**
```ts
// isolation: with a fake HOME holding projects for alice and bob, denyForPerson(alice, [bob]) contains bob's scope dir and bob's project dirs, not alice's, and always the credentials root
// claude: read-tier argv for alice denies Read(<bob scope>/**) and Read(<bob project dir>/**); write-tier sandbox.filesystem.denyRead includes them
// security/isolation: single local person → denyForPerson returns only the credentials root (no behaviour change locally)
```
- [ ] **Step 2:** Run those tests. Expected: FAIL.
- [ ] **Step 3:** Implement the interfaces above.
- [ ] **Step 4:** Run `pnpm test && pnpm typecheck && pnpm lint`, then a live check: a read step prompted to read another person's worktree file is refused by Claude.
- [ ] **Step 5:** Commit `feat: deny each person's steps the other people's files`.

---

### Task 9: Remote mode: OIDC sign-in, MCP OAuth, public bind

**Files:**
- Modify: `package.json` (add `openid-client@^6` and `express@^5` as direct dependencies)
- Modify: `src/config/schema.ts` (`people.oidc`, `people.overrides`), `src/front/hosts.ts` (`serveProblems`: OIDC present allows a non-loopback bind and requires an `https` `publicUrl`; rule `serve.public-url`)
- Create: `src/people/oidc.ts`, `src/people/session.ts`, `src/front/mcp-auth.ts`, `docs/remote.md`
- Modify: `src/front/server.ts`:
  - `/login`, `/login/callback`, `/logout`;
  - unauthenticated HTML → 302 to `/login`, JSON → 401;
  - `callerOf` reads the session;
  - `/mcp` sits behind bearer auth in remote mode
- Modify: `src/ui/server.ts` (`foreignWrite` accepts the `publicUrl` origin), `src/people/roster.ts`:
  - on sign-in, write the person record and resolve identities, applying `people.overrides` first;
  - an identity value held by another person → `failed`, "already belongs to another person"
- Modify: `src/namespace.ts` (`EventName`: `signin.ok`, `signin.refused`, `request.refused`)
- Modify: `src/cli/validate.ts`: with `people.oidc` set, also print each stored person's connection problems (`<person email>: rule: message`). The exit code still reflects instance problems only.
- Test: `tests/people/oidc.test.ts`, `tests/people/session.test.ts`, `tests/front/mcp-auth.test.ts`, `tests/front/server.test.ts`, `tests/people/roster.test.ts`
- Docs: `docs/remote.md` covers:
  - the OIDC app and its redirect URI `<publicUrl>/login/callback`;
  - OAuth app callbacks;
  - TLS proxy and port;
  - `tick.concurrency`;
  - the Claude token note;
  - shell access equals access to every credential.

  Also update `docs/configuration.md` and `docs/security.md`.

**Interfaces:**
- Consumes: `Roster`, `CredentialStore`, `resolvePerson`, `McpEndpoint`, `callerOf`, `serveProblems`
- Produces:
  - Config:
    - `people.oidc: { issuer: string (url); clientId: string; clientSecret: string ($VAR); scopes: string[] = ["openid","email","profile"] }`
    - `people.overrides: Record<email, Record<connId, Record<field, string>>>`
  - `createOidc(cfg, redirectUri: string): Promise<Oidc>`
    - `Oidc = { begin(returnTo: string): Promise<{ url: string; state: string }>; finish(callback: URL): Promise<Person> }`
    - The person id is `sub`. `email_verified !== true` → throw, and log `signin.refused`.
  - `createSessions(opts: { secure: boolean; ttlMs = 12 * 3600_000 }): Sessions`
    - `Sessions = { create(personId): string /* Set-Cookie */; personOf(req): string | null; destroy(req): string }`
    - Cookie `landrace_session`: HttpOnly, SameSite=Lax, Secure when `publicUrl` is https.
    - `ponytail:` in memory, so a restart signs everyone out. Persist only if that bites.
  - `createMcpAuth(opts: { publicUrl: string; sessions: Sessions; dataDir: string /* ~/.landrace */ }): { router: express.Router; verifier: OAuthTokenVerifier }`
    - It uses the SDK's `mcpAuthRouter` and an `OAuthServerProvider`.
    - Dynamic client registration and refresh tokens persist to `<dataDir>/mcp-clients.json` and `<dataDir>/mcp-tokens.json` (mode 0600; tokens stored as SHA-256 hashes).
    - Access tokens last 1 h and refresh tokens 30 days.
    - `authorize` without a session → 302 to `/login?return=<authorize url>`.
    - `AuthInfo.extra.personId` identifies the caller.
  - Every refused request logs `request.refused` with `person` set to the presented identity or `"anonymous"`.

- [ ] **Step 1: Write failing tests**
```ts
// oidc: fake issuer (discovery + jwks + token) → finish returns { id: sub, email }; email_verified false → throws and logs signin.refused
// session: cookie flags; expired session → personOf null
// mcp-auth: register → authorize (with session) → token → GET /mcp with bearer → tools for that person; no bearer → 401 with WWW-Authenticate resource metadata; tokens file holds hashes, not tokens
// server: remote, no session: GET / → 302 /login; GET /board.json → 401; request.refused logged with person "anonymous"
// hosts: oidc set + host 0.0.0.0 + publicUrl https → no problem; oidc set + publicUrl http on non-loopback → serve.public-url
// roster: overrides win over lookup; bob resolving to alice's jira accountId → bob's jira status failed "already belongs to another person"
```
- [ ] **Step 2:** Run those tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Mount the Express app for `/.well-known/*`, `/authorize`, `/token`, `/register` and `/mcp`; every other path falls through to the board listener.
- [ ] **Step 4:** Run `pnpm test && pnpm typecheck && pnpm lint && pnpm build`, then a live check: run against a test OIDC provider (for example a local Keycloak) on a non-loopback host behind TLS; sign in through the browser; `claude mcp add --transport http lr https://<host>/mcp` completes OAuth and lists the person's items. Expected: PASS end to end.
- [ ] **Step 5:** Commit `feat: remote mode: OIDC sign-in and MCP OAuth`.
