// A build secret's **value** may reach exactly two child processes and
// nothing else (issue #342: "never into the worker box, the record, a
// log, a pull request, or any message; only names ever appear").
//
// Two different kinds of proof, because neither alone is enough:
//
//   - **Structural.** A scan of every production file under `src/` and
//     `integrations/` for an import of this module's resolver. Only the
//     three files allowed to read a value may have one, so a fourth
//     reader cannot be added quietly - which is the way this guarantee
//     would actually be lost, long after anyone remembers the rule.
//   - **Behavioural.** The worker box's environment really is built from
//     one credential, with a `brain.env` that holds a build secret
//     sitting right there in the same file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { brainEnvPath } from "../brain/index.ts";
// Reached directly, not through the barrel: this is the one directory
// allowed to name the worker's own CLI, and `credentialEnvFrom` is its
// internal seam rather than part of Fabrica's public surface. The
// credential's variable name comes from there too, for the same reason -
// spelling it here would fail CONTRACT rule 8's own scan of this
// directory.
import { credentialEnvFrom, WORKER_CREDENTIAL_VAR } from "../brain/adapters/index.ts";
import { PAID_SOURCE_VARIABLE } from "../register/helpers/rails-fixture.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The only files anywhere that may read a build secret's value, as
 * repository-relative paths.
 *
 *   - the machine image build, which hands each one to `docker build`
 *     as `--secret id=NAME,env=NAME`;
 *   - the round's own Inspector handoff, which puts them on the
 *     `inspector` child's environment for Inspector to do the same;
 *   - `fabrica doctor`, which only ever asks whether a value is there.
 *
 * Plus this module's own files, which are where the reading is
 * implemented.
 */
const MAY_READ_A_VALUE: readonly string[] = [
  "src/projectimage/resolve.ts",
  "src/foreman/judge.ts",
  "src/cli/doctor-command.ts",
  "src/index.ts",
];

/** Every production TypeScript file in the tree, excluding this module's
 * own and every test. */
function productionFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
      const rel = relative(repoRoot, path);
      if (rel.startsWith(join("src", "buildsecrets"))) continue;
      found.push(rel);
    }
  };
  for (const top of ["src", "integrations"]) walk(join(repoRoot, top));
  return found;
}

/** The two functions that hand back a value. Anything else this module
 * exports is names only, and may be read anywhere. */
const VALUE_READERS = /\bresolve(?:Project)?BuildSecrets\b/;

test("only the two builds and doctor may read a build secret's value", () => {
  const readers = productionFiles().filter((rel) => VALUE_READERS.test(readFileSync(join(repoRoot, rel), "utf8")));
  assert.deepEqual(
    readers.sort(),
    [...MAY_READ_A_VALUE].sort(),
    `a build secret's value may only be read where it is handed to a build or asked about - see this file's ` +
      `header. If a new reader is genuinely right, it needs a ruling and a line in MAY_READ_A_VALUE, not a ` +
      `quiet addition.`
  );
});

test("the scan cannot pass vacuously - the three real readers are really found", () => {
  // Without this, deleting the resolver would make the test above pass
  // by finding nothing anywhere.
  const files = productionFiles();
  for (const rel of MAY_READ_A_VALUE) {
    assert.ok(files.includes(rel), `${rel} is not in the scanned set any more - this test is measuring nothing`);
  }
});

// The pinning that keeps an in-repository list out of a Worker's
// reach. Asserted structurally because the behavioural proof of what a
// revision does lives in declared.test.ts, while what has to hold HERE
// is that the round still passes one - which is the line someone would
// drop while tidying.
test("a round reads an in-repository list at the task's base commit, never from the worktree", () => {
  const source = readFileSync(join(repoRoot, "src/foreman/judge.ts"), "utf8");
  const call = /resolveBuildSecrets\(\{[\s\S]*?\}\)/.exec(source);
  assert.ok(call, "src/foreman/judge.ts should resolve this round's build secrets");
  assert.match(
    call[0],
    /revision:\s*baseCommit/,
    "the list a round hands to Inspector has to be the one the base commit carries - a worktree copy is a " +
      "file the Worker has had its hands on, and the list decides which of brain.env's variables are handed " +
      "to an image build"
  );
});

test("doctor asks whether a value is there and never touches the value itself", () => {
  // The resolution's `values` is the only field holding one, so the
  // line `fabrica doctor` prints cannot carry a value unless this file
  // names that field - which it does not, and must not. The record,
  // every message and every log are downstream of lines like this one.
  const source = readFileSync(join(repoRoot, "src/cli/doctor-command.ts"), "utf8");
  assert.match(source, /resolveProjectBuildSecrets/, "doctor has to ask the question for this test to mean anything");
  assert.doesNotMatch(
    source,
    /BuildSecrets[\s\S]{0,400}?\.values\b/,
    "fabrica doctor must never read a build secret's value - it reports names and whether each one is set"
  );
});

test("a worker box's environment is one credential, with a build secret sitting in the same brain.env", () => {
  const recordHome = mkdtempSync(join(tmpdir(), "fabrica-worker-env-"));
  const path = brainEnvPath(recordHome);
  writeFileSync(
    path,
    `${WORKER_CREDENTIAL_VAR}=the-worker-token\n${PAID_SOURCE_VARIABLE}=someone:a-real-looking-password\n`
  );
  chmodSync(path, 0o600);

  // The adapter's env is an explicit allowlist, not a pass-through: this
  // is the whole of what a worker's container is given from this
  // machine.
  const { env } = credentialEnvFrom({}, recordHome);
  assert.deepEqual(Object.keys(env ?? {}), [WORKER_CREDENTIAL_VAR]);
  const serialized = JSON.stringify(env);
  assert.ok(!serialized.includes("a-real-looking-password"), `the worker box must never see a build secret: ${serialized}`);
  assert.ok(!serialized.includes(PAID_SOURCE_VARIABLE), `not even the name belongs in a worker's box: ${serialized}`);
});
