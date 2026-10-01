/*
 * GitLab merge requests as a project's forge: the REST calls, the mapping of
 * merge requests, discussions and diffs into the kit's plain shapes, and the
 * push URL it trusts with a token. Everything else a forge does is
 * `BaseForge`'s.
 */
import type { RuntimeContext } from "landrace/hooks";
import { BaseForge, type BranchHeads, type ChangedFile, type Git, type PullRecord, type ReviewThread } from "landrace/kit";
import { type Client, clientFor, statusOf, tokenRejected } from "./client.js";

/** Developer: what opening a merge request, commenting and resolving need. */
const DEVELOPER = 30;
const LEVELS: Record<number, string> = { 5: "Minimal access", 10: "Guest", 15: "Planner", 20: "Reporter", 30: "Developer", 40: "Maintainer", 50: "Owner" };

export interface GitLabOptions {
  /** The project's full path: "group/app". */
  project: string;
  /** git in the operator's checkout; the repository of the file that constructs this when absent. */
  git?: Git | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export class GitLab extends BaseForge {
  private readonly project: string;
  private readonly git: Git;
  private readonly fetchImpl: typeof fetch | undefined;

  constructor({ project, git, fetchImpl }: GitLabOptions) {
    super();
    this.project = project;
    this.fetchImpl = fetchImpl;
    this.git = git ?? (async () => "");
  }

  private gl(ctx: RuntimeContext): Client {
    return clientFor(ctx, this.project, this.fetchImpl);
  }

  async login(ctx: RuntimeContext): Promise<string> {
    return this.gl(ctx).login();
  }

  async pulls(): Promise<PullRecord[]> {
    throw new Error("not yet");
  }

  async pullsNaming(): Promise<PullRecord[]> {
    throw new Error("not yet");
  }

  async threads(): Promise<ReviewThread[]> {
    throw new Error("not yet");
  }

  async changedFiles(): Promise<ChangedFile[]> {
    throw new Error("not yet");
  }

  async reviews(): Promise<string[]> {
    throw new Error("not yet");
  }

  async openPull(): Promise<void> {
    throw new Error("not yet");
  }

  async closePull(): Promise<void> {
    throw new Error("not yet");
  }

  async postReview(): Promise<void> {
    throw new Error("not yet");
  }

  async reply(): Promise<void> {
    throw new Error("not yet");
  }

  async resolve(): Promise<void> {
    throw new Error("not yet");
  }

  async heads(): Promise<BranchHeads> {
    throw new Error("not yet");
  }

  async push(): Promise<void> {
    throw new Error("not yet");
  }

  /**
   * The `api` scope, then the project: one the token cannot see is a 404,
   * and below Developer it can read merge requests but open none. Each
   * refusal names which of the two is missing. Writes nothing.
   */
  async check(ctx: RuntimeContext): Promise<void> {
    const gl = this.gl(ctx);
    const failed = (what: string, e: unknown): Error =>
      tokenRejected(e) ?? new Error(`${what} failed: ${e instanceof Error ? e.message : String(e)}`);

    let scopes: string[];
    try {
      scopes = await gl.scopes();
    } catch (e) {
      throw failed("the token's scope check", e);
    }
    if (!scopes.includes("api")) {
      throw new Error(`token needs the "api" scope; it has ${scopes.length === 0 ? "none" : scopes.join(", ")}`);
    }

    let info: { permissions?: { project_access?: { access_level?: unknown } | null; group_access?: { access_level?: unknown } | null } | null };
    try {
      info = await gl.get("");
    } catch (e) {
      if (statusOf(e) === 404) {
        throw new Error(`token cannot see the project ${this.project}; give its user Developer access to it`);
      }
      throw failed(`the project check on ${this.project}`, e);
    }
    // The higher of the two, as GitLab grants it. Neither named — an
    // administrator's, say — is no level to judge, and is let through.
    const levels = [info.permissions?.project_access?.access_level, info.permissions?.group_access?.access_level]
      .filter((l): l is number => typeof l === "number");
    const level = Math.max(...levels);
    if (levels.length > 0 && level < DEVELOPER) {
      throw new Error(`token needs Developer access on ${this.project}; it has ${LEVELS[level] ?? `level ${level}`}`);
    }
  }
}
