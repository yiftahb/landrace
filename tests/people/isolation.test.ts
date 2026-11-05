import { CREDENTIALS_ROOT } from "#conventions.js";
import { denyForPerson, scopeOf } from "#people/isolation.js";

const where = { worktrees: "/tmp/landrace/repo-1/worktrees", credentials: CREDENTIALS_ROOT };

describe("scopeOf", () => {
  it("is a person's id, encoded, so no separator survives", () => {
    expect(scopeOf({ id: "a/b@c.d" })).toBe("a%2Fb%40c.d");
  });
});

describe("denyForPerson", () => {
  it("is the credentials root and each other person's folder", () => {
    expect(denyForPerson({ id: "alice" }, [{ id: "bob" }, { id: "carol@x.io" }], where)).toEqual([
      CREDENTIALS_ROOT, "/tmp/landrace/repo-1/worktrees/bob", "/tmp/landrace/repo-1/worktrees/carol%40x.io",
    ]);
  });

  it("never lists the person's own folder, and lists each other's once", () => {
    expect(denyForPerson({ id: "alice" }, [{ id: "alice" }, { id: "bob" }, { id: "bob" }], where)).toEqual([
      CREDENTIALS_ROOT, "/tmp/landrace/repo-1/worktrees/bob",
    ]);
  });

  it("is only the credentials root for a person alone", () => {
    expect(denyForPerson({ id: "local" }, [], where)).toEqual([CREDENTIALS_ROOT]);
  });
});
