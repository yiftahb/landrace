import { canonicalize, hashSnapshot } from "../../src/core/normalize.js";

const digest = (s: string) => String(s.length);

describe("canonicalize", () => {
  it("is stable under key order", () => {
    expect(canonicalize({ b: 1, a: 2 } as never)).toBe(canonicalize({ a: 2, b: 1 } as never));
  });

  it("is stable under nested key order", () => {
    expect(canonicalize({ x: { b: 1, a: 2 } } as never)).toBe(canonicalize({ x: { a: 2, b: 1 } } as never));
  });

  it("preserves array order, which is meaningful", () => {
    expect(canonicalize({ a: [1, 2] } as never)).not.toBe(canonicalize({ a: [2, 1] } as never));
  });

  it("strips volatile fields that would change the hash every tick", () => {
    expect(canonicalize({ a: 1, now: 5 } as never)).toBe(canonicalize({ a: 1, now: 9 } as never));
  });

  it("keeps a nested `now` field — only the top-level now is volatile", () => {
    // A hook-defined field that happens to be named `now` somewhere inside
    // the snapshot (e.g. ticket.now) is ordinary data, not the tick clock,
    // and must still affect the hash like any other field.
    expect(canonicalize({ a: 1, ticket: { now: 5 } } as never))
      .not.toBe(canonicalize({ a: 1, ticket: { now: 9 } } as never));
  });

  it("hashes through the injected digest, since core cannot import crypto", () => {
    expect(hashSnapshot({ a: 1 } as never, digest)).toBe(digest(canonicalize({ a: 1 } as never)));
  });
});
