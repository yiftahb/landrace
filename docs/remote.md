# Remote mode

One `landrace start` can run for a whole team. Each person signs in with your OpenID Connect provider, connects their own logins in the board's Integrations tab, and then sees only their own board and their own MCP tools.

Remote mode is on when `landrace.yaml` sets [`people.oidc`](configuration.md#people). Without it nothing on this page applies: nobody signs in, and the door stays on loopback.

Remote mode is unverified against a live provider. Its tests run against an in-memory provider that signs real RS256 ID tokens. What else is unverified is under [Limits](#limits).

This page walks a team from nothing to signed in: what to have ready, the setup, what each person does next, how their steps run, what is kept on disk, how to remove someone, and how to move from a local instance.

## Before you start

You need:

- **An OpenID Connect provider**, such as Keycloak, Okta, Google or Entra ID, where you can register a confidential client.
- **A host name** for the instance, such as `landrace.example.org`, that points at the machine `start` runs on.
- **A TLS proxy on the same machine**, which terminates `https` for that host name and forwards to Landrace. [A proxy example](#a-proxy-example) shows one.
- **The repository, checked out** where `landrace start` runs, with its `.landrace/` folder. Every person's steps cut their worktrees from this one checkout.
- **A way to limit who signs in, at the provider.** Landrace admits anyone your provider signs in for its client: see [Who can sign in](#who-can-sign-in).

## Set it up

Landrace has no list of who may sign in. Anyone the provider signs in for this client, with a verified email, gets a board and runs steps on this machine. With a public provider, such as Google, and no restriction there, that is anyone with an account. Limit it at the provider before you start: see [Who can sign in](#who-can-sign-in).

1. **Register Landrace at the provider** as a confidential client using the authorization-code flow. Set its redirect URI to your public URL followed by `login/callback`, for example `https://landrace.example.org/login/callback`. It asks for the `openid email profile` scopes.
2. **Put a TLS proxy in front.** It terminates `https` for your host name and forwards to `serve.host` and `serve.port`. The MCP authorization server rate-limits by client address, and takes the address from `X-Forwarded-For` only when the proxy connects from loopback.
3. **Configure the instance:**

   ```yaml
   serve:
     host: 0.0.0.0
     port: 4545
     publicUrl: https://landrace.example.org/
   people:
     oidc:
       issuer: https://id.example.org/realms/team
       clientId: landrace
       clientSecret: $LANDRACE_OIDC_SECRET
   ```

   Set `LANDRACE_OIDC_SECRET` in `.landrace/.env` to the secret the provider issued. What `validate` refuses here is listed in [validate](validate.md#loading).
4. **Start it** with `landrace start`. It prints `people sign in at <publicUrl>; <n> have before`. A remote instance always serves the board, so `--headless` and `--once` are refused.

An `http://` issuer is accepted only on loopback, for a provider you run on the same machine to try this out.

## A proxy example

This is an example, not the only way. It uses [Caddy](https://caddyserver.com/), which gets a certificate for the host name on its own and sets `X-Forwarded-For`. Put it in a file named `Caddyfile`:

```text
landrace.example.org {
	reverse_proxy 127.0.0.1:4545
}
```

Then run it from that folder:

```bash
caddy run
```

Caddy connects to Landrace from `127.0.0.1`, which is loopback, so Landrace trusts the `X-Forwarded-For` it sends. Caddy passes the request's `Host` on unchanged, and the door answers `serve.publicUrl`'s host ([The front door](security.md#the-front-door)).

With the proxy on the same machine, you can set `serve.host: 127.0.0.1` in place of `0.0.0.0`. The port is then closed to the network, and every request reaches Landrace through the proxy's TLS. With `0.0.0.0`, the port also answers plain HTTP from the network, and a request that comes that way is not from loopback, so its `X-Forwarded-For` is ignored.

## Who can sign in

Today Landrace admits anyone the provider signs in for this client, as long as the provider says their email is verified. There is no allow-list in `landrace.yaml`. Everyone admitted gets their own board and runs steps on this machine ([Security](security.md#remote-mode)).

So limit access at the provider. For example:

- **Keycloak:** a realm of its own for the team, or a client role that a user must hold before the client signs them in.
- **Google Workspace:** an OAuth consent screen of type "Internal", so only accounts in your Workspace organization can sign in.
- **Entra ID:** "Assignment required" on the enterprise application, with the team's users or groups assigned to it.

How to set each of these up is in your provider's own documentation.

## Signing in

A person opens the public URL.

1. Nobody is signed in, so the board sends them to `/login`, which sends them to the provider.
2. The provider sends them back to `/login/callback`. Landrace checks the answer and sets a `landrace_session` cookie: `HttpOnly`, `SameSite=Lax`, and `Secure` when `serve.publicUrl` is `https`.
3. They land on the page they asked for. Until their connections are ready, that is the Integrations tab; then it is their own board.

Their connections are ready when every connection their steps need is connected and none they stored has expired or failed. On a remote instance that means:

- **Their Claude Code token, in a Claude project.** Claude Code's connection is marked `required: remote`, so it is required on a remote instance, whatever the keys say.
- **Each [per-person key](configuration.md#per-person-keys).** A key's `env` variable is ignored here, even when it is set: it belongs to the machine, not to a person. Each person's value comes from their own connection.
- **Any connection a hook marks `required: always` or `required: remote`**, and any connection they stored, which must not have expired or failed.

While any of these is missing, nothing runs for that person: no tick lists their items, and their `/mcp` answers `503`. The page is the Integrations tab alone, as [A connection not made](cli.md#landrace-start) describes for a local start. Once their last connection is made, their runtime is built, and the board comes back at the next poll. Other people are not affected.

What Landrace checks:

- The provider must say the email is verified (`email_verified: true`). Otherwise sign-in is refused with `403`, no cookie is set, and `signin.refused` is logged.
- The sign-in must finish in the browser that began it, within ten minutes, and only once. A short-lived `landrace_login` cookie carries the binding.
- Where a person goes afterwards must be a path on this instance. Anything else, such as `//evil.example`, becomes `/`.

A person is known by the provider's subject (`sub`). Their credentials file is named after it. Sessions live in memory for 12 hours: a restart signs everyone out, and they sign in again. `/logout` ends a session and shows a signed-out page. It does not sign the person out of the identity provider: on a shared computer, sign out there too. Signing in again takes a click on that page.

Before signing in, a page request is redirected to `/login?return=<path>`, and any other request is answered `401`. Each is logged as `request.refused` with `person: "anonymous"`.

## After signing in

Each person sets up their own connections once, in the board's Integrations tab. It is in the cog menu at the top right. How the tab works is in [Command line](cli.md#the-board).

1. **Paste each credential the tab asks for.** A row that is not connected shows a form, with a hint on where the value comes from. Claude Code's is the output of `claude setup-token`. The connection's check judges the value before it is stored, and the tab shows why it refused one.
2. **Connect with GitLab or GitHub,** where the instance has that forge's OAuth app. The row shows a link in place of the form. It signs the person in at the forge and brings them back to the tab. Setting up the app is in [Integrations](integrations.md#connect-with-gitlab-or-github).
3. **Check the identities.** An identity, such as a Slack or Jira account, is never pasted. Landrace looks it up by the email the person signed in with: see [Identities](#identities). The row shows what the lookup found, so the person can see it is theirs.
4. **Connect an editor,** if they want the operator tools in a chat: see [Connecting an MCP client](#connecting-an-mcp-client).

Which connections a project offers, and which keys they answer, is in [Integrations](integrations.md#connections) and [Per-person keys](configuration.md#per-person-keys). Each connect or disconnect rebuilds that person's runtime, and the loop's next tick runs at once.

## Identities

On each sign-in, Landrace looks up each [identity](hooks.md#connections) the person has not stored by the email they signed in with.

Two people never share an identity. When a lookup gives a person an account another person already holds, it is marked failed on the newer one with "already belongs to another person". The person who held it first keeps it.

When a lookup cannot find someone, or finds the wrong account, pin it under `people.overrides` by their email:

```yaml
people:
  overrides:
    bob@example.org:
      github: { login: bob-gh }
```

An override is stored with `source: override` the next time they sign in, in place of a lookup. It must name an identity a hook defines, with exactly its fields; any other is logged as `connection.failed` and stored nowhere. An override is held to the same rule: one naming an account another person holds is marked failed too.

## How steps run for each person

Each person whose connections are ready has a runtime of their own. It loads every workflow in the workspace, with that person's own values.

- **Their own keys.** Every per-person key is filled from their own connections. In a Claude project, a step runs on their own Claude Code token, handed to it as `CLAUDE_CODE_OAUTH_TOKEN`. Codex has no per-person connection: a Codex step runs on the operator's own Codex login (`CODEX_HOME`). And while anyone else is on the roster, every Codex run is refused, because Codex cannot keep the per-person deny list (see [People on one instance](security.md#people-on-one-instance)). A secret written as a plain value or `$VAR` in `landrace.yaml` is the instance's, and every person's runtime gets the same one.
- **Their own events.** Every event their runtime logs carries their `person` id and `personEmail`.
- **One loop for everyone.** One schedule ticks every ready person's runtime together. The agent slots are shared: `tick.concurrency` bounds the steps running across the whole team, not per person.

**How items are shared.** Each person's runtime lists the tracker and claims items by the workflows' rules, as a local instance does. On each tick with more than one ready person, every listing is compared:

- An item one person's runtime claims is worked by that runtime alone, and shows on that person's board.
- An item two people's runtimes claim is worked by neither. Landrace logs `item.ambiguous`, naming the item and both people. This is the same rule as two workflows claiming one item: it halts rather than picking one.
- When one person's tracker cannot be listed, nobody can tell who else claims what. Runs already going on finish, and no new run starts for anyone on that tick.

So with the same workflows and nothing that differs per person, two ready people claim every item, and nothing new runs. Split the items between people. One way is a per-person var, filled from each person's connection, used in a workflow's `eligible` rule, as [Several developers, one repository](configuration.md#vars) shows for one instance per developer. With one ready person, nothing is compared, and they claim every item the workflows admit.

**Their own worktrees.** Each person's worktrees are cut in a folder of their own, `$TMPDIR/landrace/<repo>/worktrees/<person id>/`, named after their id URL-encoded. A step may not read another person's folder, their Claude Code sessions, or `~/.landrace/credentials`. What this keeps apart, and what it does not, such as the shared `.git`, is in [People on one instance](security.md#people-on-one-instance).

## Connecting an MCP client

Each person connects their editor or agent to `/mcp` with their own sign-in. No app at your provider is needed for this: Landrace is its own OAuth authorization server for MCP clients.

```bash
claude mcp add --transport http landrace https://landrace.example.org/mcp
```

1. The client calls `/mcp`, gets `401` with a `resource_metadata` link, and registers itself.
2. It opens `/authorize` in your browser. If you are not signed in, you sign in first.
3. A consent page names the client and where it sends you back. Approve only if you just asked your client to connect.
4. The client gets an access token for one hour and a refresh token. With it, `/mcp` serves your items and tools only.

Registration is open, which is why consent is asked every time. How the consent page is protected is in [Security](security.md#remote-mode).

Registered clients are kept in `~/.landrace/credentials/mcp/mcp-clients.json`. Refresh tokens are kept only as hashes in `mcp-tokens.json` beside it. Both files are `0600`. A refresh token lasts 30 days and works once: using it returns a new one. Access tokens, codes and consent pages live in memory, so after a restart a client refreshes its token. If either file cannot be read or does not hold a JSON object, `start` logs it once and keeps running. The board still works, but `/mcp` and the sign-in routes answer `503` with the file's name until you fix or remove the file and restart.

## Checking people

On a remote instance, [`landrace validate`](validate.md) also judges every person who has signed in, by the email they signed in with:

```text
  bob@example.org: connection.missing: secrets entry "forgeToken" has no value: ...
```

These lines are each person's to fix in their own Integrations tab. They never change the exit code: `validate` exits `0` when the instance itself is sound. A per-person key that names a connection no hook defines is a problem with the instance, not with a person. It is reported once and fails `validate`, even when nobody has signed in yet.

## What is on disk

Everything a person connects is under `~/.landrace/credentials/`, in the home folder of the user that runs `start`:

| Path | Holds | Mode |
|---|---|---|
| `~/.landrace/credentials/` | The folder itself | `0700` |
| `~/.landrace/credentials/<person id>.json` | One person: their id, email and name as they signed in, and each connection they made or Landrace looked up, with its values. The id is the provider's `sub`; the file is named after it, URL-encoded | `0600` |
| `~/.landrace/credentials/local.json` | The operator's own connections, from a local instance. Nobody signs in as `local` | `0600` |
| `~/.landrace/credentials/mcp/mcp-clients.json` | Every MCP client that registered | `0600` |
| `~/.landrace/credentials/mcp/mcp-tokens.json` | Each MCP refresh token, as a hash, with the client and the person it was issued to, and when it ends | `0600` |

The roster, the people `start` runs for, is every person's file but `local.json`. `start` reads it once, when it begins. A person who signs in for the first time joins it then.

**Backups.** Back up the whole `~/.landrace/credentials/` folder, and keep the copy as safe as the credentials in it: it holds every person's tokens. Back up `.landrace/.env` too, for `LANDRACE_OIDC_SECRET`. What is lost without each part:

- Without a person's file, they have no connections. They are in the roster again the next time they sign in, and connect everything again.
- Without the `mcp/` folder, Landrace knows no MCP client. Each person connects their editor again, and approves it again.

Sessions, MCP access tokens, and sign-ins and connects in progress live in memory. A backup holds none of them, and a restart ends them all.

How the files are written, and how a step is kept from reading them, is in [Stored credentials](security.md#stored-credentials).

## Removing a person

No single action ends a person's access. Each of these ends one part of it:

| Step | What it ends | What it leaves |
|---|---|---|
| Remove them at the provider, or take away what lets them sign in to this client | Every new sign-in | A session they already hold lasts its 12 hours. Signing them out at the provider alone ends nothing on Landrace, since Landrace does not ask the provider again |
| Restart `start` | Every session and MCP access token, for everyone | Their refresh tokens, which still issue access tokens. Their file, which keeps them in the roster |
| Remove their refresh tokens from `mcp-tokens.json`, while `start` is stopped | Their MCP clients' way back in | An edit while `start` runs is lost: `start` holds the entries in memory, and its next write of the file puts them back |
| Delete their file in `~/.landrace/credentials/`, named after their id URL-encoded, while `start` is stopped | Their place in the roster, and every connection they stored | Their worktree folder, which Landrace does not remove |

To remove someone completely, do all four, in this order:

1. Remove them at the provider.
2. Stop `start`.
3. Delete their credentials file. Their id is the `person` field of their `signin.ok` events. The file's name is that id URL-encoded, so a `sub` such as `auth0|abc` names `auth0%7Cabc.json`.
4. Remove their refresh tokens. With [jq](https://jqlang.org/), replace `<person id>` with their id as the `person` field gives it, not the file's name:

   ```bash
   cd ~/.landrace/credentials/mcp
   jq --arg id '<person id>' 'with_entries(select(.value.person.id != $id))' mcp-tokens.json > mcp-tokens.json.new
   chmod 600 mcp-tokens.json.new
   mv mcp-tokens.json.new mcp-tokens.json
   ```

5. Start `start` again.

Skip the first step, and they sign in again: Landrace makes them a new file, and they connect again. Skip the rest, and a session they hold, or an MCP client's refresh token, keeps working.

The tokens they connected are still valid at each system that issued them: their Claude Code token, and their forge tokens. Revoke those at each system too.

## From a local instance

A local instance runs for one person, `local`, the operator. Adding `people.oidc` changes that:

- **Who it runs for.** `start` no longer runs anything for `local`. It runs for each person who signs in, each with their own board and runtime.
- **Where it listens.** `serve.host` may be other than loopback, and `serve.publicUrl` is required, `https` off loopback ([The front door](configuration.md#the-front-door)).
- **Where values come from.** A per-person key's `env` variable is ignored, and each person connects their own value. Your shell's `GITHUB_TOKEN`, say, no longer answers anyone's `githubToken`.
- **No pairing.** A person on a remote instance has no terminal on this machine, so pairing is off.
- **Your items stay where they are.** State is read from the tracker, so each person's runtime picks items up where the local one left them. Split them between people first: see [How items are shared](#how-steps-run-for-each-person).

**Editors move to HTTP.** The operator tools are served at `/mcp` beside the board, never over stdio. An editor still configured to run `landrace mcp` gets the message in [landrace mcp](cli.md#landrace-mcp), and exits. Each person points their editor at the instance instead:

```bash
claude mcp add --transport http landrace https://landrace.example.org/mcp
```

Then they sign in through OAuth: see [Connecting an MCP client](#connecting-an-mcp-client).

**`people.local` keeps meaning the operator.** `local.json` stays your own file: nobody can sign in as `local`, and the roster leaves it out. A command you run on the machine, such as `landrace next`, still reads it, as on a local instance. `start` itself no longer stamps its events with `people.local`: each person's runtime stamps theirs with their own id and email.

## Limits

- **Unverified live.** These are tested against stubs in the test suite only:
  - A real OpenID Connect provider behind TLS.
  - MCP OAuth from a real editor.
  - Connect with GitLab or GitHub against the real forges ([Limits](integrations.md#connect-with-gitlab-or-github)).
  - A step refused another person's worktree on a real run.
- **No allow-list.** Landrace admits anyone your provider signs in with a verified email: see [Who can sign in](#who-can-sign-in).
- **No single way to remove a person.** See [Removing a person](#removing-a-person).
- **Sessions live in memory.** A restart signs everyone out, and ends every MCP access token.
- **Registration is open.** Any MCP client can register, so every token waits on a signed-in person's consent ([Security](security.md#remote-mode)).
- **The roster is read at start.** A person's file deleted while `start` runs keeps them in the roster until the next start.
- **One operating-system user.** Every person's steps run as the user that runs `start`, beside one shared `.git`: see [People on one instance](security.md#people-on-one-instance).

## Events

| Event | Fields | When |
|---|---|---|
| `signin.ok` | `person`, `personEmail` | A person signed in. |
| `signin.refused` | `person: "anonymous"`, `reason`, sometimes `personEmail` | A sign-in was refused. |
| `request.refused` | `person`, `path`, `status`, sometimes `reason` | A request from nobody signed in, or a consent approval refused. |
| `item.ambiguous` | `item`, `people` | Two people's runtimes claim one item, so neither works it. |
