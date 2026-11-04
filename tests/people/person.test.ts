import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "#config/load.js";
import { localPerson, personFields } from "#people/person.js";

async function loaded(extra: string, env = "") {
  const dir = join(await mkdtemp(join(tmpdir(), "landrace-person-")), ".landrace");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "landrace.yaml"), `version: 1\nagent: { adapter: claude }\n${extra}`);
  await writeFile(join(dir, ".env"), env);
  return loadConfig(dir);
}

describe("localPerson", () => {
  it("is just local with no people block", async () => {
    expect(localPerson(await loaded(""))).toEqual({ id: "local" });
  });

  it("takes the email and name a variable resolves to", async () => {
    const person = localPerson(await loaded("people: { local: { email: $X, name: Dev } }\n", "X=dev1@example.invalid\n"));
    expect(person).toEqual({ id: "local", email: "dev1@example.invalid", name: "Dev" });
  });

  it("names no email while its variable is unset, rather than the reference", async () => {
    expect(localPerson(await loaded("people: { local: { email: $X } }\n"))).toEqual({ id: "local" });
  });
});

describe("personFields", () => {
  it("is person, with personEmail only when there is one", () => {
    expect(personFields({ id: "local" })).toEqual({ person: "local" });
    expect(personFields({ id: "local", email: "a@b.c", name: "A" })).toEqual({ person: "local", personEmail: "a@b.c" });
  });
});
