import { allowedHosts, frontDoorOrigins, isLoopback, serveProblems } from "#front/hosts.js";

describe("isLoopback", () => {
  it.each(["127.0.0.1", "127.0.0.2", "localhost", "LOCALHOST", "::1", "[::1]"])("%s is loopback", (host) => {
    expect(isLoopback(host)).toBe(true);
  });
  it.each(["0.0.0.0", "10.0.0.5", "::", "192.168.1.2", "example.com", "127.0.0.1.example.com", "localhost.example.com"])("%s is not", (host) => {
    expect(isLoopback(host)).toBe(false);
  });
});

describe("serveProblems", () => {
  it.each(["0.0.0.0", "10.0.0.5", "::"])("refuses an unauthenticated bind on %s", (host) => {
    const problems = serveProblems({ host });
    expect(problems).toHaveLength(1);
    expect(problems[0]?.rule).toBe("serve.unauthenticated");
    expect(problems[0]?.message).toContain(`"${host}"`);
  });
  it.each(["127.0.0.1", "127.0.0.2", "localhost", "::1"])("passes %s", (host) => {
    expect(serveProblems({ host })).toEqual([]);
  });
});

describe("allowedHosts", () => {
  it("answers both loopback names on the bound port, and nothing on another", () => {
    const hosts = allowedHosts({ host: "127.0.0.1" }, 4600);
    expect(hosts).toEqual(expect.arrayContaining(["127.0.0.1:4600", "localhost:4600"]));
    expect(hosts).not.toContain("127.0.0.1:4545");
  });
  it("brackets an IPv6 bind", () => {
    expect(allowedHosts({ host: "::1" }, 4545)).toContain("[::1]:4545");
  });
  it("answers the public URL's own host", () => {
    expect(allowedHosts({ host: "127.0.0.1", publicUrl: "https://board.example.org/" }, 4545)).toContain("board.example.org");
  });
});

describe("frontDoorOrigins", () => {
  it("names the loopback hosts and origins on the port, and the public URL's", () => {
    const door = frontDoorOrigins({ host: "127.0.0.1", publicUrl: "https://board.example.org:8443/x" }, 4545);
    expect(door.hosts).toEqual(expect.arrayContaining(["127.0.0.1", "localhost", "board.example.org"]));
    expect(door.origins).toEqual(expect.arrayContaining(["http://127.0.0.1:4545", "http://localhost:4545", "https://board.example.org:8443"]));
  });
  it("leaves an IPv6 host out of the host names a sandbox or a fetch rule could hold", () => {
    const door = frontDoorOrigins({ host: "::1" }, 4545);
    expect(door.hosts.some((h) => h.includes(":"))).toBe(false);
    expect(door.origins).toContain("http://[::1]:4545");
  });
});
