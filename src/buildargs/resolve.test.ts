import { test } from "node:test";
import assert from "node:assert/strict";
import { buildArgFlags, buildArgsFingerprint, resolveBuildArgs } from "./resolve.ts";

function repo(files: Record<string, string>) {
  return (path: string) => files[path] ?? null;
}

test("every declared argument gets the value its own file names", () => {
  const resolved = resolveBuildArgs(
    {
      RUBY_VERSION: { file: ".ruby-version", pattern: "^(?:ruby-)?([0-9][^\\s]*)$" },
      GO_VERSION: { file: "go.mod", pattern: "^go[ \\t]+([0-9][^\\s]*)$" },
    },
    repo({ ".ruby-version": "3.4.13\n", "go.mod": "module x\n\ngo 1.23.4\n" })
  );
  assert.deepEqual(resolved.values, { RUBY_VERSION: "3.4.13", GO_VERSION: "1.23.4" });
  assert.deepEqual(resolved.unresolved, []);
});

// The three ways an entry can fail. None of them may pass a value, and
// none of them may be silent: the build would fall back to whatever
// default the Dockerfile carries, which is the stale version issue #355
// is about.
test("an argument that cannot be valued is reported and not passed", () => {
  const resolved = resolveBuildArgs(
    {
      GONE: { file: ".ruby-version" },
      EMPTY: { file: ".node-version" },
      NO_MATCH: { file: "go.mod", pattern: "^go[ \\t]+([0-9][^\\s]*)$" },
      NOT_A_TAG: { file: ".python-version" },
    },
    repo({ ".node-version": "\n\n", "go.mod": "module x\n", ".python-version": "3.12 or so\n" })
  );
  assert.deepEqual(resolved.values, {});
  assert.deepEqual(
    resolved.unresolved.map((one) => one.name),
    ["GONE", "EMPTY", "NO_MATCH", "NOT_A_TAG"]
  );
  assert.match(resolved.unresolved[0].reason, /\.ruby-version is not in this project/);
  assert.match(resolved.unresolved[1].reason, /empty/);
  assert.match(resolved.unresolved[2].reason, /no line in go\.mod matches/);
  assert.match(resolved.unresolved[3].reason, /no image tag could be/);
});

// Deliberately NOT a fallback chain: Inspector resolves the same entry
// against the same file, so a Fabrica that quietly read a second file
// would build the worker's box on one version and the check box on
// another.
test("a declared file that has gone is never swapped for another of its family", () => {
  const resolved = resolveBuildArgs(
    { NODE_VERSION: { file: ".nvmrc" } },
    repo({ ".node-version": "24.18.0\n", ".tool-versions": "nodejs 22.9.0\n" })
  );
  assert.deepEqual(resolved.values, {});
  assert.equal(resolved.unresolved.length, 1);
});

test("nothing declared is nothing resolved, and no flags", () => {
  const resolved = resolveBuildArgs({}, repo({ ".ruby-version": "3.4.13\n" }));
  assert.deepEqual(resolved, { values: {}, unresolved: [] });
  assert.deepEqual(buildArgFlags({}), []);
  assert.equal(buildArgsFingerprint({}), "");
});

test("flags and the stamp's fingerprint are ordered by name, never by the config", () => {
  const one = { RUBY_VERSION: "3.4.13", GO_VERSION: "1.23.4" };
  const other = { GO_VERSION: "1.23.4", RUBY_VERSION: "3.4.13" };
  assert.deepEqual(buildArgFlags(one), [
    "--build-arg",
    "GO_VERSION=1.23.4",
    "--build-arg",
    "RUBY_VERSION=3.4.13",
  ]);
  assert.deepEqual(buildArgFlags(one), buildArgFlags(other));
  assert.equal(buildArgsFingerprint(one), buildArgsFingerprint(other));
  // And it does move when a value moves - which is the whole point of
  // hashing it into the image's stamp.
  assert.notEqual(buildArgsFingerprint(one), buildArgsFingerprint({ ...one, RUBY_VERSION: "3.4.8" }));
});
