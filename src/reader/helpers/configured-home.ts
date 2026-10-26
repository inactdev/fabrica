// Test-only: a record home that has a settled code reader in it.
//
// `fabrica do` refuses an inspected project with no `[reader]`
// (inspector issue #34, the Client's ruling: refuse at task start with
// the exact lines to add), so every test whose subject is something
// else - registration, the detached spawn, a status line, a cap - needs
// a record home that gets past that gate. This writes one, in the same
// two places a real machine keeps it: the `[reader]` table in
// projects.toml, and the credentials in `brain.env` at mode 600.
//
// Deliberately NOT the process environment, which `resolveReader` also
// reads: two tests running concurrently in one process would then be
// writing the same variables, and a real key for some vendor sitting in
// the tester's own shell could make a test pass for a reason that has
// nothing to do with the code under test.
//
// The vendor here is a made-up string, like every vendor in these
// suites (CONTRACT rule 8's scan covers helpers too). Nothing is ever
// called: a test that lets a read actually happen passes a fake through
// `createForeman`'s `readDiff` option. Without one, the read reaches a
// made-up endpoint and fails - which is recorded and never blocks the
// delivery, so that is a valid thing for a test to leave alone.

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brainEnvPath } from "../../brain/index.ts";
import { apiKeyVarFor, baseUrlVarFor } from "../../reviewer/index.ts";

export const TEST_READER_VENDOR = "close-reader";
export const TEST_READER_MODEL = "reader-1";
/** `.invalid` is reserved by RFC 2606 and can never resolve, so a read
 * that is left to happen for real fails fast instead of reaching
 * anything. */
export const TEST_READER_BASE_URL = "https://reader.invalid/v1";

/** The `[reader]` table, as projects.toml holds it. */
export const READER_TOML = `[reader]\nvendor = "${TEST_READER_VENDOR}"\nmodel = "${TEST_READER_MODEL}"\n`;

/**
 * Writes `projectsToml` into `recordHome` with the `[reader]` table in
 * front of it, plus the two credentials in `brain.env`.
 *
 * `[reader]` goes FIRST because it is a top-level table: appended after
 * a `[projects.<name>]` section its keys would read as that project's,
 * which is a different (and valid) meaning.
 */
export function withReaderConfigured(recordHome: string, projectsToml = ""): void {
  writeFileSync(join(recordHome, "projects.toml"), `${READER_TOML}\n${projectsToml}`);
  writeReaderCredentials(recordHome);
}

/** The same, for a record home whose projects.toml some other helper
 * already wrote: the `[reader]` table is put in front of whatever is
 * there, so this can be called at any point. */
export function addReaderToHome(recordHome: string): void {
  const path = join(recordHome, "projects.toml");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (!existing.includes("[reader]")) writeFileSync(path, `${READER_TOML}\n${existing}`);
  writeReaderCredentials(recordHome);
}

function writeReaderCredentials(recordHome: string): void {
  const path = brainEnvPath(recordHome);
  const line = (name: string, value: string) => `${name}=${value}\n`;
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  writeFileSync(
    path,
    existing +
      line(apiKeyVarFor(TEST_READER_VENDOR), "not-a-real-key") +
      line(baseUrlVarFor(TEST_READER_VENDOR), TEST_READER_BASE_URL)
  );
  // brain.env is refused outright if other users can read it, which is
  // its own refusal in its own words - so a helper that wrote one the
  // wrong way would look like a missing credential.
  chmodSync(path, 0o600);
}
