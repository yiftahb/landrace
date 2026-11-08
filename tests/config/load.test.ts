import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertConfigUsable, configProblems, loadConfig, varsHoldingSecrets } from "#config/load.js";

const CONFIG = `version: 1
agent: { adapter: claude, model: opus }
tracker: { repo: acme/widgets }
tick: { interval: 60s, concurrency: 3 }
security: { screen: true, model: haiku }
log: { redact: [githubToken] }
secrets: { githubToken: $GITHUB_TOKEN }
`;

async function fixture(env: string | null, extra = ""): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), "landrace-cfg-")), ".landrace");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "landrace.yaml"), CONFIG + extra);
  if (env !== null) await writeFile(join(dir, ".env"), env);
  return dir;
}

describe("the workflows order", () => {
  it("reads the order the sidebar lists workflows in", async () => {
    const { config } = await loadConfig(await fixture("", "workflows: [main, fastlane]\n"));
    expect(config.workflows).toEqual(["main", "fastlane"]);
  });

  it("refuses an empty name", async () => {
    await expect(loadConfig(await fixture("", 'workflows: [""]\n'))).rejects.toThrow(/workflows/);
  });
});

describe("agent.signature", () => {
  const withAgent = async (agent: string): Promise<string> => {
    const dir = await fixture("");
    await writeFile(join(dir, "landrace.yaml"), CONFIG.replace("agent: { adapter: claude, model: opus }", agent));
    return dir;
  };

  it("is on unless it is written false", async () => {
    expect((await loadConfig(await fixture(""))).config.agent.signature).toBe(true);
    expect((await loadConfig(await withAgent("agent: { adapter: claude, signature: false }"))).config.agent.signature).toBe(false);
  });

  it("refuses anything but true or false", async () => {
    await expect(loadConfig(await withAgent("agent: { adapter: claude, signature: off-ish }"))).rejects.toThrow(/signature/);
  });
});

describe("the notify block", () => {
  it("reads which events notify, and through which notifiers", async () => {
    const { config } = await loadConfig(await fixture("", "notify: { on: [needs-you], via: [slack] }\n"));
    expect(config.notify).toEqual({ on: ["needs-you"], via: ["slack"] });
  });

  it("is optional", async () => {
    expect((await loadConfig(await fixture(""))).config.notify).toBeUndefined();
  });

  it.each([
    ["an event the engine never fires", "notify: { on: [done], via: [slack] }\n"],
    ["a key it does not read", "notify: { on: [needs-you], via: [slack], thread: true }\n"],
    ["no notifier to send through", "notify: { on: [needs-you], via: [] }\n"],
  ])("refuses %s", async (_, block) => {
    await expect(loadConfig(await fixture("", block))).rejects.toThrow();
  });
});

describe("loadConfig", () => {
  it("resolves a secret from the workflow folder's .env", async () => {
    const { config, secretValues, missing } = await loadConfig(await fixture("GITHUB_TOKEN=ghp_x"));
    expect(config.tracker.repo).toBe("acme/widgets");
    expect(secretValues.get("githubToken")).toBe("ghp_x");
    expect(missing).toEqual([]);
  });

  it("reports an unresolved reference instead of passing $GITHUB_TOKEN to a hook", async () => {
    const { missing } = await loadConfig(await fixture(""));
    expect(missing).toEqual(["githubToken"]);
  });

  it("works with no .env at all, falling back to the process environment", async () => {
    process.env.GITHUB_TOKEN = "from-shell";
    const { secretValues } = await loadConfig(await fixture(null));
    expect(secretValues.get("githubToken")).toBe("from-shell");
    delete process.env.GITHUB_TOKEN;
  });

  it("never puts a resolved secret back into the config object", async () => {
    const { config } = await loadConfig(await fixture("GITHUB_TOKEN=ghp_x"));
    expect(JSON.stringify(config)).not.toContain("ghp_x");
  });

  it("exposes the telemetry settings, .env over the shell, and nothing else from the environment", async () => {
    process.env.OTEL_SERVICE_NAME = "from-shell";
    process.env.OTEL_LOGS_EXPORTER = "console";
    try {
      const { telemetry } = await loadConfig(await fixture("GITHUB_TOKEN=ghp_x\nOTEL_SERVICE_NAME=from-file\n"));
      expect(telemetry.get("OTEL_SERVICE_NAME")).toBe("from-file");
      expect(telemetry.get("OTEL_LOGS_EXPORTER")).toBe("console");
      expect(telemetry.has("GITHUB_TOKEN")).toBe(false);
      expect(telemetry.has("PATH")).toBe(false);
    } finally {
      delete process.env.OTEL_SERVICE_NAME;
      delete process.env.OTEL_LOGS_EXPORTER;
    }
  });

  // The gitignore guard itself (runValidate's ".env exists but is not
  // gitignored" check) is exercised against real git repositories in
  // tests/cli/gitignore.test.ts — gitignore semantics (negation, nesting)
  // cannot be verified against a bare fixture directory.
});

/**
 * `vars`, which is the same `$VAR` expansion as `secrets` pointed at a
 * different destination: a secret is handed to a hook, a var is substituted
 * into the workflow before it is validated.
 *
 * What it must never do is resolve to *something* when there was nothing. A
 * var that fell back to the literal "$LANDRACE_ASSIGNEE", or to "", would
 * substitute an eligibility rule that matches no item at all — and the
 * operator's evidence would be a repository where nothing ever happens, which
 * is the hardest failure this system has.
 */
describe("loadConfig resolves the vars block", () => {
  const withVars = (block: string, env: string | null) =>
    fixture(env, `vars:\n${block}`);

  it("resolves a reference from .env and passes a literal through unchanged", async () => {
    const { vars, missingVars } = await loadConfig(
      await withVars("  assignee: $LANDRACE_ASSIGNEE\n  team: platform\n", "GITHUB_TOKEN=t\nLANDRACE_ASSIGNEE=ann"),
    );
    expect(vars.get("assignee")).toBe("ann");
    expect(vars.get("team")).toBe("platform");
    expect(missingVars).toEqual([]);
  });

  it("reports an unresolved reference rather than substituting the literal $LANDRACE_ASSIGNEE", async () => {
    const { vars, missingVars } = await loadConfig(await withVars("  assignee: $LANDRACE_ASSIGNEE\n", "GITHUB_TOKEN=t"));
    expect(missingVars).toEqual(["assignee"]);
    expect(vars.has("assignee")).toBe(false);
  });

  /*
   * The case the "never an empty string" rule is actually about: the variable
   * *is* set, to nothing. Resolution succeeds, the reference is gone, and the
   * workflow gets `$in: [""]` — a filter that silently claims no item.
   */
  it("reports a variable that resolves to an empty value, which resolution alone would accept", async () => {
    const { vars, missingVars } = await loadConfig(
      await withVars("  assignee: $LANDRACE_ASSIGNEE\n", "GITHUB_TOKEN=t\nLANDRACE_ASSIGNEE="),
    );
    expect(missingVars).toEqual(["assignee"]);
    expect(vars.has("assignee")).toBe(false);
  });

  it("reports a whitespace-only value too, which trims to the same nothing", async () => {
    const { missingVars } = await loadConfig(
      await withVars("  assignee: $LANDRACE_ASSIGNEE\n", 'GITHUB_TOKEN=t\nLANDRACE_ASSIGNEE="   "'),
    );
    expect(missingVars).toEqual(["assignee"]);
  });

  it("keeps the resolved value out of the config object, exactly as a secret's is", async () => {
    const { config } = await loadConfig(
      await withVars("  assignee: $LANDRACE_ASSIGNEE\n", "GITHUB_TOKEN=t\nLANDRACE_ASSIGNEE=ann"),
    );
    // The reference as written, not what it resolved to: `config` is what a
    // hook is handed and what a debug dump prints.
    expect(config.vars).toEqual({ assignee: "$LANDRACE_ASSIGNEE" });
  });
});

/**
 * A var is not a second way to hold a secret, and the difference is not a
 * matter of taste: secrets are redacted from every log line and event by
 * value, vars are not, and a var reaches a comment body and an agent's prompt.
 *
 * Compared by value rather than by reference text, because the interesting
 * mistake is `vars: { token: $GITHUB_TOKEN }` beside `secrets: { githubToken:
 * $GITHUB_TOKEN }` — two names, one value, one of them redacted.
 */
describe("a var that is really a secret", () => {
  it("is named, when it resolves to the same value a secret does", async () => {
    const loaded = await loadConfig(await fixture("GITHUB_TOKEN=ghp_x", "vars:\n  token: $GITHUB_TOKEN\n"));
    expect(varsHoldingSecrets(loaded)).toEqual(["token"]);
  });

  it("is named when the value was typed out rather than referenced", async () => {
    const loaded = await loadConfig(await fixture("GITHUB_TOKEN=ghp_x", "vars:\n  token: ghp_x\n"));
    expect(varsHoldingSecrets(loaded)).toEqual(["token"]);
  });

  // #229: only a per-person key an identity answers is exempt, and that is
  // `resolvePerson`'s to judge; two variables that happen to agree are not one.
  it("is named when two variables hold one account id", async () => {
    const dir = await fixture("LR_X=acc-5b10ac8d82e05b22\nLR_Y=acc-5b10ac8d82e05b22\n", "vars: { me: $LR_X }\n");
    await writeFile(join(dir, "landrace.yaml"), CONFIG.replace("secrets: { githubToken: $GITHUB_TOKEN }", "secrets: { githubToken: $GITHUB_TOKEN, jiraAssignee: $LR_Y }") + "vars: { me: $LR_X }\n");
    const loaded = await loadConfig(dir);
    expect(varsHoldingSecrets(loaded)).toEqual(["me"]);
    expect(() => assertConfigUsable(dir, loaded)).toThrow(/vars: vars entry "me" resolves to the same value as a secret/);
  });

  it("leaves a pair with a per-person key in it to the person's judging", async () => {
    const dir = await fixture("LR_X=acc-5b10ac8d82e05b22\nLR_Y=acc-5b10ac8d82e05b22\n");
    await writeFile(join(dir, "landrace.yaml"), CONFIG.replace("secrets: { githubToken: $GITHUB_TOKEN }",
      "secrets: { githubToken: $GITHUB_TOKEN, jiraAssignee: { perPerson: true, env: LR_Y, connection: jira.accountId } }") +
      "vars: { me: $LR_X }\n");
    expect(varsHoldingSecrets(await loadConfig(dir))).toEqual([]);
  });

  it("says nothing about an ordinary var", async () => {
    const loaded = await loadConfig(await fixture("GITHUB_TOKEN=ghp_x", "vars:\n  team: platform\n"));
    expect(varsHoldingSecrets(loaded)).toEqual([]);
  });
});

/**
 * #175: `agent.git` per instance. Its values may be `$VAR` or `${VAR}`,
 * resolved from `.env` over the environment and written back into
 * `config.agent.git`, so the kit and every hook read the resolved identity.
 */
describe("agent.git's references", () => {
  const withGit = async (git: string, env: string): Promise<string> => {
    const dir = await fixture(env);
    await writeFile(join(dir, "landrace.yaml"), CONFIG.replace("agent: { adapter: claude, model: opus }", `agent: { adapter: claude, git: ${git} }`));
    return dir;
  };

  it.each([
    ["$VAR", "{ name: $LR_GIT_NAME, email: $LR_GIT_EMAIL }"],
    ["${VAR}", '{ name: "${LR_GIT_NAME}", email: "${LR_GIT_EMAIL}" }'],
  ])("resolves a %s reference from .env into config.agent.git", async (_, git) => {
    const dir = await withGit(git, "GITHUB_TOKEN=ghp_xxxxxxxxxxxx\nLR_GIT_NAME=Dev One\nLR_GIT_EMAIL=dev1@example.invalid\n");
    const loaded = await loadConfig(dir);
    expect(loaded.config.agent.git).toEqual({ name: "Dev One", email: "dev1@example.invalid" });
    expect(configProblems(dir, loaded)).toEqual([]);
  });

  it("keeps a literal as written", async () => {
    const dir = await withGit("{ name: landrace, email: bot@example.invalid }", "GITHUB_TOKEN=ghp_xxxxxxxxxxxx\n");
    expect((await loadConfig(dir)).config.agent.git).toEqual({ name: "landrace", email: "bot@example.invalid" });
  });

  it.each([
    ["unset", "GITHUB_TOKEN=ghp_xxxxxxxxxxxx\nLR_GIT_EMAIL=dev1@example.invalid\n"],
    ["empty", "GITHUB_TOKEN=ghp_xxxxxxxxxxxx\nLR_GIT_NAME=\nLR_GIT_EMAIL=dev1@example.invalid\n"],
    ["blank", 'GITHUB_TOKEN=ghp_xxxxxxxxxxxx\nLR_GIT_NAME="  "\nLR_GIT_EMAIL=dev1@example.invalid\n'],
  ])("refuses a variable that is %s, naming the key and the variable, for validate and start", async (_, env) => {
    const dir = await withGit("{ name: $LR_GIT_NAME, email: $LR_GIT_EMAIL }", env);
    const loaded = await loadConfig(dir);
    expect(configProblems(dir, loaded)).toEqual([{
      rule: "vars",
      message: expect.stringMatching(/^agent\.git\.name is \$LR_GIT_NAME, which does not resolve to a usable value; set it in .*\.env/),
    }]);
    expect(() => assertConfigUsable(dir, loaded)).toThrow(/vars: agent\.git\.name is \$LR_GIT_NAME/);
  });
});

/** #179: whose this instance's events are, `people.local`, its email per instance as `agent.git`'s is. */
describe("people.local", () => {
  const TOKEN = "GITHUB_TOKEN=ghp_xxxxxxxxxxxx\n";

  it("is optional: a config without it loads with no problem", async () => {
    const dir = await fixture(TOKEN);
    const loaded = await loadConfig(dir);
    expect(loaded.config.people).toBeUndefined();
    expect(loaded.missingPerson).toEqual([]);
    expect(configProblems(dir, loaded)).toEqual([]);
  });

  it.each([
    ["$VAR", "people: { local: { email: $LR_EMAIL, name: $LR_NAME } }\n"],
    ["${VAR}", 'people: { local: { email: "${LR_EMAIL}", name: "${LR_NAME}" } }\n'],
  ])("resolves a %s reference from .env into config.people.local", async (_, people) => {
    const dir = await fixture(`${TOKEN}LR_EMAIL=dev1@example.invalid\nLR_NAME=Dev One\n`, people);
    const loaded = await loadConfig(dir);
    expect(loaded.config.people?.local).toEqual({ email: "dev1@example.invalid", name: "Dev One" });
    expect(configProblems(dir, loaded)).toEqual([]);
  });

  it("keeps a literal as written", async () => {
    const dir = await fixture(TOKEN, "people: { local: { email: dev1@example.invalid } }\n");
    expect((await loadConfig(dir)).config.people?.local).toEqual({ email: "dev1@example.invalid" });
  });

  it.each([
    ["unset", TOKEN],
    ["empty", `${TOKEN}LR_EMAIL=\n`],
  ])("refuses an email variable that is %s, as people.local.email, for validate and start", async (_, env) => {
    const dir = await fixture(env, "people: { local: { email: $LR_EMAIL } }\n");
    const loaded = await loadConfig(dir);
    expect(configProblems(dir, loaded)).toEqual([{
      rule: "people.local.email",
      message: expect.stringMatching(/^people\.local\.email is \$LR_EMAIL, which does not resolve to a usable value; set it in .*\.env/),
    }]);
    expect(() => assertConfigUsable(dir, loaded)).toThrow(/people\.local\.email: people\.local\.email is \$LR_EMAIL/);
  });

  it("refuses an unset name variable as people.local.name", async () => {
    const dir = await fixture(TOKEN, "people: { local: { name: $LR_NAME } }\n");
    expect(configProblems(dir, await loadConfig(dir)).map((p) => p.rule)).toEqual(["people.local.name"]);
  });

  it("refuses a key it does not read", async () => {
    await expect(loadConfig(await fixture(TOKEN, "people: { local: { mail: a@b.c } }\n"))).rejects.toThrow(/people\.local/);
  });
});

/** #187: a remote instance's sign-in, `people.oidc`, and the identities an admin pins, `people.overrides`. */
describe("people.oidc", () => {
  const TOKEN = "GITHUB_TOKEN=ghp_xxxxxxxxxxxx\n";
  const OIDC = "people: { oidc: { issuer: https://id.example.invalid/realms/team, clientId: landrace, clientSecret: $LR_OIDC_SECRET } }\n";

  it("resolves its client secret from .env, and needs no people.local", async () => {
    const dir = await fixture(`${TOKEN}LR_OIDC_SECRET=s3cret-value-long\n`, OIDC);
    const loaded = await loadConfig(dir);
    expect(loaded.config.people?.oidc).toEqual({ issuer: "https://id.example.invalid/realms/team", clientId: "landrace", clientSecret: "s3cret-value-long" });
    expect(loaded.config.people?.local).toBeUndefined();
    expect(configProblems(dir, loaded)).toEqual([]);
  });

  it("refuses a client secret variable that is unset, as people.oidc.clientSecret", async () => {
    const dir = await fixture(TOKEN, OIDC);
    expect(configProblems(dir, await loadConfig(dir))).toEqual([{
      rule: "people.oidc.clientSecret",
      message: expect.stringMatching(/^people\.oidc\.clientSecret is \$LR_OIDC_SECRET, which does not resolve to a usable value; set it in .*\.env/),
    }]);
  });

  it.each([
    ["http off loopback", "http://id.example.invalid/realms/team", /people\.oidc\.issuer/],
    ["not a URL", "id.example.invalid", /people\.oidc\.issuer/],
  ])("refuses an issuer that is %s", async (_, issuer, error) => {
    const dir = await fixture(TOKEN, `people: { oidc: { issuer: "${issuer}", clientId: landrace, clientSecret: x } }\n`);
    await expect(loadConfig(dir)).rejects.toThrow(error);
  });

  it.each(["http://127.0.0.1:8080/realms/team", "http://localhost:8080/realms/team", "http://[::1]:8080/realms/team"])(
    "takes an http issuer on loopback, %s, as a local test IdP is",
    async (issuer) => {
      const dir = await fixture(TOKEN, `people: { oidc: { issuer: "${issuer}", clientId: landrace, clientSecret: x } }\n`);
      expect((await loadConfig(dir)).config.people?.oidc?.issuer).toBe(issuer);
    },
  );

  it("takes overrides: an email's identity fields, by connection", async () => {
    const dir = await fixture(TOKEN, "people: { overrides: { bob@example.invalid: { github: { login: bob-gh } } } }\n");
    expect((await loadConfig(dir)).config.people?.overrides).toEqual({ "bob@example.invalid": { github: { login: "bob-gh" } } });
  });
});

describe("the item branch", () => {
  it("is landrace/{item} when none is set, and takes the one set", async () => {
    expect((await loadConfig(await fixture(""))).config.branch).toBe("landrace/{item}");
    expect((await loadConfig(await fixture("", 'branch: "lr-{item}"\n'))).config.branch).toBe("lr-{item}");
  });

  it("is a configuration problem, validate's and start's, when it is no template, saying why", async () => {
    const dir = await fixture("GITHUB_TOKEN=ghp_xxxxxxxxxxxx", 'branch: "{item}"\n');
    const loaded = await loadConfig(dir);
    expect(configProblems(dir, loaded)).toEqual([
      { rule: "branch", message: expect.stringMatching(/"\{item\}".*fixed text before \{item\}/) },
    ]);
    expect(() => assertConfigUsable(dir, loaded)).toThrow(/branch: .*fixed text/);
  });

  it("has no variants when none is set, and takes the ones set", async () => {
    expect((await loadConfig(await fixture(""))).config.branchVariants).toEqual([]);
    expect((await loadConfig(await fixture("", "branchVariants: [retro]\n"))).config.branchVariants).toEqual(["retro"]);
  });

  it.each([
    ["[Retro]", /"Retro"/],
    ["[a/b]", /"a\/b"/],
    ["[retro, retro]", /"retro" is named twice/],
  ])("is a configuration problem under branch when branchVariants is %s", async (list, why) => {
    const dir = await fixture("GITHUB_TOKEN=ghp_xxxxxxxxxxxx", `branchVariants: ${list}\n`);
    expect(configProblems(dir, await loadConfig(dir))).toEqual([{ rule: "branch", message: expect.stringMatching(why) }]);
  });
});
