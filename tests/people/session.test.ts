import type { IncomingMessage } from "node:http";
import { cookieOf, createSessions } from "#people/session.js";

/* #187: who is signed in, by the `landrace_session` cookie. */
const ALICE = { id: "sub-alice", email: "alice@example.invalid" };
const req = (cookie?: string): IncomingMessage => ({ headers: cookie === undefined ? {} : { cookie } }) as IncomingMessage;
const valueOf = (setCookie: string): string => setCookie.split(";")[0] ?? "";

describe("sessions", () => {
  it("issues an HttpOnly, SameSite=Lax cookie, Secure only when the instance is reached over https", () => {
    const secure = createSessions({ secure: true }).issue(ALICE);
    expect(secure).toMatch(/^landrace_session=[A-Za-z0-9_-]{43}; /);
    expect(secure.split("; ")).toEqual(expect.arrayContaining(["Path=/", "HttpOnly", "SameSite=Lax", "Secure"]));
    expect(createSessions({ secure: false }).issue(ALICE).split("; ")).not.toContain("Secure");
  });

  it("knows the person, and the session's id, by the cookie; anyone else is nobody", () => {
    const sessions = createSessions({ secure: true });
    const cookie = valueOf(sessions.issue(ALICE));
    expect(sessions.personOf(req(`other=1; ${cookie}`))).toEqual(ALICE);
    expect(sessions.idOf(req(cookie))).toBe(cookie.split("=")[1]);
    expect(sessions.personOf(req())).toBeNull();
    expect(sessions.personOf(req("landrace_session=forged"))).toBeNull();
    expect(sessions.idOf(req("landrace_session=forged"))).toBeNull();
  });

  it("ends a session: its cookie is cleared and no longer anyone's", () => {
    const sessions = createSessions({ secure: true });
    const cookie = valueOf(sessions.issue(ALICE));
    expect(sessions.end(req(cookie))).toMatch(/^landrace_session=; .*Max-Age=0/);
    expect(sessions.personOf(req(cookie))).toBeNull();
  });

  it("forgets a session past its lifetime", () => {
    let now = 0;
    const sessions = createSessions({ secure: true, ttlMs: 1000, now: () => now });
    const cookie = valueOf(sessions.issue(ALICE));
    now = 1001;
    expect(sessions.personOf(req(cookie))).toBeNull();
  });
});

describe("cookieOf", () => {
  it("reads one cookie by name, decoded, and nothing from a name that only ends in it", () => {
    expect(cookieOf(req("a=1; landrace_login=x%2By; b=2"), "landrace_login")).toBe("x+y");
    expect(cookieOf(req("xlandrace_login=1"), "landrace_login")).toBeUndefined();
    expect(cookieOf(req(), "landrace_login")).toBeUndefined();
  });
});
