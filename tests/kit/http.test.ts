import { httpError, httpReason } from "#kit/http.js";
import { gatewayPage } from "#tests/support/http-pages.js";

describe("httpReason", () => {
  it("names an HTML page by its title, with no markup and none of its images", () => {
    const reason = httpReason(gatewayPage);
    expect(reason).toBe("Unicorn! · GitHub");
  });

  it("reads an HTML page with no title as its text, cut short, with no markup left", () => {
    const page = `<html><head><style>body { background: url(data:image/png;base64,iVBORw0KGgo) }</style>` +
      `<script>var a = "<b>";</script></head><body><!-- a <comment> --><h1>Bad gateway</h1>` +
      `<p>${"The upstream server did not answer. ".repeat(40)}</p><img src="data:image/png;base64,iVBORw0KGgo"></body></html>`;
    const reason = httpReason(page);
    expect(reason.startsWith("Bad gateway The upstream server did not answer.")).toBe(true);
    expect(reason).not.toMatch(/[<>]|base64|background|comment/);
    expect(reason.length).toBeLessThanOrEqual(201);
    expect(reason.endsWith("…")).toBe(true);
  });

  it("drops a tag the cut left open", () => {
    expect(httpReason(`<p>Service unavailable</p><div class="${"x".repeat(500)}`)).toBe("Service unavailable");
  });

  it("keeps a short plain-text body as it is, on one line", () => {
    expect(httpReason("upstream connect error\nor disconnect")).toBe("upstream connect error or disconnect");
  });

  it("cuts a long plain-text body with an ellipsis", () => {
    const reason = httpReason("x".repeat(5000));
    expect(reason).toBe(`${"x".repeat(200)}…`);
  });

  it("reads a JSON body's message", () => {
    expect(httpReason(JSON.stringify({ message: "Validation Failed", documentation_url: "https://example.test/docs" }))).toBe("Validation Failed");
  });

  it("adds the messages a JSON body lists under errors to its message", () => {
    const body = { message: "Validation Failed", errors: [{ resource: "PullRequest", code: "custom", message: "A pull request already exists for o:b." }] };
    expect(httpReason(JSON.stringify(body))).toBe("Validation Failed: A pull request already exists for o:b.");
  });

  it("skips a listed error that carries no message", () => {
    const body = { message: "Validation Failed", errors: [{ resource: "Issue", field: "title", code: "missing_field" }] };
    expect(httpReason(JSON.stringify(body))).toBe("Validation Failed");
  });

  it("keeps a lone angle bracket in plain text", () => {
    expect(httpReason("limit < 5 exceeded")).toBe("limit < 5 exceeded");
  });

  it("reads a message given as a list, or as fields each with a list", () => {
    expect(httpReason(JSON.stringify({ message: ["Another open merge request already exists for this source branch: !3"] })))
      .toBe("Another open merge request already exists for this source branch: !3");
    expect(httpReason(JSON.stringify({ message: { title: ["can't be blank"], base: ["is invalid"] } })))
      .toBe("title can't be blank; base is invalid");
  });

  it("reads errorMessages and errors given by field", () => {
    expect(httpReason(JSON.stringify({ errorMessages: ["Issue does not exist"], errors: {} }))).toBe("Issue does not exist");
    expect(httpReason(JSON.stringify({ errorMessages: [], errors: { summary: "You must specify a summary." } })))
      .toBe("summary: You must specify a summary.");
  });

  it("reads a lone error string", () => {
    expect(httpReason(JSON.stringify({ error: "insufficient_scope" }))).toBe("insufficient_scope");
  });

  it("gives JSON with no message field as the JSON, cut short", () => {
    expect(httpReason(JSON.stringify({ code: 7 }))).toBe('{"code":7}');
    const reason = httpReason(JSON.stringify({ data: "y".repeat(1000) }));
    expect(reason.length).toBe(201);
    expect(reason.endsWith("…")).toBe(true);
  });

  it("cuts a long message too", () => {
    expect(httpReason(JSON.stringify({ message: "m".repeat(1000) }))).toBe(`${"m".repeat(200)}…`);
  });

  it("gives nothing for an empty body", () => {
    expect(httpReason("  ")).toBe("");
  });
});

describe("httpError", () => {
  it("carries the method, where, status and reason in its message, and the whole body beside", () => {
    const e = httpError("POST", "https://api.example.test/graphql", 504, gatewayPage);
    expect(e.message).toBe("POST https://api.example.test/graphql → 504 Unicorn! · GitHub");
    expect(e.status).toBe(504);
    expect(e.body).toBe(gatewayPage);
  });

  it("ends at the status when the body is empty", () => {
    expect(httpError("GET", "/x", 502, "").message).toBe("GET /x → 502");
  });
});
