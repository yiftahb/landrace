import { parseEnvFile, expand } from "../../src/config/env.js";

describe("parseEnvFile", () => {
  it("reads KEY=value", () => {
    expect(parseEnvFile("A=1\nB=two").get("B")).toBe("two");
  });

  it("ignores comments and blank lines", () => {
    expect([...parseEnvFile("# c\n\nA=1").keys()]).toEqual(["A"]);
  });

  it("strips matching quotes, because a pasted token often arrives quoted", () => {
    expect(parseEnvFile('A="x"\nB=\'y\'').get("A")).toBe("x");
    expect(parseEnvFile('A="x"\nB=\'y\'').get("B")).toBe("y");
  });

  it("keeps = inside a value", () => {
    expect(parseEnvFile("A=a=b").get("A")).toBe("a=b");
  });

  it("does not trim inside a quoted value", () => {
    expect(parseEnvFile('A=" x "').get("A")).toBe(" x ");
  });
});

describe("expand", () => {
  const env = new Map([["TOKEN", "abc"]]);

  it("resolves $VAR and ${VAR}", () => {
    expect(expand("$TOKEN", env)).toBe("abc");
    expect(expand("${TOKEN}", env)).toBe("abc");
  });

  it("leaves a plain value alone", () => {
    expect(expand("literal", env)).toBe("literal");
  });

  it("leaves an unresolved reference as-is so the caller can report it", () => {
    expect(expand("$NOPE", env)).toBe("$NOPE");
  });
});
