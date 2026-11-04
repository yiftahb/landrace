import { limitKindOf } from "#runner/limits.js";

describe("limitKindOf", () => {
  it.each([
    ["Claude AI usage limit reached|1760000000", "usage"],
    ["You've hit your usage limit. Upgrade to Pro or try again later.", "usage"],
    ['API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}', "rate"],
    ["exceeded retry limit, last status: 429 Too Many Requests", "rate"],
    ['API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', "overloaded"],
    ["spawn claude ENOENT", null],
    ["the agent ran past its 600000ms limit", null],
  ])("reads %j as %s", (text, kind) => {
    expect(limitKindOf(text)).toBe(kind);
  });
});
