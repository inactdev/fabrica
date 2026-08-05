import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateDelivery } from "./validate.ts";
import { DeliveryError } from "./errors.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";

const complete = {
  outcome: "done",
  confidence: 85,
  summary: "added the export button",
  evidence: "./check.sh -> exit 0",
  assumptions: "dates are year-month-day",
  gaps: "no tests for empty lists",
  branch: "fabrica/20260803-export-ab",
  files: ["app.txt"],
  gateChanges: "",
};

test("a complete delivery is accepted", () => {
  assert.doesNotThrow(() => validateDelivery(complete));
});

test("an empty gateChanges/gaps/assumptions is not treated as missing", () => {
  assert.doesNotThrow(() => validateDelivery({ ...complete, gateChanges: "", gaps: "", assumptions: "" }));
});

test("an empty files array is not treated as missing", () => {
  assert.doesNotThrow(() => validateDelivery({ ...complete, files: [] }));
});

for (const field of [
  "outcome",
  "confidence",
  "summary",
  "evidence",
  "assumptions",
  "gaps",
  "branch",
  "files",
  "gateChanges",
] as const) {
  test(`a delivery missing "${field}" is rejected`, () => {
    const broken: Record<string, unknown> = { ...complete };
    delete broken[field];
    assert.throws(
      () => validateDelivery(broken),
      (err: unknown) => err instanceof DeliveryError && err.code === "malformed" && new RegExp(field).test(err.message)
    );
  });
}

test("an invalid outcome is rejected", () => {
  assert.throws(() => validateDelivery({ ...complete, outcome: "sort-of-done" }), /outcome/);
});

test("a non-numeric confidence is rejected", () => {
  assert.throws(() => validateDelivery({ ...complete, confidence: "85" }), /confidence/);
});

test("a files array with a non-string entry is rejected", () => {
  assert.throws(() => validateDelivery({ ...complete, files: ["app.txt", 42] }), /files/);
});

test("a non-object delivery is rejected", () => {
  assert.throws(() => validateDelivery(null));
  assert.throws(() => validateDelivery("not a delivery"));
});

function addWorktree(project: string, branch: string): string {
  const workdir = join(project, "..", "wt-" + Math.random().toString(36).slice(2));
  execFileSync("git", ["worktree", "add", "-b", branch, workdir, "HEAD"], { cwd: project });
  return workdir;
}

test("passing a project also checks files against the branch's real diff, and accepts a match", () => {
  const project = makeFixtureRepo();
  const workdir = addWorktree(project, "feature");
  writeFileSync(join(workdir, "app.txt"), "changed\n");
  execFileSync("git", ["add", "-A"], { cwd: workdir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "work"], { cwd: workdir });

  assert.doesNotThrow(() => validateDelivery({ ...complete, branch: "feature", files: ["app.txt"] }, project));
});

test("passing a project rejects a files list the branch's real diff disagrees with", () => {
  const project = makeFixtureRepo();
  addWorktree(project, "feature");

  assert.throws(
    () => validateDelivery({ ...complete, branch: "feature", files: ["app.txt"] }, project),
    (err: unknown) => err instanceof DeliveryError && err.code === "files-mismatch"
  );
});

test("omitting project skips the files-vs-diff check entirely", () => {
  // "feature" doesn't exist in any repo at all here - proof that no diff is attempted.
  assert.doesNotThrow(() => validateDelivery({ ...complete, branch: "feature" }));
});
