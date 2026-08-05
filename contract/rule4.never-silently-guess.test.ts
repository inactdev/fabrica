// CONTRACT rule 4 — It never guesses silently.
// A delivery missing confidence, assumptions, gaps, or evidence is
// malformed and must be rejected before the Client ever sees it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateDelivery } from "../src/index.ts";
import { makeFixtureRepo } from "./helpers/fixture.ts";

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

test("rule 4: a complete delivery is accepted", () => {
  assert.doesNotThrow(() => validateDelivery(complete));
});

for (const missing of ["confidence", "assumptions", "gaps", "evidence"] as const) {
  test(`rule 4: a delivery missing "${missing}" is rejected`, () => {
    const broken: Record<string, unknown> = { ...complete };
    delete broken[missing];
    assert.throws(
      () => validateDelivery(broken),
      new RegExp(missing),
      `delivery without "${missing}" was not rejected — rule 4 broken`
    );
  });
}

test("rule 4: a delivery whose files list disagrees with the actual diff is rejected", () => {
  const project = makeFixtureRepo();
  const workdir = join(project, "..", "wt-rule4-files-" + Math.random().toString(36).slice(2));
  execFileSync("git", ["worktree", "add", "-b", "feature-mismatch", workdir, "HEAD"], { cwd: project });
  writeFileSync(join(workdir, "app.txt"), "changed\n");
  execFileSync("git", ["add", "-A"], { cwd: workdir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "work"], { cwd: workdir });

  const mismatched = { ...complete, branch: "feature-mismatch", files: ["a-file-nobody-touched.txt"] };
  assert.throws(
    () => validateDelivery(mismatched, project),
    /files/,
    "delivery whose files list disagreed with the actual diff was not rejected — rule 4 broken"
  );
});
