// The matcher a `tests.map` pattern is resolved with. Written out rather
// than taken from Node's own experimental `path.matchesGlob`, so these
// are the rules the format documents and the rules that cannot change
// under a runtime upgrade - which is exactly why they are pinned here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesGlob } from "./glob.ts";

test("a pattern with no wildcard is one exact path, dots included", () => {
  assert.ok(matchesGlob("src/foreman/do.ts", "src/foreman/do.ts"));
  // The dot is literal: a pattern must not match a path that merely has
  // some other character where its own "." is.
  assert.ok(!matchesGlob("src/foreman/do.ts", "src/foreman/doXts"));
  // The whole path has to match, never a prefix or a suffix of it.
  assert.ok(!matchesGlob("src/foreman/do.ts", "src/foreman/do.test.ts"));
  assert.ok(!matchesGlob("src/foreman/do.ts", "x/src/foreman/do.ts"));
  assert.ok(!matchesGlob("src/foreman", "src/foreman/do.ts"));
});

test("* and ? stay inside one path segment", () => {
  assert.ok(matchesGlob("src/cli/*.ts", "src/cli/main.ts"));
  assert.ok(matchesGlob("src/cli/*.ts", "src/cli/main.test.ts"));
  // The whole point of the limit: a folder-wide line must not silently
  // claim a nested folder's files too.
  assert.ok(!matchesGlob("src/cli/*.ts", "src/cli/helpers/fake.ts"));
  assert.ok(!matchesGlob("*.ts", "src/index.ts"));

  assert.ok(matchesGlob("src/line/cut.?s", "src/line/cut.ts"));
  assert.ok(!matchesGlob("src/line/cut.?s", "src/line/cut.mjs"));
  assert.ok(!matchesGlob("?", "a/b"));
});

test("** crosses directories, and **/ also matches no directory at all", () => {
  assert.ok(matchesGlob("**/*.test.ts", "src/cli/main.test.ts"));
  assert.ok(matchesGlob("**/*.test.ts", "contract/rule1.isolation.test.ts"));
  // The case a plain `*/` form would miss, and the reason `**/` is
  // special-cased: a test file sitting in the project root.
  assert.ok(matchesGlob("**/*.test.ts", "root.test.ts"));
  assert.ok(matchesGlob("src/**/errors.ts", "src/cli/errors.ts"));
  assert.ok(matchesGlob("src/**/errors.ts", "src/errors.ts"));
  assert.ok(matchesGlob("src/**/errors.ts", "src/brain/adapters/errors.ts"));
  assert.ok(!matchesGlob("src/**/errors.ts", "contract/errors.ts"));

  // `**` not followed by a separator is just "anything, separators
  // included".
  assert.ok(matchesGlob("src/**.ts", "src/brain/adapters/some-adapter.ts"));
});

test("regex metacharacters in a pattern are literal", () => {
  // A pattern is a glob, not a regular expression: a path that would
  // match it as a regex but not as a glob must not match.
  assert.ok(matchesGlob("src/a+b/c(d).ts", "src/a+b/c(d).ts"));
  assert.ok(!matchesGlob("src/a+b/c(d).ts", "src/ab/cd.ts"));
  assert.ok(!matchesGlob("src/a|b.ts", "src/a.ts"));
  assert.ok(matchesGlob("src/[x].ts", "src/[x].ts"));
  assert.ok(!matchesGlob("src/[x].ts", "src/x.ts"));
});
