// The throwaway read-of-master checkout: cut from origin, detached, under
// recordHome/scratch/, and removed only through git's own worktree
// registry - the same guarantees ProductionLine's own create/destroy
// pair is held to, because this reuses them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { makeFixtureHome, makeFixtureProject } from "./helpers/fixture.ts";
import { createScratchCheckout, destroyScratchCheckout, scratchWorkdirPath } from "./scratch.ts";
import { createProductionLine } from "./cut.ts";
import { LineError } from "./errors.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("createScratchCheckout cuts origin's default branch, detached, with no branch of its own", () => {
  const project = makeFixtureProject();
  const recordHome = makeFixtureHome();
  const branchesBefore = git(project, "branch", "--list");

  const checkout = createScratchCheckout({ project, recordHome, label: "quiz-1" });
  try {
    assert.equal(checkout.workdir, scratchWorkdirPath(checkout.recordHome, "quiz-1"));
    assert.ok(existsSync(checkout.workdir), "the checkout is really on disk");
    assert.match(checkout.base, /^origin\//);
    assert.equal(checkout.baseCommit, git(project, "rev-parse", checkout.base));
    // Detached: git names no branch for this worktree, and the project
    // gained none.
    assert.equal(git(checkout.workdir, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD");
    assert.equal(git(project, "branch", "--list"), branchesBefore);
    // And it is nowhere near the folder tasks are discovered from.
    assert.ok(!checkout.workdir.includes(`${join(recordHome, "tasks")}`));
  } finally {
    destroyScratchCheckout(checkout);
  }
});

test("destroyScratchCheckout removes the worktree and is idempotent afterwards", () => {
  const project = makeFixtureProject();
  const recordHome = makeFixtureHome();
  const checkout = createScratchCheckout({ project, recordHome, label: "quiz-1" });

  assert.deepEqual(destroyScratchCheckout(checkout), { status: "destroyed" });
  assert.ok(!existsSync(checkout.workdir));
  assert.deepEqual(destroyScratchCheckout(checkout), { status: "already-destroyed" });
});

test("a leftover checkout from a killed run is replaced rather than blocking the next one", () => {
  const project = makeFixtureProject();
  const recordHome = makeFixtureHome();
  const first = createScratchCheckout({ project, recordHome, label: "quiz-1" });
  writeFileSync(join(first.workdir, "half-written.json"), "{");

  const second = createScratchCheckout({ project, recordHome, label: "quiz-1" });
  try {
    assert.equal(second.workdir, first.workdir);
    assert.ok(!existsSync(join(second.workdir, "half-written.json")), "the leftover is gone, not inherited");
  } finally {
    destroyScratchCheckout(second);
  }
});

test("a worker's file written into the checkout is readable on the host, and leaves the project alone", () => {
  // The whole reason this exists: the re-check round's worker answers by
  // writing a file into its own workdir.
  const project = makeFixtureProject();
  const recordHome = makeFixtureHome();
  const checkout = createScratchCheckout({ project, recordHome, label: "quiz-1" });
  try {
    writeFileSync(join(checkout.workdir, "quiz-recheck.json"), '{"verdicts":[]}');
    assert.equal(readFileSync(join(checkout.workdir, "quiz-recheck.json"), "utf8"), '{"verdicts":[]}');
    assert.ok(!existsSync(join(project, "quiz-recheck.json")), "the Client's own checkout is untouched");
  } finally {
    destroyScratchCheckout(checkout);
  }
});

test("a path that is not where this label's checkout belongs is refused, not deleted", () => {
  const project = makeFixtureProject();
  const recordHome = makeFixtureHome();
  const line = createProductionLine({ project, taskId: "20261022-real-task-aa", recordHome });

  assert.throws(
    () =>
      destroyScratchCheckout({
        label: "quiz-1",
        project,
        // A real ProductionLine's workdir, pointed at by a scratch
        // teardown call - exactly the mix-up this check exists for.
        workdir: line.workdir,
        recordHome: line.recordHome,
        base: "",
        baseCommit: "",
      }),
    (err: unknown) => {
      assert.ok(err instanceof LineError);
      assert.equal(err.code, "unsafe-teardown");
      return true;
    }
  );
  assert.ok(existsSync(line.workdir), "the line it was pointed at is still there");
});

test("a directory at the right path that git does not know about is refused rather than removed", () => {
  const project = makeFixtureProject();
  const recordHome = makeFixtureHome();
  const workdir = scratchWorkdirPath(recordHome, "quiz-1");
  mkdirSync(workdir, { recursive: true });
  writeFileSync(join(workdir, "someone-elses-file"), "hello");

  assert.throws(
    () => createScratchCheckout({ project, recordHome, label: "quiz-1" }),
    (err: unknown) => {
      assert.ok(err instanceof LineError);
      assert.equal(err.code, "unsafe-teardown");
      return true;
    }
  );
  assert.ok(existsSync(join(workdir, "someone-elses-file")), "nothing this module did not create is ever removed");
});

test("an unsafe label never becomes a path segment", () => {
  const project = makeFixtureProject();
  const recordHome = makeFixtureHome();
  for (const label of ["../escape", "quiz/../..", ""]) {
    assert.throws(
      () => createScratchCheckout({ project, recordHome, label }),
      (err: unknown) => {
        assert.ok(err instanceof LineError);
        assert.equal(err.code, "invalid-id");
        return true;
      }
    );
  }
});
