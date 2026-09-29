import { createHash } from "node:crypto";
import { entriesFromComments, pairSessionId, recordMarker, renderMarker, shellLine } from "#conventions.js";
import type { Marker, TrackerComment } from "#namespace.js";
import { repoDigest, sandboxRoot } from "#sandbox.js";

const BOT = "landrace-bot";
const posted = (body: string): TrackerComment =>
  ({ id: 1, body, created_at: "2026-01-01T00:00:00.000Z", user: { login: BOT } });
const readBack = (m: Marker) => entriesFromComments([posted(`x${renderMarker(m)}`)], BOT)[0];

const sha1 = (data: Uint8Array): Uint8Array => new Uint8Array(createHash("sha1").update(data).digest());

describe("who produced a record", () => {
  it("rides on the marker and reads back as the entry's `by`", () => {
    const m = recordMarker({ type: "tracker.comment", kind: "output", stage: "spec", round: 1, output: { kind: "spec" }, by: "pair" });
    expect(readBack(m)).toMatchObject({ kind: "output", by: "pair" });
  });

  it("is absent on a record that never named one, so old records read as the agent's", () => {
    const m = recordMarker({ type: "tracker.comment", kind: "output", stage: "spec", round: 1, output: { kind: "spec" } });
    expect(m).not.toHaveProperty("by");
    expect(readBack(m)).not.toHaveProperty("by");
  });

  it.each(["", 7, "__proto__"])("reads back no `by` that is not a usable name (%j)", (bad) => {
    expect(readBack({ stage: "s", kind: "output", round: 1, by: bad } as unknown as Marker)).not.toHaveProperty("by");
  });
});

describe("a pairing's session id", () => {
  const name = { repo: "abc123", ticket: "29", stage: "spec", round: 1, n: 1 };

  it("is the same every time it is derived, so a retried start hands out the same session", () => {
    expect(pairSessionId(sha1, name)).toBe(pairSessionId(sha1, name));
  });

  it("is a version 5 UUID", () => {
    expect(pairSessionId(sha1, name)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("differs for a second pairing at the same round, and for another repository", () => {
    const first = pairSessionId(sha1, name);
    expect(pairSessionId(sha1, { ...name, n: 2 })).not.toBe(first);
    expect(pairSessionId(sha1, { ...name, repo: "def456" })).not.toBe(first);
  });
});

describe("a command line a person pastes into a shell", () => {
  it("leaves plain words bare and quotes the rest", () => {
    expect(shellLine(["claude", "--session-id", "0d1e-2f"])).toBe("claude --session-id 0d1e-2f");
    expect(shellLine(["say", "two words", ""])).toBe("say 'two words' ''");
  });

  it("survives a single quote and shell syntax inside an argument", () => {
    expect(shellLine(["echo", "it's $(rm -rf ~); `x`"])).toBe(`echo 'it'\\''s $(rm -rf ~); \`x\`'`);
  });

  it("has the shell read a file argument when the command runs, naming only its path", () => {
    expect(shellLine(["agent", { file: "/tmp/it's/seed" }, "--x"])).toBe(`agent "$(cat '/tmp/it'\\''s/seed')" --x`);
  });

  // Inside double quotes an interactive bash or zsh expands history on "!".
  it("refuses a file path with a \"!\", which the surrounding double quotes leave to history expansion", () => {
    expect(() => shellLine(["agent", { file: "/tmp/a!b/seed" }])).toThrow(/"!"/);
  });

  // Quoting stops the shell, not the terminal: ESC [201~ ends a bracketed
  // paste early, and a raw ^C or newline acts the moment it is pasted.
  it.each(["seed\u001b[201~; rm -rf ~", "seed\u0003", "one\ntwo", "\u009b201~"])(
    "refuses an argument carrying a control character (%j)",
    (bad) => {
      expect(() => shellLine(["agent", bad])).toThrow(/control character/);
      expect(() => shellLine(["agent", { file: `/tmp/${bad}` }])).toThrow(/control character/);
    },
  );
});

describe("the repository's digest", () => {
  it("is the one its sandbox root is named by", () => {
    expect(sandboxRoot(process.cwd()).endsWith(`-${repoDigest(process.cwd())}`)).toBe(true);
  });
});
