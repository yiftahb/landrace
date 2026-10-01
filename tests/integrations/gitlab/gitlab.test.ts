import { createClient, GitLab } from "landrace/integrations/gitlab";
import type { Git } from "#namespace.js";
import { BASE, createFakeGitLab, type FakeGitLab, PROJECT, TOKEN } from "#tests/integrations/gitlab/fake-gitlab.js";

/** A checkout with no branches at all: enough for every test that never pushes. */
const noGit: Git = async () => "";

const forgeOver = (gl: FakeGitLab, project = PROJECT): GitLab => new GitLab({ project, fetchImpl: gl.fetchImpl, git: noGit });

describe("check", () => {
  it("passes a token with the api scope and Developer access on the project", async () => {
    const gl = createFakeGitLab();
    await expect(forgeOver(gl).check(gl.ctx())).resolves.toBeUndefined();
  });

  it("names the missing gitlabToken secret", async () => {
    const gl = createFakeGitLab();
    await expect(forgeOver(gl).check(gl.ctx({}))).rejects.toThrow(/"gitlabToken" secret/);
  });

  it("says the token was rejected, not that it lacks a scope, on a 401", async () => {
    const gl = createFakeGitLab();
    await expect(forgeOver(gl).check(gl.ctx({ gitlabToken: "wrong", gitlabBaseUrl: BASE }))).rejects.toThrow(/rejected by GitLab \(401\)/);
  });

  it("names the api scope, and what the token holds instead", async () => {
    const gl = createFakeGitLab();
    gl.settings.scopes = ["read_api", "read_repository"];
    await expect(forgeOver(gl).check(gl.ctx())).rejects.toThrow(/needs the "api" scope; it has read_api, read_repository/);
  });

  it("names the project a token cannot see", async () => {
    const gl = createFakeGitLab();
    gl.settings.visible = false;
    await expect(forgeOver(gl).check(gl.ctx())).rejects.toThrow(/cannot see the project group\/app/);
  });

  it("names Developer access when the token's is lower", async () => {
    const gl = createFakeGitLab();
    gl.settings.access = 20;
    await expect(forgeOver(gl).check(gl.ctx())).rejects.toThrow(/needs Developer access on group\/app/);
  });
});

describe("the client", () => {
  it.each([
    "http://gitlab.example.com",
    "https://gitlab.example.com/api",
    "https://user:pass@gitlab.example.com",
    "https://gitlab.example.com?x=1",
    "gitlab.example.com",
  ])("refuses gitlabBaseUrl %s before any request", (baseUrl) => {
    expect(() => createClient({ project: PROJECT, token: TOKEN, baseUrl })).toThrow(/https:\/\/host\[:port\]/);
  });

  it("takes a port, and a trailing slash", () => {
    expect(createClient({ project: PROJECT, token: TOKEN, baseUrl: "https://gitlab.example.com:8443/" }).baseUrl)
      .toBe("https://gitlab.example.com:8443");
  });

  it.each(["app", "group/../app", "group/app?x", ".hidden/app", "group//app"])("refuses project %s", (project) => {
    expect(() => createClient({ project, token: TOKEN })).toThrow(/project must be/);
  });

  it("defaults to gitlab.com", () => {
    expect(createClient({ project: PROJECT, token: TOKEN }).baseUrl).toBe("https://gitlab.com");
  });

  it("never puts the token in a failure's message", async () => {
    const gl = createFakeGitLab();
    gl.settings.visible = false;
    const client = createClient({ project: PROJECT, token: TOKEN, baseUrl: BASE, fetchImpl: gl.fetchImpl });
    const failure = await client.get("").then(() => "", (e: unknown) => String(e));
    expect(failure).toMatch(/404/);
    expect(failure).not.toContain(TOKEN);
  });
});
