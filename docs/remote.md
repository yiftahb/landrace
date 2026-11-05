# Remote mode

One `landrace start` can run for a whole team. Each person signs in with your OpenID Connect provider, connects their own logins in the board's Integrations tab, and then sees only their own board and their own MCP tools.

Remote mode is on when `landrace.yaml` sets [`people.oidc`](configuration.md#people). Without it nothing on this page applies: nobody signs in, and the door stays on loopback.

Remote mode is unverified against a live provider. Its tests run against an in-memory provider that signs real RS256 ID tokens.

## Set it up

You need an OpenID Connect provider (Keycloak, Okta, Google, Entra ID and others), a host name, and a TLS proxy on the same machine.

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

## Signing in

A person opens the public URL.

1. Nobody is signed in, so the board sends them to `/login`, which sends them to the provider.
2. The provider sends them back to `/login/callback`. Landrace checks the answer and sets a `landrace_session` cookie: `HttpOnly`, `SameSite=Lax`, and `Secure` when `serve.publicUrl` is `https`.
3. They land on the page they asked for. Until their connections are ready, that is the Integrations tab; then it is their own board.

What Landrace checks:

- The provider must say the email is verified (`email_verified: true`). Otherwise sign-in is refused with `403`, no cookie is set, and `signin.refused` is logged.
- The sign-in must finish in the browser that began it, within ten minutes, and only once. A short-lived `landrace_login` cookie carries the binding.
- Where a person goes afterwards must be a path on this instance. Anything else, such as `//evil.example`, becomes `/`.

A person is known by the provider's subject (`sub`). Their credentials file is named after it. Sessions live in memory for 12 hours: a restart signs everyone out, and they sign in again. `/logout` ends a session.

Before signing in, a page request is redirected to `/login?return=<path>`, and any other request is answered `401`. Each is logged as `request.refused` with `person: "anonymous"`.

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

Registered clients are kept in `~/.landrace/credentials/mcp/mcp-clients.json`. Refresh tokens are kept only as hashes in `mcp-tokens.json` beside it. Both files are `0600`. A refresh token lasts 30 days and works once: using it returns a new one. Access tokens, codes and consent pages live in memory, so after a restart a client refreshes its token.

## Checking people

On a remote instance, [`landrace validate`](validate.md) also judges every person who has signed in, by the email they signed in with:

```text
  bob@example.org: connection.missing: secrets entry "forgeToken" has no value: ...
```

These lines are each person's to fix in their own Integrations tab. They never change the exit code: `validate` exits `0` when the instance itself is sound.

## Events

| Event | Fields | When |
|---|---|---|
| `signin.ok` | `person`, `personEmail` | A person signed in. |
| `signin.refused` | `person: "anonymous"`, `reason`, sometimes `personEmail` | A sign-in was refused. |
| `request.refused` | `person`, `path`, `status`, sometimes `reason` | A request from nobody signed in, or a consent approval refused. |
