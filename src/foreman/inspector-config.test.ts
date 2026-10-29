// Issue #306: a round's own refusal, asked of the commit the task was
// cut from. Two layers, like src/foreman/reviewer.test.ts: the gate
// itself, and the wiring into `prepareRound` - where an unwired gate
// would be a test that passes while nothing is actually checked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { fakeInspector } from "../../contract/helpers/fake-inspector.ts";
import { makeTestHome } from "../config/helpers/test-home.ts";
import { INSPECTOR_DOCKERFILE } from "../inspector/index.ts";
import { ForemanError } from "./errors.ts";
import { requireInspectorConfig } from "./inspector-config.ts";
import { prepareRound } from "./judge.ts";
import type { ProductionLine } from "../../contract/surface.ts";

function commit(dir: string, message: string): string {
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", message], { cwd: dir });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
}

/** A fixture repository whose committed config Inspector accepts: no
 * retired key, and a committed Dockerfile.inspector for the check box. */
function acceptableProject(): { project: string; baseCommit: string } {
  const project = makeFixtureRepo("exit 0");
  writeFileSync(join(project, ".inspector.json"), '{"check":"./check.sh"}\n');
  writeFileSync(join(project, INSPECTOR_DOCKERFILE), "FROM alpine\n");
  return { project, baseCommit: commit(project, "a box Inspector can build") };
}

/** The same repository with the key inspector#47 retired still in it. */
function retiredKeyProject(key: string): { project: string; baseCommit: string } {
  const project = makeFixtureRepo("exit 0");
  writeFileSync(join(project, ".inspector.json"), `{"check":"./check.sh","${key}":"alpine"}\n`);
  writeFileSync(join(project, INSPECTOR_DOCKERFILE), "FROM alpine\n");
  return { project, baseCommit: commit(project, `still naming ${key}`) };
}

test("requireInspectorConfig: a retired image key refuses the round, in Inspector's words", () => {
  const { project, baseCommit } = retiredKeyProject("image");

  assert.throws(
    () => requireInspectorConfig(project, baseCommit),
    (err: unknown) => {
      assert.ok(err instanceof ForemanError);
      assert.equal(err.code, "inspector-config-refused");
      assert.match(err.message, /still names an "image"/);
      // The Client's own hand change, named - Fabrica never makes it.
      assert.match(err.message, /remove the "image" field/);
      assert.match(err.message, /never edits \.inspector\.json/);
      // And it says plainly that this cost nothing.
      assert.match(err.message, /Nothing was started/);
      return true;
    }
  );
});

test("requireInspectorConfig: a retired network key refuses too", () => {
  const { project, baseCommit } = retiredKeyProject("network");

  assert.throws(
    () => requireInspectorConfig(project, baseCommit),
    (err: unknown) =>
      err instanceof ForemanError &&
      err.code === "inspector-config-refused" &&
      /still carries the "network" opt-in/.test(err.message)
  );
});

test("requireInspectorConfig: no committed Dockerfile.inspector refuses, naming the file", () => {
  const project = makeFixtureRepo("exit 0");
  writeFileSync(join(project, ".inspector.json"), '{"check":"./check.sh"}\n');
  const baseCommit = commit(project, "no box");

  assert.throws(
    () => requireInspectorConfig(project, baseCommit),
    (err: unknown) =>
      err instanceof ForemanError &&
      err.code === "inspector-config-refused" &&
      /commits no Dockerfile\.inspector/.test(err.message)
  );
});

test("requireInspectorConfig: a config Inspector accepts passes silently", () => {
  const { project, baseCommit } = acceptableProject();

  assert.equal(requireInspectorConfig(project, baseCommit), undefined);
});

test("requireInspectorConfig: a project with no .inspector.json has nothing to refuse", () => {
  const project = makeFixtureRepo("exit 0", { inspector: false });
  const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: project, encoding: "utf8" }).trim();

  // Such a task is self-tested and hands Inspector nothing at all, so a
  // missing Dockerfile.inspector is not a refusal here.
  assert.equal(requireInspectorConfig(project, baseCommit), undefined);
});

// The worker must never be able to clear this by editing the config it
// is judged under - the same rule `requireReviewer` follows for
// testPaths, and the reason both read the base commit.
test("requireInspectorConfig: fixing the config in the worktree does not clear the refusal", () => {
  const { project, baseCommit } = retiredKeyProject("image");
  writeFileSync(join(project, ".inspector.json"), '{"check":"./check.sh"}\n');

  assert.throws(
    () => requireInspectorConfig(project, baseCommit),
    (err: unknown) => err instanceof ForemanError && err.code === "inspector-config-refused"
  );
});

// ------------------------------------------------- wired into the round

/** Puts an executable named `inspector` on this process's PATH, so
 * `defaultInspector().installed()` answers true and `prepareRound` takes
 * the Inspector branch. Never run by these tests: the config gate
 * refuses, or `prepare()` does, before any handoff. */
function installFakeInspectorBinary(): void {
  const bin = join(makeTestHome(""), "bin");
  mkdirSync(bin, { recursive: true });
  const path = join(bin, "inspector");
  writeFileSync(path, "#!/bin/sh\nexit 2\n");
  chmodSync(path, 0o755);
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
}

function lineAt(project: string, recordHome: string): ProductionLine {
  return { workdir: project, branch: "fabrica/task-1", project, taskId: "task-1", recordHome };
}

test("prepareRound refuses the round before any worker starts", () => {
  installFakeInspectorBinary();
  const { project, baseCommit } = retiredKeyProject("image");
  const recordHome = makeTestHome("");

  assert.throws(
    () => prepareRound(recordHome, "task-1", lineAt(project, recordHome), baseCommit, {}),
    (err: unknown) => {
      assert.ok(err instanceof ForemanError);
      assert.equal(err.code, "inspector-config-refused");
      return true;
    }
  );
});

// The claim the gate makes is about the Inspector installed on this
// machine. A caller that supplies its own is judged by that one, whose
// refusals are its own - which is also what keeps every test that runs a
// round with a fake answering the same way on a machine with Inspector
// installed and one without.
test("prepareRound leaves a caller-supplied Inspector's own configuration alone", () => {
  installFakeInspectorBinary();
  const { project, baseCommit } = retiredKeyProject("image");
  const recordHome = makeTestHome("");

  const { mode } = prepareRound(recordHome, "task-1", lineAt(project, recordHome), baseCommit, {
    inspector: fakeInspector("green"),
  });

  assert.equal(mode.mode, "inspector");
});

// A project with no .inspector.json is self-tested, so there is no
// Inspector to refuse anything and nothing here may stop it.
test("prepareRound does not refuse a self-tested round", () => {
  installFakeInspectorBinary();
  const project = makeFixtureRepo("exit 0", { inspector: false });
  const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: project, encoding: "utf8" }).trim();
  const recordHome = makeTestHome("");

  const { mode } = prepareRound(recordHome, "task-1", lineAt(project, recordHome), baseCommit, {});

  assert.equal(mode.mode, "self-test");
});
