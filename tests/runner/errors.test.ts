import { messageOf } from "../../src/runner/errors.js";

describe("messageOf", () => {
  it("returns an Error's own message", () => {
    expect(messageOf(new Error("no quota"))) .toBe("no quota");
  });

  // N1: `(e as Error).message` on a non-Error rejection does not evaluate to
  // undefined, it throws — from inside the catch block meant to describe the
  // failure. This is the exact case that must not crash: an outage is
  // precisely when a library is likely to reject with something odd.
  it("does not throw on null, and says so", () => {
    expect(() => messageOf(null)).not.toThrow();
    expect(messageOf(null)).toBe("null");
  });

  it("does not throw on a bare string rejection", () => {
    expect(messageOf("socket hang up")).toBe("socket hang up");
  });

  it("does not throw on a plain object with no message", () => {
    expect(() => messageOf({ code: "ECONNRESET" })).not.toThrow();
  });

  it("does not throw on undefined", () => {
    expect(messageOf(undefined)).toBe("undefined");
  });

  // Round 3: `messageOf` was only as safe as `instanceof Error ? e.message :
  // String(e)`, and neither branch is actually safe. Proven live: converge
  // threw instead of returning from step.ts's and screen.ts's raw
  // `executor.run` catches, on exactly these shapes.
  describe("never throws, no matter how the rejection is shaped", () => {
    it("an Error subclass with a throwing message getter", () => {
      class Weird extends Error {
        override get message(): string { throw new Error("nested boom"); }
      }
      const e = Object.create(Weird.prototype) as Error;
      expect(() => messageOf(e)).not.toThrow();
      expect(typeof messageOf(e)).toBe("string");
    });

    it("Object.create(Error.prototype) with a throwing message getter", () => {
      const e: unknown = Object.create(Error.prototype, {
        message: { get() { throw new Error("nested boom"); } },
      });
      expect(() => messageOf(e)).not.toThrow();
      expect(typeof messageOf(e)).toBe("string");
    });

    it("a null-prototype object", () => {
      const e = Object.assign(Object.create(null) as object, { code: "ECONNRESET" });
      expect(() => messageOf(e)).not.toThrow();
      expect(typeof messageOf(e)).toBe("string");
    });

    it("a throwing toString", () => {
      const e = { toString() { throw new Error("nested boom"); } };
      expect(() => messageOf(e)).not.toThrow();
      expect(typeof messageOf(e)).toBe("string");
    });

    it("a throwing Symbol.toPrimitive", () => {
      const e = { [Symbol.toPrimitive]() { throw new Error("nested boom"); } };
      expect(() => messageOf(e)).not.toThrow();
      expect(typeof messageOf(e)).toBe("string");
    });

    it("a Proxy trapping get", () => {
      const e = new Proxy(
        {},
        { get() { throw new Error("nested boom"); } },
      );
      expect(() => messageOf(e)).not.toThrow();
      expect(typeof messageOf(e)).toBe("string");
    });
  });

  // Signature lie: messageOf's declared return type is `string`, but
  // `e.message` for an Error-shaped object is not guaranteed to actually be
  // one — returning it verbatim silently violated the function's own type.
  it("never returns undefined, even for an Error whose own message is explicitly undefined", () => {
    const e = new Error("will be overwritten");
    Object.defineProperty(e, "message", { value: undefined, enumerable: true });
    const m = messageOf(e);
    expect(m).not.toBeUndefined();
    expect(typeof m).toBe("string");
  });

  // Minor: an AggregateError constructed without its own message string
  // (the common case — `new AggregateError([inner])`) has message "", which
  // is technically "a string" but useless; the real information is in the
  // wrapped errors.
  it("prefers the first inner error's message when an AggregateError's own message is empty", () => {
    const inner = new Error("the real reason");
    const agg = new AggregateError([inner]);
    expect(messageOf(agg)).toBe("the real reason");
  });

  it("still returns an AggregateError's own message when it has one", () => {
    const agg = new AggregateError([new Error("inner")], "the outer reason");
    expect(messageOf(agg)).toBe("the outer reason");
  });
});
