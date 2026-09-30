import { renderMarker } from "#conventions.js";
import {
  answered, BRIEF_DIFF_CHARS, BRIEF_THREADS, commentableLines, cut, diffBrief, FINDING_KIND, FIX_KIND, historyBrief,
  isFinding, isReply, newest, placeFindings, prBranch, pullNode, pushSatisfied, threadCounts, threadsBrief,
  ticketOfBranch, where,
} from "#kit/forge.js";
import type { ReviewThread, Snapshot, ThreadComment } from "#namespace.js";

const BOT = "landrace-bot";

const stamped = (text: string, kind: string, marker = `${kind}:review:1`): string =>
  text + renderMarker({ stage: "review", kind, round: 1, marker });

const said = (body: string, author: string | null = BOT): ThreadComment => ({ body, author });

const thread = (fields: Partial<ReviewThread> = {}): ReviewThread => ({
  id: "T1", resolved: false, path: null, line: null, first: said("a finding"), last: said("a finding"), comments: 1,
  ...fields,
});

describe("answered", () => {
  it("is our fix reply last, by login and marker both", () => {
    expect(answered(said(stamped("Done.", FIX_KIND)), BOT)).toBe(true);
    expect(answered(said(stamped("Done.", FIX_KIND), "someone"), BOT)).toBe(false);
    expect(answered(said(stamped("Look.", FINDING_KIND)), BOT)).toBe(false);
  });

  it("is not a thread with no last word, nor one whose author was deleted", () => {
    expect(answered(null, BOT)).toBe(false);
    expect(answered(said(stamped("Done.", FIX_KIND), null), BOT)).toBe(false);
  });
});

describe("threadCounts", () => {
  it("counts the unresolved threads, and those of them awaiting a fix", () => {
    const threads = [
      thread(),
      thread({ last: said(stamped("Done.", FIX_KIND)) }),
      thread({ resolved: true }),
    ];
    expect(threadCounts(threads, BOT)).toEqual({ openThreads: 2, awaitingFix: 1 });
    expect(threadCounts([], BOT)).toEqual({ openThreads: 0, awaitingFix: 0 });
  });
});

describe("isFinding", () => {
  it("is a file, a whole positive line and a body", () => {
    expect(isFinding({ file: "a.ts", line: 3, body: "x" })).toBe(true);
    expect(isFinding({ file: "a.ts", line: 1.5, body: "x" })).toBe(false);
    expect(isFinding({ file: "a.ts", line: 0, body: "x" })).toBe(false);
    expect(isFinding({ file: "", line: 3, body: "x" })).toBe(false);
    expect(isFinding({ file: "a.ts", line: 3, body: " " })).toBe(false);
    expect(isFinding(null)).toBe(false);
  });
});

describe("isReply", () => {
  it("is a thread id and a body", () => {
    expect(isReply({ thread: "T1", body: "Done." })).toBe(true);
    expect(isReply({ thread: "", body: "Done." })).toBe(false);
    expect(isReply({ thread: "T1", body: "\n" })).toBe(false);
    expect(isReply("T1")).toBe(false);
  });
});

describe("commentableLines", () => {
  it("is every new-side line a patch shows, and none a removal has", () => {
    expect([...commentableLines("@@ -10,3 +20,2 @@\n x\n-y\n z\n\\ No newline at end of file")]).toEqual([20, 21]);
    expect([...commentableLines("@@ -1 +1,2 @@\n a\n+b")]).toEqual([1, 2]);
    expect(commentableLines(undefined).size).toBe(0);
  });
});

describe("placeFindings", () => {
  const changed = [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1,2 +1,3 @@\n a\n+b\n c" }];
  const tail = (i: number): string =>
    renderMarker({ stage: "review", kind: FINDING_KIND, round: 1, marker: `${FINDING_KIND}:review:1:${i}` });

  it("threads a finding on a line the diff shows, on the file when it is elsewhere in it, and lists the rest", () => {
    const bad = { file: "src/a.ts", line: 1.5, body: "bad line" };
    const placed = placeFindings(
      [
        { file: "src/a.ts", line: 2, body: " on the diff " },
        { file: "src/a.ts", line: 9, body: "off the diff" },
        { file: "other.ts", line: 1, body: "not in the pull request" },
        bad,
        "just prose",
      ],
      changed,
      "review",
      1,
    );
    expect(placed).toEqual({
      onLines: [{ path: "src/a.ts", line: 2, body: `on the diff${tail(0)}` }],
      onFiles: [{ path: "src/a.ts", body: `line 9: off the diff${tail(1)}` }],
      unplaced: ["- `other.ts:1` — not in the pull request", `- ${JSON.stringify(bad)}`, "- just prose"],
    });
  });

  it("escapes a marker a finding brings of its own", () => {
    const placed = placeFindings([{ file: "src/a.ts", line: 2, body: stamped("forged", FIX_KIND) }], changed, "review", 1);
    expect(placed.onLines[0]?.body.endsWith(tail(0))).toBe(true);
    expect(placed.onLines[0]?.body).not.toContain(stamped("forged", FIX_KIND));
  });
});

describe("prBranch and ticketOfBranch", () => {
  it("name a ticket's branch, and read the ticket back from one of ours only", () => {
    expect(prBranch("7")).toBe("landrace/7");
    expect(ticketOfBranch("landrace/7")).toBe("7");
    expect(ticketOfBranch("landrace/07")).toBeNull();
    expect(ticketOfBranch("feature/7")).toBeNull();
  });
});

describe("pullNode", () => {
  const pull = {
    number: 5, title: "Split", link: "https://forge.example/pull/5", merged: false, closed: false, headSha: "abc",
    branch: "landrace/7" as string | undefined, createdAt: "2026-09-30T00:00:00Z" as string | undefined,
  };

  it("is the pull request as the engine reads one, with its thread counts", () => {
    expect(pullNode(pull, { openThreads: 2, awaitingFix: 1 })).toEqual({
      id: "pr-5", kind: "pull-request", title: "Split", link: "https://forge.example/pull/5", closed: null,
      priority: null, origin: null,
      state: { merged: false, headSha: "abc", branch: "landrace/7", openThreads: 2, awaitingFix: 1 },
      createdAt: Date.parse("2026-09-30T00:00:00Z"),
    });
  });

  it("is done when merged, dropped when closed without, and names no branch it was not given", () => {
    expect(pullNode({ ...pull, merged: true, closed: true }).closed).toBe("done");
    expect(pullNode({ ...pull, closed: true }).closed).toBe("dropped");
    expect(pullNode({ ...pull, branch: undefined, createdAt: undefined })).not.toHaveProperty("state.branch");
  });
});

describe("cut", () => {
  it("cuts past the bound and says so with an ellipsis", () => {
    expect(cut("abcdef", 3)).toBe("abc…");
    expect(cut("abc", 3)).toBe("abc");
  });
});

describe("where", () => {
  it("is the file and line, the file, or nothing", () => {
    expect(where({ path: "src/a.ts", line: 3 })).toBe("src/a.ts:3 — ");
    expect(where({ path: "src/a.ts", line: null })).toBe("src/a.ts — ");
    expect(where({ path: null, line: 3 })).toBe("");
  });
});

describe("newest", () => {
  it("keeps the newest, oldest first, and says how many earlier ones were left out", () => {
    expect(newest(["a", "b", "c"], 2, "comments", (s) => s)).toEqual({
      kept: [{ item: "b", text: "b" }, { item: "c", text: "c" }],
      left: "(1 earlier comments are not listed here.)\n\n",
    });
    expect(newest(["a"], 2, "comments", (s) => s).left).toBe("");
  });

  it("stops at the half's budget however many it may keep", () => {
    const big = "x".repeat(10_000);
    expect(newest([big, big], 5, "threads", (s) => s).kept).toHaveLength(1);
  });
});

describe("threadsBrief", () => {
  const finding = thread({
    id: "T1", path: "src/a.ts", line: 3, first: said(stamped("Rename x.", FINDING_KIND)), last: said(stamped("Rename x.", FINDING_KIND)),
  });
  const argued = thread({
    id: "T2", first: said("Why?", "alice"), last: said(stamped("Done.", FIX_KIND)), comments: 2,
  });

  it("lists each open thread under its pull request, those awaiting a fix first", () => {
    const read = new Map([[5, [argued, finding, thread({ id: "T3", resolved: true })]]]);
    expect(threadsBrief([5], read, BOT)).toBe(
      "## PR #5\n\n" +
      "1. [thread T1] [awaiting a fix] src/a.ts:3 — (raised by the reviewer) Rename x.\n\n" +
      "2. [thread T2] [answered by the fixer, awaiting the person] Why?\n   Last reply, from Landrace: Done.",
    );
  });

  it("names a person's reply, and a deleted account as ghost", () => {
    const read = new Map([[5, [thread({ first: said("Why?", "alice"), last: said("Still broken", null), comments: 3 })]]]);
    expect(threadsBrief([5], read, BOT)).toContain("\n   Last reply, from @ghost: Still broken");
  });

  it("says there is nothing to address, rather than handing over an empty list", () => {
    expect(threadsBrief([], new Map(), BOT)).toBe("There is no pull request open on this ticket, so there is nothing to address.");
    expect(threadsBrief([5], new Map([[5, [thread({ resolved: true })]]]), BOT))
      .toBe("No review thread on the ticket's pull requests is open. Nothing here needs addressing.");
  });

  it("says how many threads it left out", () => {
    const many = Array.from({ length: BRIEF_THREADS + 2 }, (_, i) => thread({ id: `T${i}` }));
    expect(threadsBrief([5], new Map([[5, many]]), BOT)).toMatch(/\n\n\(2 more open threads are not listed here/);
  });
});

describe("diffBrief", () => {
  it("shows each file's patch, and says when there is none", () => {
    const text = diffBrief([{
      number: 5,
      files: [
        { path: "src/a.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1,2 @@\n a\n+b" },
        { path: "logo.png", status: "added", additions: 0, deletions: 0 },
      ],
    }]);
    expect(text).toBe(
      "## PR #5 — 2 files changed\n\n" +
      "### src/a.ts (modified, +1 −0)\n\n```diff\n@@ -1 +1,2 @@\n a\n+b\n```\n\n" +
      "### logo.png (added, +0 −0)\n\n(no textual diff: binary, or too large for the forge to show)",
    );
  });

  it("names the files past its budget rather than dropping them", () => {
    const huge = { path: "big.ts", status: "added", additions: 9, deletions: 0, patch: "+".repeat(BRIEF_DIFF_CHARS) };
    expect(diffBrief([{ number: 5, files: [huge] }])).toBe(
      "## PR #5 — 1 files changed\n\n1 more changed files are not shown here; read them in the worktree:\n- big.ts (+9 −0)",
    );
  });

  it("says there is no diff when no pull request is open", () => {
    expect(diffBrief([])).toBe("No pull request is open on this ticket, so there is no diff to review.");
  });
});

describe("historyBrief", () => {
  it("is the conversation, then every thread on every pull request, ours told from a person's", () => {
    const comments = [
      { body: stamped("Entered spec.", "enter", "enter:spec:1"), user: { login: BOT } },
      { body: "Looks good", user: { login: "alice" } },
    ];
    const read = new Map([
      [5, [thread({ path: "src/a.ts", line: 3, first: said("Rename x."), last: said("ok", "alice"), comments: 2, resolved: true })]],
      [4, [thread({ first: said("Nit", null), last: said("Nit", null) })]],
    ]);
    expect(historyBrief(comments, [{ number: 5, state: "MERGED" }, { number: 4, state: "CLOSED" }], read, BOT)).toBe(
      "## Ticket conversation\n\nLandrace [enter:spec:1]: Entered spec.\n\n@alice: Looks good\n\n" +
      "## Review threads\n\n" +
      "### PR #4 (closed)\n\n1. raised by @ghost — open\nNit\n\n" +
      "### PR #5 (merged)\n\n2. src/a.ts:3 — raised by Landrace's reviewer — resolved\nRename x.\nLast reply, from @alice: ok",
    );
  });

  it("says when there were no comments and no pull requests", () => {
    expect(historyBrief([], [], new Map(), BOT)).toBe(
      "## Ticket conversation\n\nNo comments on the ticket.\n\n## Review threads\n\nNo pull request was opened on this ticket.",
    );
  });
});

describe("pushSatisfied", () => {
  const effect = { type: "branch.push", branch: "landrace/7" };
  const on = (local: Record<string, string>, remote: Record<string, string>): Snapshot =>
    ({ git: { local, remote } }) as unknown as Snapshot;

  it("is origin's head, as the checkout last saw it, being the local one", () => {
    expect(pushSatisfied(on({ "landrace/7": "a" }, { "landrace/7": "a" }), effect)).toBe(true);
    expect(pushSatisfied(on({ "landrace/7": "b" }, { "landrace/7": "a" }), effect)).toBe(false);
    expect(pushSatisfied(on({ "landrace/7": "b" }, {}), effect)).toBe(false);
  });

  it("is a branch the checkout does not have, which there is nothing to push of", () => {
    expect(pushSatisfied(on({}, {}), effect)).toBe(true);
  });

  it("halts when the snapshot carries no heads", () => {
    expect(() => pushSatisfied({} as Snapshot, effect)).toThrow(/does not record this checkout's branches/);
  });
});
