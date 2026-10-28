// Which touched files need a test at all (issue #305).

import { test } from "node:test";
import assert from "node:assert/strict";
import { isDocumentation, isTestFile, normalizeFile } from "./classify.ts";

test("documentation is recognized by extension, anywhere in the tree", () => {
  for (const file of ["README.md", "src/testmap/README.md", "integrations/live-view/notes/x.md", "A.MD"]) {
    assert.ok(isDocumentation(file), `${file} should be documentation`);
  }
});

test("notes/ and docs/ are documentation at any depth, not just at the root", () => {
  for (const file of [
    "notes/20261028-something.md",
    "notes/sketch.txt",
    "docs/architecture.svg",
    "integrations/live-view/docs/foo.txt",
    "src/testmap/notes/scratch.json",
  ]) {
    assert.ok(isDocumentation(file), `${file} should be documentation`);
  }

  // The directory name has to be a whole segment of its own.
  assert.ok(!isDocumentation("src/notesy/thing.ts"));
  assert.ok(!isDocumentation("src/docsearch.ts"));
  // And a file *named* notes or docs is still a file.
  assert.ok(!isDocumentation("src/cli/docs.ts"));
});

test("at the root, every dotfile and LICENSE are documentation - deeper down, they are not", () => {
  for (const file of [".gitignore", ".npmignore", ".node-version", ".inspector.json", "LICENSE", "LICENSE.txt"]) {
    assert.ok(isDocumentation(file), `${file} should be documentation`);
  }

  // A dotted path deeper in the tree is ordinarily configuration a
  // change can genuinely break, and a nested LICENSE is a fixture.
  assert.ok(!isDocumentation("skill/some-harness/.settings.json"));
  assert.ok(!isDocumentation("src/line/helpers/LICENSE"));
});

test("code is not documentation, whatever it is called", () => {
  for (const file of ["src/cli/main.ts", "package.json", "tests.map", "check.sh", "integrations/live-view/public/app.js"]) {
    assert.ok(!isDocumentation(file), `${file} should not be documentation`);
  }
});

test("a test file is recognized by either spelling of the colocated convention", () => {
  assert.ok(isTestFile("src/cli/main.test.ts"));
  assert.ok(isTestFile("src/cli/main.spec.tsx"));
  assert.ok(isTestFile("contract/rule1.isolation.test.ts"));
  assert.ok(!isTestFile("src/cli/main.ts"));
  assert.ok(!isTestFile("src/cli/test.ts"));
  assert.ok(!isTestFile("src/cli/helpers/fake-brain.ts"));
});

test("both answers are given for the path shape the map's patterns are written in", () => {
  assert.equal(normalizeFile("./README.md"), "README.md");
  assert.equal(normalizeFile("src\\cli\\main.ts"), "src/cli/main.ts");

  assert.ok(isDocumentation("./README.md"));
  assert.ok(isDocumentation("notes\\x.txt"));
  assert.ok(isTestFile("./src/cli/main.test.ts"));
});
