# Landrace remote: people, connections, one front door

Status: draft for approval · 2026-11-04

## Intent

Today Landrace is one developer's runner on one laptop: one assignee, one set of credentials in `.landrace/.env`, a loopback board, and a stdio MCP server. A team that wants Landrace has to run one copy per developer, each wired by hand.

This design lets **one Landrace instance serve a team from a remote host** (a cloud dev workspace, a VM). Each developer signs in, connects their own accounts once, and gets the experience they have locally today: their board, their items, the MCP from their own agent. The instance runs on shared bot and agent credentials. It holds no one's personal secrets except the few that must be personal.

The same connection model also makes **local setup simpler**. Integrations are connected in the UI instead of collected into `.env` by hand.

## Goals

1. One instance, many people. Each person sees and drives only their own items.
2. Sign-in to Landrace through a generic OIDC provider (Okta, Keycloak, Google, …).
3. **Connections**: each integration declares what it needs from each person. Each person supplies it in an Integrations tab. Validate reports what is missing per person, and a person's board stays hidden until their connections are complete.
4. One HTTP front door on one port, for remote and local: the UI at `/`, the MCP at `/mcp`, behind the same sign-in.
5. Work and cost scale per person. Each tick builds each connected person's items, not the whole team's board followed by a filter.
6. Much higher concurrency for a shared instance, shared fairly between people.
7. Rate-limit and usage-limit problems are logged and exported over OTEL, so they can be debugged later.
8. Every log and telemetry record about a person or their items carries that person's identity (Decision §10).
9. Nothing is worked on unless a person opted the item in. That holds today and must keep holding.

## Non-goals (v1)

- **Pairing on a remote instance.** It stays local-only. For later: whatever replaces it must end with the step's artifact in the world (comment, push, label), so the engine re-evaluates without holding local state.
- **API-key access to the front door.** Every remote client signs in.
- **An org-wide Claude key fallback.** A person without a Claude connection has no items run.
- **An admin UI.** The admin is whoever has a shell on the host.
- **OS-level isolation between people's agent runs** (an OS user or a container per person). For later, through the `agent.isolation: container` value the schema already reserves. v1 relies on deny rules (Decision §9).
- **Acting in trackers or forges as the person.** Comments, labels, merge requests, pushes and commits stay the bot's.

## Anti-goals (a failure even if it works)

- A person can see, drive or spend on another person's items through the UI or MCP. For agent runs, see Decision §9.
- An agent step can reach the operator MCP and move its own item. That would be a regression of today's guarantee.
- A local single-developer setup gets harder or breaks. The only allowed break is the MCP transport (see Decisions §1).
- Any integration or project specifics leak into the engine. Landrace stays generic.
- Personal credentials leak into another person's step, a log, a comment or an OTEL export. A person's own Claude token in their own step's environment is the one allowed exception: it is how `claude -p` authenticates, and it is the same exposure as a local operator's own `claude` login today. *(My call.)*

## Constraints

- **Backward compatibility, local.** An existing `landrace.yaml` + `.env` keeps working unchanged: same secrets, same vars, same `$LANDRACE_ASSIGNEE` and `jiraAssignee` scoping, same Slack webhook. The one breaking change is that the stdio MCP server goes away.
- **The engine stays stateless.** State lives in the world (tracker, forge). The credentials store holds secrets, not workflow state.
- **The bot acts.** The forge token, tracker credentials, agent MCP servers and the agent API key stay instance-wide (`.env` / environment).
- **Opt-in is preserved.** Admission rules (`admit`, `eligible`) are unchanged, and remote adds no automatic admission.

## Decisions

### 1. One front door: HTTP, one port, UI and MCP

- `landrace start` serves the UI at `/` and the operator MCP at `/mcp` (MCP Streamable HTTP) on one port. This replaces stdio `landrace mcp` everywhere, local included. **This is the one breaking change.**
- **Consequence:** the MCP is available only while `landrace start` runs. Today `landrace mcp` runs standalone. The docs and the editor-connection instructions change to `claude mcp add --transport http landrace <url>/mcp`, and the same for Codex and Cursor.
- `--workflow <id>` scoping survives as a path or query on `/mcp`. Its exact shape is the builder's call.
- **Unchanged:** the per-step child MCP servers (`landrace mcp --child …`) that agents get inside a step. They are internal and not the operator front door.
- **Also unchanged, as an internal exception:** the stdio operator server that local pairing hands the person's session (`src/runner/pair.ts`, scoped with `--workflow`). It stays internal and is no longer documented as an editor entry point. *(My call. Pairing is local-only, so this keeps it unchanged, with no minted tokens and no OAuth step per pairing.)*
- **Configurable bind:** host, port and public URL. Local defaults stay `127.0.0.1:4545`, with today's Host and Origin checks. Remote binds wider and sits behind TLS. The public URL is what OAuth redirects and MCP metadata advertise. It must be able to serve at a host root, for example port 80 or 443 behind a proxy, so a person opens `https://host/` and connects to `https://host/mcp`.

### 2. Sign-in

- **Remote:** generic OIDC is configured instance-wide (issuer, client id, client secret from `.env`). Who may sign in is the identity provider's business (app assignment or groups). Landrace has no allow-list in v1.
- **Browser:** the UI uses a normal OIDC login and a session cookie.
- **MCP:** follows the MCP authorization spec (OAuth 2.1), so an MCP client such as Claude Code runs the browser sign-in itself and the person never pastes a key. How Landrace fronts the OIDC provider for MCP clients (as its own authorization server delegating to OIDC, or otherwise) is the builder's call. The requirement is that `claude mcp add --transport http …/mcp` followed by the client's normal auth flow just works.
- **Local, no OIDC configured:** there is one implicit person, no login, and today's threat model. It runs on loopback with the existing Host and Origin checks, exactly as the board is protected now. Any local process can already spawn stdio `landrace mcp` today, so an unauthenticated loopback `/mcp` exposes nothing new. *(My call. It replaces an earlier idea of a local approval click, which a local process could click through anyway.)*
- **Steps may never reach the operator server, local or remote.** The refusal of Landrace's own server to steps (today by name and command line) extends to its HTTP URL. The step sandbox's network rules must not allow the front door's host and port, loopback included. A test proves that a write step cannot reach `/mcp` or the board's action endpoints.

### 3. People

- **A person** is a signed-in identity: OIDC subject, email and display name, plus that person's values and connections. Locally, the implicit person is built from `.env` exactly as today.
- **Per-person keys.** Config marks which secrets and vars are per person. Examples are the assignee var, a personal forge token, and a notification user id. Everything else stays instance-wide. A per-person key resolves against the person who owns the item being worked or the request being served.
- **The item's person** is resolved through the tracker's assignee mapped to a connected person. An item whose assignee is not a fully connected person is listed nowhere and never run.
- **An item whose assignees map to more than one connected person halts as ambiguous.** GitHub issues allow several assignees. This follows the engine's rule against first-match-wins. *(My call.)*
- **Per-person vars mean one loaded workspace per person.** Vars are still substituted into `workflow.yaml` at load and validated after that. A remote instance loads and validates the workspace once per connected person, with that person's values: today's "one instance per developer", inside one process. It reloads when someone connects or disconnects. `eligible` rules on the assignee var stay enforced as defence in depth. *(My call: validate and the condition checks stay as they are.)*
- **Hooks** get an API for the current person: identity, per-person values, and credentials by connection. Code that calls `ctx.secrets.get(name)` today keeps working. For a per-person key it returns the current person's value.

### 4. Connections

- **An integration declares its per-person needs.** Each need is one of two kinds:
  - **Credential:** a secret the person supplies. It is obtained by **OAuth** when the instance has that provider's OAuth app configured (client id and secret in `.env`), otherwise by **pasting a token**. Examples: a personal forge token, a Claude subscription token.
  - **Identity:** just "which account on that service is you". It is resolved from the identity provider's verified email, using the instance's own (bot) credentials, and shown to the person. Examples: tracker account id, chat user id.
    - **The person can't edit it.** If they could, they could claim someone else's account, and with it that person's items.
    - **One account per person,** enforced.
    - **When an email doesn't resolve, or resolves wrongly,** the admin sets an override in instance config. *(My call.)*
- **Validate** reports instance problems as today, plus missing, expired or failed connections per person.
- **The UI** gets an **Integrations** tab. Until a person's required connections are complete, it is the only thing they see. Their board appears once validate passes for them. Remote, a person with incomplete connections has no items run.
- **Storage:** `~/.landrace/credentials/<person>` (per instance host user), file mode 0600, readable only by the host user. Credentials never enter logs, OTEL, comments or prompts, and they join the redaction set like secrets.
- **Local is a first-class user of this.** A fresh local setup should need only the instance-level minimum in `.env`. Personal pieces are connected in the UI. **Precedence (my call):** if a key is set explicitly in `.env` / the environment, it wins. Otherwise the connection supplies it. That is what keeps existing setups unchanged.

### 5. Integration changes (built-ins)

- **Tracker (Jira):** listings are scoped to all connected people's account ids (instead of the single `jiraAssignee`), and each item maps to its person. A single `jiraAssignee` keeps today's behaviour. The tracker account id is an identity connection.
- **Forges (GitLab, GitHub):** the forge token stays the instance's bot. A per-person user credential (OAuth or a pasted personal token) is added for hooks that must act as the person, such as drafting into that person's own pending review.
- **Claude:**
  - A credential connection: a token the person makes with `claude setup-token` and pastes in.
  - That person's steps run with `CLAUDE_CODE_OAUTH_TOKEN` set to it, so each person's runs use their own subscription seat.
  - The agent environment must never also carry `ANTHROPIC_API_KEY` (it would win) and must not run with `--bare` (it ignores the token).
  - The token lasts one year, so Landrace records when it was connected, warns ahead of expiry, and treats an auth failure as an expired connection.
  - With no connection locally, today's behaviour (the operator's own `claude` login) is unchanged.
  - Docs note that whether a subscription token may run on a shared host is between the deployer and Anthropic.
- **Slack:** a **bot** mode is added: a bot token (instance-wide) posts to the item's person, a DM or a mention, resolved as an identity connection by email (`users.lookupByEmail`). The incoming-webhook mode keeps working unchanged for existing setups.
- **Other shipped integrations** (Notion, Codex) declare their needs under the same model. Their exact needs are the builder's call.

### 6. Scheduling and concurrency

- Each tick builds items per connected person. Cost grows with the people who are connected and their items, not with the whole team. Exactly how listings are batched (one scoped query, or one per person) is the builder's call, as long as a person's view never waits on a full-team rebuild.
- `tick.concurrency` stays the global cap. A shared instance sets it much higher than today's default of 3. People get turns in rotation, so one person's queue can't starve the others.
- Nothing runs for a person whose connections are incomplete or expired.

### 7. Rate limits are visible

- Landrace detects and logs limit hits as structured events that the existing OTEL telemetry exports:
  - agent runs that end on a rate limit or usage limit;
  - HTTP 429 and quota responses from integration clients (forge, tracker, chat, Notion).
- Each event carries the person, integration, workflow, item, stage and round, plus any retry-after.
- **v1 changes logging only.** If today's behaviour turns a limit into a failed or stuck round, the builder flags it rather than redesigning retries here.

### 8. Views and permissions

- The UI and MCP show the signed-in person's items only. Needs You is per person. Notifications go to the item's person.
- MCP tools and UI actions are scoped to the caller. Admit, goto, reply, update and create act only on the caller's own items. Items they create are assigned to them.
- **Pairing** is not offered on a remote instance (UI and MCP). Locally it is unchanged.

### 9. Isolation between people's steps (v1: trusted team plus deny rules)

- All steps run as the one host user. **Decided for v1:** a team of trusted colleagues. The hard guarantee is at the UI and MCP (§8). For agents, Landrace closes the obvious paths:
  - every step, read-only as well as write (today only write steps get deny rules), is denied reading and writing `~/.landrace/credentials/`;
  - every step is denied other people's worktrees and other people's agent transcripts;
  - write steps keep today's sandbox.
- The deny rules are covered by tests: a read-only step and a write step of person A cannot read B's credentials file, B's worktree or B's transcripts.
- **Known residual risk, documented in `docs/security.md`:** a gap in the deny rules, or a step's Bash outside the sandbox, could still read another person's secrets. A deployer who needs more waits for container isolation.

### 10. Telemetry carries identity

- The OTEL export stays instance-wide. It is configured by the existing `OTEL_*` and `LANDRACE_ENABLE_TELEMETRY` environment variables on the host, so one remote instance ships every person's logs to one backend.
- **Every log event and OTEL record that concerns a person carries that person's identity:**
  - item, step, round, hook, notification and rate-limit events carry the item's person;
  - UI and MCP actions (admit, goto, reply, update, create, connect, disconnect, sign-in, sign-out) carry the person who acted;
  - a refused request carries the identity it presented, or "anonymous".
- Today an event's fields export as `landrace.<key>` attributes (`src/telemetry/otel.ts`), so the person becomes fields on the event: the identity provider subject and email. Instance-only events (startup, config, tracker listing) carry none.
- Locally, the implicit person's identity is whatever the operator configured (for example the assignee's email), so local and remote logs read the same.
- Identity is the person's id and email only. Credentials and tokens never appear: they stay in the redaction set.
- **Left to the builder:** the attribute names. They may follow OTEL semantic conventions (`user.id`, `user.email`) or `landrace.person.*`, but one convention is used everywhere.

## Left to the builder

- How the MCP OAuth flow fronts the OIDC provider.
- The shape of `/mcp` workflow scoping.
- The local-approval mechanics, after a security review.
- The credentials file format, and whether to encrypt it at rest beyond 0600.
- Listing batch strategy; fairness algorithm; config field names for per-person keys, connections, bind host/port/public URL, and the OIDC and OAuth apps.
- How each shipped integration declares its needs.
- How validate presents per-person results in the CLI vs the UI.
- Migration docs for stdio MCP users.

## Risks

- **The MCP transport break.** Every existing editor config must change. Document it in the release notes, and make `landrace mcp` print the new instruction rather than failing silently.
- **A single host user holds every person's credentials.** Shell access to the host means access to all of them, and so does a step that slips past the deny rules (§9). The deployer must restrict shell access. Docs say so.
- **Subscription tokens on a shared host:** a policy question for the deployer and Anthropic, not a technical one.
- **MCP client OAuth support** varies by client and version. Check Claude Code, Codex and Cursor before v1 ships.
