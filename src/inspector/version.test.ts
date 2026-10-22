// `fabrica update`'s Inspector seam: the real probes, and the one action
// only that command takes.
//
// Everything about *classifying* a build is `doctor-checks.test.ts`'s,
// since the classifier itself lives there and both callers share it.
// What is left to prove here is that the real probes answer honestly on
// a machine with nothing installed, and that a failing install reports
// rather than throws - the property `fabrica update` leans on to promise
// it can never fail on the Inspector step.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectorInstallArgs, inspectorInstallCommand } from "./doctor-checks.ts";
import { goInstallInspector, realInspectorVersionProbes } from "./version.ts";

/** A throwaway PATH holding one script, so nothing here runs a real
 * `go`, a real `git` or a real Inspector. */
function pathWith(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fabrica-inspector-version-"));
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
  return `${dir}:/usr/bin:/bin`;
}

test("the real probes: no inspector on PATH is no build at all, not an unreadable one", () => {
  const probes = realInspectorVersionProbes("inspector", { PATH: mkdtempSync(join(tmpdir(), "fabrica-empty-path-")) });
  assert.equal(probes.build(), null, "`fabrica update` installs fresh from this, so it must not look like a bad read");
});

test("the real probes: a binary that is there but tells nothing is a build, reported as unreadable", () => {
  const PATH = pathWith("inspector", "exit 0");
  const probes = realInspectorVersionProbes("inspector", { PATH });
  const build = probes.build();
  assert.notEqual(build, null);
  // No `go` on that PATH, so its own build record cannot be read -
  // which is a state to report, not an absent Inspector to install over.
  assert.match(build?.unreadable ?? "", /go/);
});

test("a failed go install is reported, never thrown - the update must not die on it", () => {
  const PATH = pathWith("go", "echo 'go: module lookup disabled' >&2; exit 1");
  const result = goInstallInspector("4f297d8be50e4f5b24460b5813ca50729d6413f9", { PATH });
  assert.equal(result.ok, false);
  assert.match(result.message, /module lookup disabled/);
});

test("a go that is not there at all is reported too, not thrown", () => {
  const result = goInstallInspector("latest", { PATH: mkdtempSync(join(tmpdir(), "fabrica-empty-path-")) });
  assert.equal(result.ok, false);
  assert.ok(result.message.length > 0);
});

test("a successful go install reports what it printed", () => {
  const PATH = pathWith("go", "echo installed");
  const result = goInstallInspector("latest", { PATH });
  assert.equal(result.ok, true);
  assert.equal(result.message, "installed");
});

// The one spelling: what every message prints and what this actually
// runs are built from the same package path, so a fix the Client is told
// to run can never differ from the command `fabrica update` ran.
test("the printed install command and the argv that runs it are the same command", () => {
  for (const revision of ["latest", "4f297d8be50e4f5b24460b5813ca50729d6413f9"]) {
    assert.equal(inspectorInstallCommand(revision), `go ${inspectorInstallArgs(revision).join(" ")}`);
  }
});
