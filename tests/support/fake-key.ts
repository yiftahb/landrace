import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeyHelper, StartOptions } from "#namespace.js";

/**
 * The macOS Keychain's `security` as far as Landrace asks it: a find that
 * exits 44 while nothing is stored, and an `-i` add read from stdin. One
 * throwaway key, in memory: a test never reaches this machine's own store.
 */
export function fakeKeychain(): { run: KeyHelper; calls: Array<{ args: readonly string[]; input?: string | undefined }>; held: () => string | undefined } {
  let held: string | undefined;
  const calls: Array<{ args: readonly string[]; input?: string | undefined }> = [];
  const run: KeyHelper = async (command, args, opts) => {
    calls.push({ args, input: opts.input });
    if (command !== "security") throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" });
    if (args[0] === "find-generic-password") {
      return held === undefined ? { code: 44, stdout: "", stderr: "security: The specified item could not be found in the keychain.\n" } : { code: 0, stdout: `${held}\n`, stderr: "" };
    }
    if (args[0] === "-i" && held === undefined) held = /-w ([0-9a-f]+)\n$/.exec(opts.input ?? "")?.[1];
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls, held: () => held };
}

/**
 * What a `runStart` test hands it so its store is a temporary folder sealed
 * under a fake Keychain's key — never `~/.landrace/credentials`, nor the
 * machine's own Keychain.
 */
export function keyless(): Pick<StartOptions, "credentialsRoot" | "keyLookup"> {
  return {
    credentialsRoot: join(mkdtempSync(join(tmpdir(), "lr-start-creds-")), "credentials"),
    keyLookup: { platform: "darwin", env: {}, run: fakeKeychain().run },
  };
}
