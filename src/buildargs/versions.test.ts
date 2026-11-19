import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  argFormRef,
  buildArgEntry,
  declaredVersionFor,
  familyOfArg,
  familyOfImage,
  readFileIn,
  splitImageVersion,
  unusableValueReason,
  usableValue,
  valueFromText,
  versionArgFor,
  VERSION_FAMILIES,
} from "./versions.ts";

/** A repository of plain files, for the `ReadRepoFile` seam. */
function repo(files: Record<string, string>) {
  return (path: string) => files[path] ?? null;
}

function familyNamed(label: string) {
  const family = VERSION_FAMILIES.find((one) => one.label === label);
  assert.ok(family, `no ${label} family in the table`);
  return family;
}

test("a version in an image's tag is split from its repository and its suffix", () => {
  assert.deepEqual(splitImageVersion("ruby:3.4.8"), { image: "ruby", version: "3.4.8", suffix: "" });
  assert.deepEqual(splitImageVersion("ruby:3.4.8-slim"), { image: "ruby", version: "3.4.8", suffix: "-slim" });
  assert.deepEqual(splitImageVersion("cimg/node:24.18.0"), { image: "cimg/node", version: "24.18.0", suffix: "" });
  // A registry host may carry a port, and that colon is not a tag.
  assert.deepEqual(splitImageVersion("registry.internal:5000/ruby:3.4"), {
    image: "registry.internal:5000/ruby",
    version: "3.4",
    suffix: "",
  });
});

// Each of these would be a silent repointing of an image whose version
// was never in its tag - the one thing the conversion must never do.
test("a reference whose version is not in its tag is never split", () => {
  for (const ref of [
    "ruby@sha256:" + "a".repeat(64),
    "ruby:latest",
    "ruby:slim",
    "ruby",
    "registry.internal:5000/ruby",
    "ruby:${RUBY_VERSION}",
    "ruby:$RUBY_VERSION",
  ]) {
    assert.equal(splitImageVersion(ref), null, `${ref} must not be read as carrying a version`);
  }
});

test("only images whose tag IS a language version belong to a family", () => {
  assert.equal(familyOfImage("ruby")?.arg, "RUBY_VERSION");
  assert.equal(familyOfImage("cimg/ruby")?.arg, "RUBY_VERSION");
  assert.equal(familyOfImage("node")?.arg, "NODE_VERSION");
  assert.equal(familyOfImage("cimg/go")?.arg, "GO_VERSION");
  assert.equal(familyOfImage("golang")?.arg, "GO_VERSION");
  assert.equal(familyOfImage("python")?.arg, "PYTHON_VERSION");
  // Matched whole, never as a suffix: a repository that happens to end
  // in a language's name is somebody else's image.
  for (const image of ["my-own/notruby", "ruby/bundler", "postgres", ""]) {
    assert.equal(familyOfImage(image), null, `${image} must not be read as a language image`);
  }
});

test("every argument name in the table maps back to its own family", () => {
  for (const family of VERSION_FAMILIES) assert.equal(familyOfArg(family.arg), family);
  assert.equal(familyOfArg("SOMETHING_ELSE"), null);
});

test("a value with no pattern is the file's first non-empty line", () => {
  assert.equal(valueFromText("\n\n 3.4.13 \n"), "3.4.13");
  assert.equal(valueFromText(""), null);
  assert.equal(valueFromText("\n \n"), null);
});

test("a pattern is matched one trimmed line at a time, first match winning", () => {
  const toolVersions = "nodejs 24.18.0\nruby 3.4.13 3.3.0\ngolang 1.22.5\n";
  assert.equal(valueFromText(toolVersions, "^ruby[ \\t]+([0-9][^\\s]*)"), "3.4.13");
  assert.equal(valueFromText(toolVersions, "^golang[ \\t]+([0-9][^\\s]*)"), "1.22.5");
  // Anchored per line, with no (?m) anywhere - the flag Go's RE2 needs
  // and JavaScript rejects.
  assert.equal(valueFromText("module x\n\ngo 1.23.4\n", "^go[ \\t]+([0-9][^\\s]*)$"), "1.23.4");
  assert.equal(valueFromText("# nothing here\n", "^go[ \\t]+([0-9][^\\s]*)$"), null);
  // A CRLF file still answers, because every line is trimmed first.
  assert.equal(valueFromText("3.4.13\r\n", "^(?:ruby-)?([0-9][^\\s]*)$"), "3.4.13");
  // A pattern with no capture group takes the whole match.
  assert.equal(valueFromText("3.4.13\n", "^[0-9.]+$"), "3.4.13");
  // And one that will not compile answers null rather than throwing -
  // this is a hand-editable config, not a program.
  assert.equal(valueFromText("3.4.13\n", "^([0-9"), null);
});

test("a value that could not be a Docker tag is refused by name", () => {
  assert.ok(usableValue("3.4.13"));
  assert.ok(usableValue("1.22.5-rc1"));
  for (const bad of ["", "-3.4", "3.4 13", "3.4/13", "3.4;rm -rf /", "a".repeat(129)]) {
    assert.equal(usableValue(bad), false, `${bad} must not be passed to a build`);
  }
  assert.match(unusableValueReason("a".repeat(129)), /129 characters/);
  assert.match(unusableValueReason("3.4 13"), /not a Docker tag/);
});

test("the primary file wins, and a file naming nothing falls through to the next", () => {
  const node = familyNamed("node");
  assert.deepEqual(declaredVersionFor(node, repo({ ".node-version": "24.18.0\n", ".nvmrc": "20.1.0\n" })), {
    file: ".node-version",
    pattern: "^v?([0-9][^\\s]*)$",
    value: "24.18.0",
  });
  // `.nvmrc` holding an alias names no version at all, so the next file
  // in the order answers - "first that names one", not "first present".
  assert.deepEqual(
    declaredVersionFor(node, repo({ ".nvmrc": "lts/*\n", ".tool-versions": "nodejs 22.9.0\n" }))?.value,
    "22.9.0"
  );
  assert.equal(declaredVersionFor(node, repo({ ".nvmrc": "lts/*\n" })), null);
});

test("each language's own primary file is read, in the Client's own order", () => {
  const cases: [string, Record<string, string>, string][] = [
    ["ruby", { ".ruby-version": "ruby-3.4.13\n" }, "3.4.13"],
    ["ruby", { ".tool-versions": "ruby 3.4.13\n" }, "3.4.13"],
    ["node", { ".nvmrc": "v22.9.0\n" }, "22.9.0"],
    ["python", { ".python-version": "3.12.1\n" }, "3.12.1"],
    ["python", { ".python-version": "pypy3.10-7.3.15\n", ".tool-versions": "python 3.12.1\n" }, "3.12.1"],
    ["go", { "go.mod": "module example.com/x\n\ngo 1.23.4\n\nrequire (\n)\n" }, "1.23.4"],
    ["go", { ".tool-versions": "golang 1.22.5\n" }, "1.22.5"],
  ];
  for (const [label, files, expected] of cases) {
    assert.equal(
      declaredVersionFor(familyNamed(label), repo(files))?.value,
      expected,
      `${label} from ${Object.keys(files).join(", ")}`
    );
  }
});

// The headline case of issue #355: the two disagree, and the file is
// the one that wins. If this required them to be equal, the whole
// conversion would only ever fire on projects that did not need it.
test("a tag and a version file that disagree still produce an argument", () => {
  const found = versionArgFor("ruby:3.4.8", repo({ ".ruby-version": "3.4.13\n" }));
  assert.ok(found);
  assert.equal(found.family.arg, "RUBY_VERSION");
  assert.equal(found.image.version, "3.4.8");
  assert.equal(found.declared.value, "3.4.13");
  assert.equal(argFormRef(found), "ruby:${RUBY_VERSION}");
  assert.deepEqual(buildArgEntry(found), {
    RUBY_VERSION: { file: ".ruby-version", pattern: "^(?:ruby-)?([0-9][^\\s]*)$" },
  });
});

test("the argument form keeps whatever the tag carried after the version", () => {
  const found = versionArgFor("ruby:3.4.8-slim", repo({ ".ruby-version": "3.4.13\n" }));
  assert.ok(found);
  assert.equal(argFormRef(found), "ruby:${RUBY_VERSION}-slim");
});

test("no argument for an image that is not a language's, or a repository that declares none", () => {
  assert.equal(versionArgFor("postgres:17", repo({ ".ruby-version": "3.4.13\n" })), null);
  assert.equal(versionArgFor("ruby:3.4.8", repo({})), null);
  assert.equal(versionArgFor("ruby:latest", repo({ ".ruby-version": "3.4.13\n" })), null);
});

test("readFileIn answers off a real directory, and null for what is not there", () => {
  const dir = mkdtempSync(join(tmpdir(), "fabrica-buildargs-"));
  mkdirSync(join(dir, "nested"));
  writeFileSync(join(dir, ".ruby-version"), "3.4.13\n");
  const read = readFileIn(dir);
  assert.equal(read(".ruby-version"), "3.4.13\n");
  assert.equal(read(".node-version"), null);
  // A directory is not a file, and reading one must answer null rather
  // than throw out of a doctor line.
  assert.equal(read("nested"), null);
});
