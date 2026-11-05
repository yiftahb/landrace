import type { IncomingMessage } from "node:http";
import { cookieOf, createSessions } from "#people/session.js";
import type { Person } from "#namespace.js";

/* #187: who is signed in, by the session cookie. */
const ALICE = { id: "sub-alice", email: "alice@example.com" };
const BOB = { id: "sub-bob", email: "bob@example.com" };
const everyone = (): boolean => true;
const req = (cookie?: string): IncomingMessage => ({ headers: cookie === undefined ? {} : { cookie } }) as IncomingMessage;
const valueOf = (setCookie: string): string => setCookie.split(";")[0] ?? "";

describe("sessions", () => {
  // #204: `__Host-` makes the browser refuse one set by a sibling subdomain, or with a Domain or a narrower Path.
  it("over https, issues __Host-landrace_session: Secure, HttpOnly, SameSite=Lax, Path=/, with no Domain", () => {
    const secure = createSessions({ secure: true, admits: everyone }).issue(ALICE);
    expect(secure).toMatch(/^__Host-landrace_session=[A-Za-z0-9_-]{43}; /);
    expect(secure.split("; ")).toEqual(expect.arrayContaining(["Path=/", "HttpOnly", "SameSite=Lax", "Secure"]));
    expect(secure).not.toMatch(/Domain=/i);
  });

  it("over loopback http, issues landrace_session, with no Secure a browser would refuse to keep", () => {
    const plain = createSessions({ secure: false, admits: everyone }).issue(ALICE);
    expect(plain).toMatch(/^landrace_session=/);
    expect(plain.split("; ")).not.toContain("Secure");
  });

  it("knows the person, and the session's id, by the cookie; anyone else is nobody", () => {
    const sessions = createSessions({ secure: true, admits: everyone });
    const cookie = valueOf(sessions.issue(ALICE));
    expect(sessions.personOf(req(`other=1; ${cookie}`))).toEqual(ALICE);
    expect(sessions.idOf(req(cookie))).toBe(cookie.split("=")[1]);
    expect(sessions.personOf(req())).toBeNull();
    expect(sessions.personOf(req("__Host-landrace_session=forged"))).toBeNull();
    expect(sessions.idOf(req("__Host-landrace_session=forged"))).toBeNull();
    // The plain name is not the secure door's cookie: a sibling subdomain can set that one.
    expect(sessions.personOf(req(`landrace_session=${cookie.split("=")[1] ?? ""}`))).toBeNull();
  });

  it("answers a request carrying two session cookies as nobody, never picking one", () => {
    const sessions = createSessions({ secure: false, admits: everyone });
    const alice = valueOf(sessions.issue(ALICE));
    const bob = valueOf(sessions.issue(BOB));
    for (const header of [`${alice}; ${bob}`, `${bob}; ${alice}`, `${alice}; ${alice}`]) {
      expect(sessions.personOf(req(header))).toBeNull();
      expect(sessions.idOf(req(header))).toBeNull();
    }
  });

  // #204: removing someone from people.allow ends the session they already hold.
  it("answers a session whose person people.allow no longer admits as nobody", () => {
    let allowed = true;
    const sessions = createSessions({ secure: true, admits: (p: Person) => allowed || p.id !== ALICE.id });
    const cookie = valueOf(sessions.issue(ALICE));
    expect(sessions.personOf(req(cookie))).toEqual(ALICE);
    allowed = false;
    expect(sessions.personOf(req(cookie))).toBeNull();
    expect(sessions.idOf(req(cookie))).toBeNull();
  });

  it("ends a session: its cookie is cleared and no longer anyone's", () => {
    const sessions = createSessions({ secure: true, admits: everyone });
    const cookie = valueOf(sessions.issue(ALICE));
    expect(sessions.end(req(cookie))).toMatch(/^__Host-landrace_session=; .*Max-Age=0/);
    expect(sessions.personOf(req(cookie))).toBeNull();
  });

  it("forgets a session past its lifetime", () => {
    let now = 0;
    const sessions = createSessions({ secure: true, admits: everyone, ttlMs: 1000, now: () => now });
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

  it("reads a name sent twice as no cookie at all, whichever value comes first", () => {
    expect(cookieOf(req("landrace_login=a; landrace_login=b"), "landrace_login")).toBeUndefined();
    expect(cookieOf(req("landrace_login=a; landrace_login=a"), "landrace_login")).toBeUndefined();
  });
});
