import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateDeliveryFiles } from "./validate-files.ts";
import { DeliveryError } from "./errors.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import type { Delivery } from "../../contract/surface.ts";

function commitAll(cwd: string, message: string): void {
  execFileSync("git", ["add", "-A"], { cwd });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", message], { cwd });
}

function baseDelivery(overrides: Partial<Delivery>): Delivery {
  return {
    outcome: "done",
    confidence: 100,
    summary: "did the thing",
    evidence: "check.sh -> exit 0",
    assumptions: "",
    gaps: "",
    branch: "feature",
    files: [],
    gateChanges: "",
    ...overrides,
  };
}

// Mirrors how the real system branches: a linked worktree on a new branch,
// project's own checkout (and its HEAD) left exactly where it was.
function addWorktree(project: string, branch: string): string {
  const workdir = join(project, "..", "wt-" + Math.random().toString(36).slice(2));
  execFileSync("git", ["worktree", "add", "-b", branch, workdir, "HEAD"], { cwd: project });
  return workdir;
}

test("a delivery whose files list matches the branch's real diff is accepted", () => {
  const project = makeFixtureRepo();
  const workdir = addWorktree(project, "feature");
  writeFileSync(join(workdir, "app.txt"), "changed\n");
  commitAll(workdir, "work");

  assert.doesNotThrow(() => validateDeliveryFiles(baseDelivery({ files: ["app.txt"] }), project));
});

test("a delivery claiming a file the branch never touched is rejected", () => {
  const project = makeFixtureRepo();
  const workdir = addWorktree(project, "feature");
  writeFileSync(join(workdir, "app.txt"), "changed\n");
  commitAll(workdir, "work");

  assert.throws(
    () => validateDeliveryFiles(baseDelivery({ files: ["app.txt", "invented.txt"] }), project),
    (err: unknown) => err instanceof DeliveryError && err.code === "files-mismatch"
  );
});

test("a delivery silently omitting a file the branch did touch is rejected", () => {
  const project = makeFixtureRepo();
  const workdir = addWorktree(project, "feature");
  writeFileSync(join(workdir, "app.txt"), "changed\n");
  writeFileSync(join(workdir, "extra.txt"), "extra\n");
  commitAll(workdir, "work");

  assert.throws(
    () => validateDeliveryFiles(baseDelivery({ files: ["app.txt"] }), project),
    (err: unknown) => err instanceof DeliveryError && err.code === "files-mismatch"
  );
});

test("an empty files list against an untouched branch is accepted", () => {
  const project = makeFixtureRepo();
  addWorktree(project, "feature");

  assert.doesNotThrow(() => validateDeliveryFiles(baseDelivery({ files: [] }), project));
});
