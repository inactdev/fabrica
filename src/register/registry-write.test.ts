import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, projectsTomlPath } from "../config/index.ts";
import { RegisterError } from "./errors.ts";
import { appendProjectEntry, existingRegistration, isUsableProjectName } from "./registry-write.ts";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-register-registry-"));
}

test("isUsableProjectName accepts a TOML bare key and nothing else", () => {
  for (const good of ["fabrica", "spending-app", "app_2", "A1"]) {
    assert.equal(isUsableProjectName(good), true, good);
  }
  for (const bad of ["my app", "app.v2", "", "app/v2", "ünicode"]) {
    assert.equal(isUsableProjectName(bad), false, bad);
  }
});

test("appendProjectEntry creates projects.toml when there is none, and it parses", () => {
  const recordHome = tempHome();
  const { tomlPath, appended } = appendProjectEntry({
    recordHome,
    name: "fabrica",
    path: "/srv/fabrica",
    check: "./check.sh",
  });

  assert.equal(tomlPath, projectsTomlPath(recordHome));
  assert.equal(
    appended,
    '[projects.fabrica]\npath = "/srv/fabrica"\ncheck = "./check.sh"\nonlyTouchedTests = true\n'
  );
  assert.deepEqual(loadConfig(recordHome).projects.fabrica, {
    path: "/srv/fabrica",
    check: "./check.sh",
    onlyTouchedTests: true,
  });
});

// Issue #142: the standing ruling is written out rather than left to the
// loader's own default, because this text is what the Client is shown
// when his project is registered - and the line he edits to turn it off.
test("appendProjectEntry writes the only-touched-tests ruling into the entry, as a line the Client can flip", () => {
  const recordHome = tempHome();
  const { appended } = appendProjectEntry({
    recordHome,
    name: "fabrica",
    path: "/srv/fabrica",
    check: "./check.sh",
  });

  assert.match(appended, /^onlyTouchedTests = true$/m);
  assert.equal(loadConfig(recordHome).projects.fabrica.onlyTouchedTests, true);
});

// Work mode (`--terms`): two more lines, written out for the same
// reason onlyTouchedTests is - this text is what the Client is shown,
// and these are the lines he edits.
test("appendProjectEntry writes the terms folder and noStamp = true for a work-mode project", () => {
  const recordHome = tempHome();
  const { appended } = appendProjectEntry({
    recordHome,
    name: "dayjob",
    path: "/home/ari/work/widgets",
    check: "./check.sh",
    terms: "/home/ari/fabrica-terms/widgets",
    noStamp: true,
  });

  assert.equal(
    appended,
    '[projects.dayjob]\npath = "/home/ari/work/widgets"\ncheck = "./check.sh"\n' +
      'terms = "/home/ari/fabrica-terms/widgets"\nnoStamp = true\nonlyTouchedTests = true\n'
  );
  assert.deepEqual(loadConfig(recordHome).projects.dayjob, {
    path: "/home/ari/work/widgets",
    check: "./check.sh",
    terms: "/home/ari/fabrica-terms/widgets",
    noStamp: true,
    onlyTouchedTests: true,
  });
});

// "Projects registered without --terms are unchanged": neither line is
// written when neither was asked for, so an ordinary entry looks exactly
// as it always did.
test("appendProjectEntry writes neither line for a project with no terms folder", () => {
  const recordHome = tempHome();
  const { appended } = appendProjectEntry({
    recordHome,
    name: "fabrica",
    path: "/srv/fabrica",
    check: "./check.sh",
  });

  assert.doesNotMatch(appended, /terms|[Ss]tamp/);
});

test("appendProjectEntry leaves everything already in the file exactly as it was", () => {
  const recordHome = tempHome();
  const before =
    "# my own comment, kept\n[caps]\nperDayUsd = 20\n\n[projects.other]\npath = \"/srv/other\"\ncheck = \"make check\"\n";
  writeFileSync(projectsTomlPath(recordHome), before);

  appendProjectEntry({ recordHome, name: "fabrica", path: "/srv/fabrica", check: "./check.sh" });

  const after = readFileSync(projectsTomlPath(recordHome), "utf8");
  assert.ok(after.startsWith(before), "the Client's own text must be untouched, byte for byte");
  const config = loadConfig(recordHome);
  assert.equal(config.caps.perDayUsd, 20);
  assert.equal(config.projects.other.check, "make check");
  assert.equal(config.projects.fabrica.path, "/srv/fabrica");
});

test("appendProjectEntry: a file with no trailing newline does not get its last line glued to the new table", () => {
  const recordHome = tempHome();
  writeFileSync(projectsTomlPath(recordHome), '[projects.other]\npath = "/srv/other"');

  appendProjectEntry({ recordHome, name: "fabrica", path: "/srv/fabrica", check: "./check.sh" });

  const config = loadConfig(recordHome);
  assert.equal(config.projects.other.path, "/srv/other");
  assert.equal(config.projects.fabrica.path, "/srv/fabrica");
});

test("appendProjectEntry: a path with a quote or a backslash is escaped, not written raw", () => {
  const recordHome = tempHome();
  const path = '/srv/odd "name"\\dir';
  appendProjectEntry({ recordHome, name: "odd", path, check: "./check.sh" });

  assert.equal(loadConfig(recordHome).projects.odd.path, path);
});

// The guarantee the read-back-and-restore exists to provide, asserted in
// a way that holds whichever way a TOML parser treats a table defined
// twice: either the second append is refused and the file is byte-
// identical to before it, or it is accepted and the file still parses.
// What must never happen is the Client's registry left unreadable.
test("appendProjectEntry never leaves projects.toml unparseable", () => {
  const recordHome = tempHome();
  appendProjectEntry({ recordHome, name: "fabrica", path: "/srv/fabrica", check: "./check.sh" });
  const afterFirst = readFileSync(projectsTomlPath(recordHome), "utf8");

  let refused = false;
  try {
    appendProjectEntry({ recordHome, name: "fabrica", path: "/srv/other", check: "./check.sh" });
  } catch (err) {
    refused = true;
    assert.ok(err instanceof RegisterError && err.code === "registry-write-failed");
    assert.equal(
      readFileSync(projectsTomlPath(recordHome), "utf8"),
      afterFirst,
      "a refused append must restore the file exactly as it was"
    );
  }
  // Either way, the file still loads.
  assert.doesNotThrow(() => loadConfig(recordHome));
  if (!refused) assert.ok(true, "this parser accepts the duplicate table; the file still parses");
});

test("existingRegistration: no projects.toml at all is not a collision", () => {
  assert.equal(existingRegistration(tempHome(), "fabrica", "/srv/fabrica"), null);
});

test("existingRegistration: the same name collides, naming the path it already points at", () => {
  const recordHome = tempHome();
  appendProjectEntry({ recordHome, name: "fabrica", path: "/srv/fabrica", check: "./check.sh" });

  assert.deepEqual(existingRegistration(recordHome, "fabrica", "/srv/elsewhere"), {
    name: "fabrica",
    reason: "same-name",
    path: "/srv/fabrica",
  });
});

// One repository registered twice under two names would give it two sets
// of records - a duplicate the Client should hear about, not something to
// add quietly (Client ruling: never silently no-op).
test("existingRegistration: a different name already pointing at this same repository collides too", () => {
  const recordHome = tempHome();
  appendProjectEntry({ recordHome, name: "first", path: "/srv/fabrica", check: "./check.sh" });

  assert.deepEqual(existingRegistration(recordHome, "second", "/srv/fabrica"), {
    name: "first",
    reason: "same-path",
    path: "/srv/fabrica",
  });
});

test("existingRegistration: an unreadable projects.toml refuses rather than reading as empty", () => {
  const recordHome = tempHome();
  writeFileSync(projectsTomlPath(recordHome), "projects = 1\n");

  assert.throws(
    () => existingRegistration(recordHome, "fabrica", "/srv/fabrica"),
    (err: unknown) =>
      err instanceof RegisterError &&
      err.code === "registry-write-failed" &&
      err.message.includes("nothing on the repository was touched")
  );
});
