import { createHash } from "node:crypto";
import { briefPage, contentOf, hashOf, mine, NO_SPEC, PUBLISH, publishSatisfied, SPEC, specNode } from "#kit/docs.js";
import { signatureLine } from "#conventions.js";
import type { Effect, HookContext, Snapshot } from "#namespace.js";
import { MemoryDocs } from "#testing/index.js";

const publish = (body: unknown, artifact: unknown = SPEC): Effect => ({ type: PUBLISH, artifact, body });
const snapshotWith = (fields: Record<string, unknown>): Snapshot => fields as unknown as Snapshot;

describe("hashOf", () => {
  it("is the content's sha256, in hex", () => {
    expect(hashOf("spec")).toBe(createHash("sha256").update("spec").digest("hex"));
  });
});

describe("contentOf", () => {
  it("is the effect's body", () => {
    expect(contentOf(publish("# Spec"))).toBe("# Spec");
  });

  it("refuses a publish with nothing to publish", () => {
    expect(() => contentOf(publish("  \n"))).toThrow(`a "${PUBLISH}" effect for "${SPEC}" carried no content to publish`);
    expect(() => contentOf(publish(undefined))).toThrow(/carried no content/);
  });
});

describe("mine", () => {
  it("refuses a publish addressed to an artifact the hook does not own", () => {
    expect(() => mine(publish("x"))).not.toThrow();
    expect(() => mine(publish("x", "plan"))).toThrow(`this hook publishes the "${SPEC}" artifact, not "plan"`);
  });
});

describe("briefPage", () => {
  it("is the page's text, or says there is none", () => {
    expect(briefPage("# Spec")).toEqual({ content: "# Spec" });
    expect(briefPage(null)).toEqual({ content: NO_SPEC });
  });
});

describe("publishSatisfied", () => {
  it("is the page already holding exactly this content", () => {
    const on = (hash: string | null): Snapshot => snapshotWith({ artifacts: { [SPEC]: { exists: hash !== null, hash } } });
    expect(publishSatisfied(on(hashOf("# Spec")), publish("# Spec"))).toBe(true);
    expect(publishSatisfied(on(hashOf("# Old")), publish("# Spec"))).toBe(false);
    expect(publishSatisfied(on(null), publish("# Spec"))).toBe(false);
  });

  it("halts when the snapshot has no state for the page, rather than guessing either way", () => {
    expect(() => publishSatisfied(snapshotWith({}), publish("# Spec")))
      .toThrow(`the snapshot has no artifacts.${SPEC} state, so no publish of it can be checked`);
  });
});

describe("specNode", () => {
  it("is the page as a document beside its item", () => {
    expect(specNode("7", "https://pages.example/specs/7/")).toEqual({
      id: "spec-7", kind: "document", title: "Spec", link: "https://pages.example/specs/7/",
      closed: null, priority: null, origin: null, state: {},
    });
  });
});

/*
 * A signed spec is published with its line, and the page read back holds it:
 * the hash is taken over what is published, line included, so the same
 * answer again is a no-op and a person's edit is still a page that differs.
 */
describe("a spec the agent signed", () => {
  const signed = `# Spec\n\nThe design.\n\n${signatureLine("claude-opus-5-5", "medium")}`;
  const ctx = { item: "7", snapshot: {}, config: {}, secrets: new Map(), signal: new AbortController().signal, log: () => {} } as unknown as HookContext;
  const at = async (docs: MemoryDocs): Promise<Snapshot> => snapshotWith({ artifacts: { [SPEC]: await docs.observe(ctx) } });

  it("is satisfied once published, and republishing the same answer writes nothing", async () => {
    const docs = new MemoryDocs();
    const handler = docs.effects()[PUBLISH];
    if (!handler) throw new Error("no publish handler");
    expect(handler.satisfied(await at(docs), publish(signed))).toBe(false);
    await handler.apply(publish(signed), ctx);
    expect(docs.pages.get("7")).toBe(signed);
    expect(handler.satisfied(await at(docs), publish(signed))).toBe(true);
    const publishing = jest.spyOn(docs, "publish");
    await handler.apply(publish(signed), ctx);
    expect(publishing).not.toHaveBeenCalled();
  });

  it("still sees a person's edit, whether or not it kept the line", async () => {
    const docs = new MemoryDocs();
    docs.pages.set("7", signed.replace("The design.", "A person's design."));
    expect(publishSatisfied(await at(docs), publish(signed))).toBe(false);
    docs.pages.set("7", "# Spec\n\nThe design.");
    expect(publishSatisfied(await at(docs), publish(signed))).toBe(false);
  });
});
