// Issue #235: the host-side rebase that brings a task's branch up to
// origin's current default branch. Every test here drives real git
// against real throwaway repositories - a rebase is the one operation in
// this module that rewrites commits, so "it did what git would do" is
// the only assertion worth making about it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createProductionLine } from "./cut.ts";
import { destroyProductionLine } from "./teardown.ts";
import {
  abortRebase,
  finishRebase,
  MAX_CONFLICT_LINES_PER_FILE,
  MAX_CONFLICT_LINES_TOTAL,
  rebaseInProgress,
  rebaseOntoOriginDefault,
} from "./rebase.ts";
import { LineError } from "./errors.ts";
import { makeFixtureHome, makeFixtureProject } from "./helpers/fixture.ts";
import { pushToOrigin } from "../../contract/helpers/fixture.ts";

function commitAll(dir: string, message: string): void {
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", message], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function head(dir: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
}

/** A project with a task line cut from origin's tip, ready for either
 * side to move. */
function setUp(): { project: string; recordHome: string; line: ReturnType<typeof createProductionLine> } {
  const project = makeFixtureProject("exit 0");
  const recordHome = makeFixtureHome();
  const line = createProductionLine({ project, taskId: "rebase-task", recordHome });
  return { project, recordHome, line };
}

/** Moves origin's default branch on, through the project's own checkout. */
function advanceOrigin(project: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) writeFileSync(join(project, name), content);
  commitAll(project, "origin moves on");
  pushToOrigin(project);
}

test("a branch that already contains origin's tip is reported current and nothing is rewritten", () => {
  const { line } = setUp();
  writeFileSync(join(line.workdir, "task.txt"), "task work\n");
  commitAll(line.workdir, "task work");
  const before = head(line.workdir);

  const outcome = rebaseOntoOriginDefault(line, { onConflict: "abort" });

  assert.equal(outcome.status, "already-current");
  assert.equal(head(line.workdir), before, "the branch's own commit was rewritten for no reason");
  destroyProductionLine(line);
});

test("a branch behind origin is replayed on top of origin's new tip", () => {
  const { project, line } = setUp();
  writeFileSync(join(line.workdir, "task.txt"), "task work\n");
  commitAll(line.workdir, "task work");
  advanceOrigin(project, { "origin.txt": "origin work\n" });

  const outcome = rebaseOntoOriginDefault(line, { onConflict: "abort" });

  assert.equal(outcome.status, "rebased");
  assert.equal(
    outcome.baseCommit,
    execFileSync("git", ["rev-parse", `refs/remotes/origin/${outcome.base}`], {
      cwd: project,
      encoding: "utf8",
    }).trim()
  );
  // The task's own commit is now a child of origin's tip, and both sides'
  // files are present in the worktree.
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD^"], { cwd: line.workdir, encoding: "utf8" }).trim(),
    outcome.baseCommit
  );
  assert.equal(readFileSync(join(line.workdir, "task.txt"), "utf8"), "task work\n");
  assert.equal(readFileSync(join(line.workdir, "origin.txt"), "utf8"), "origin work\n");
  assert.equal(rebaseInProgress(line.workdir), false);
  destroyProductionLine(line);
});

test("a conflict with onConflict abort leaves the branch exactly where it was, and reports the markers", () => {
  const { project, line } = setUp();
  writeFileSync(join(line.workdir, "shared.txt"), "the task's version\n");
  commitAll(line.workdir, "task work");
  const before = head(line.workdir);
  advanceOrigin(project, { "shared.txt": "origin's version\n" });

  const outcome = rebaseOntoOriginDefault(line, { onConflict: "abort" });

  assert.equal(outcome.status, "conflicted");
  assert.equal(outcome.left, "aborted");
  assert.deepEqual(outcome.conflict?.files, ["shared.txt"]);
  assert.match(outcome.conflict!.markers, /--- shared\.txt \(1 conflict hunk\)/);
  assert.match(outcome.conflict!.markers, /^<{7}/m);
  assert.match(outcome.conflict!.markers, /^={7}$/m);
  assert.match(outcome.conflict!.markers, /^>{7}/m);
  assert.match(outcome.conflict!.markers, /the task's version/);
  assert.match(outcome.conflict!.markers, /origin's version/);
  assert.equal(outcome.conflict!.truncated, false);

  assert.equal(rebaseInProgress(line.workdir), false, "a rebase was left in flight");
  assert.equal(head(line.workdir), before, "the branch did not go back to its pre-rebase commit");
  assert.equal(readFileSync(join(line.workdir, "shared.txt"), "utf8"), "the task's version\n");
  destroyProductionLine(line);
});

test("a conflict with onConflict stop leaves the rebase in progress with the markers in the working tree", () => {
  const { project, line } = setUp();
  writeFileSync(join(line.workdir, "shared.txt"), "the task's version\n");
  commitAll(line.workdir, "task work");
  advanceOrigin(project, { "shared.txt": "origin's version\n" });

  const outcome = rebaseOntoOriginDefault(line, { onConflict: "stop" });

  assert.equal(outcome.status, "conflicted");
  assert.equal(outcome.left, "stopped");
  assert.equal(rebaseInProgress(line.workdir), true);
  assert.match(readFileSync(join(line.workdir, "shared.txt"), "utf8"), /^<{7}/m);

  abortRebase(line.workdir);
  assert.equal(rebaseInProgress(line.workdir), false);
  destroyProductionLine(line);
});

test("finishRebase stages a resolved conflict and completes the rebase", () => {
  const { project, line } = setUp();
  writeFileSync(join(line.workdir, "shared.txt"), "the task's version\n");
  commitAll(line.workdir, "task work");
  advanceOrigin(project, { "shared.txt": "origin's version\n" });
  const outcome = rebaseOntoOriginDefault(line, { onConflict: "stop" });
  assert.equal(outcome.status, "conflicted");

  // Exactly what a worker can do: edit the file. It never runs git.
  writeFileSync(join(line.workdir, "shared.txt"), "both versions, reconciled\n");

  assert.deepEqual(finishRebase(line.workdir), { status: "completed" });
  assert.equal(rebaseInProgress(line.workdir), false);
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD^"], { cwd: line.workdir, encoding: "utf8" }).trim(),
    outcome.baseCommit,
    "the task's commit is not sitting on origin's tip"
  );
  assert.equal(readFileSync(join(line.workdir, "shared.txt"), "utf8"), "both versions, reconciled\n");
  assert.equal(
    execFileSync("git", ["status", "--porcelain"], { cwd: line.workdir, encoding: "utf8" }).trim(),
    "",
    "the resolution was not committed"
  );
  destroyProductionLine(line);
});

test("finishRebase refuses to stage a file that still has markers, and names it", () => {
  const { project, line } = setUp();
  writeFileSync(join(line.workdir, "shared.txt"), "the task's version\n");
  commitAll(line.workdir, "task work");
  advanceOrigin(project, { "shared.txt": "origin's version\n" });
  rebaseOntoOriginDefault(line, { onConflict: "stop" });

  const finished = finishRebase(line.workdir);

  assert.equal(finished.status, "conflicted");
  assert.equal(finished.status === "conflicted" && finished.reason, "markers-remain");
  assert.deepEqual(finished.status === "conflicted" ? finished.conflict.files : [], ["shared.txt"]);
  assert.equal(rebaseInProgress(line.workdir), true, "finishRebase must leave the abort to its caller");
  // Nothing was committed: the markers are still only in the working tree.
  assert.equal(
    execFileSync("git", ["log", "--oneline", "-1", "--format=%s"], { cwd: line.workdir, encoding: "utf8" }).trim(),
    "origin moves on"
  );

  abortRebase(line.workdir);
  destroyProductionLine(line);
});

test("a resolution identical to the upstream side drops the now-redundant commit instead of failing", () => {
  const { project, line } = setUp();
  writeFileSync(join(line.workdir, "shared.txt"), "the task's version\n");
  commitAll(line.workdir, "task work");
  advanceOrigin(project, { "shared.txt": "origin's version\n" });
  const outcome = rebaseOntoOriginDefault(line, { onConflict: "stop" });

  // "Take theirs wholesale" is a legitimate resolution, and it leaves the
  // replayed commit with nothing to record.
  writeFileSync(join(line.workdir, "shared.txt"), "origin's version\n");

  assert.deepEqual(finishRebase(line.workdir), { status: "completed" });
  assert.equal(head(line.workdir), outcome.baseCommit, "the empty commit was kept instead of skipped");
  destroyProductionLine(line);
});

test("a conflict longer than the per-file cap is cut, and says so", () => {
  const { project, line } = setUp();
  const lines = (label: string) => Array.from({ length: 300 }, (_, i) => `${label} line ${i}`).join("\n") + "\n";
  writeFileSync(join(line.workdir, "big.txt"), lines("task"));
  commitAll(line.workdir, "task work");
  advanceOrigin(project, { "big.txt": lines("origin") });

  const outcome = rebaseOntoOriginDefault(line, { onConflict: "abort" });

  assert.equal(outcome.status, "conflicted");
  assert.equal(outcome.conflict!.truncated, true);
  assert.match(outcome.conflict!.markers, /\[cut: \d+ of \d+ marker lines in big\.txt not shown/);
  assert.match(
    outcome.conflict!.markers,
    new RegExp(`cap: ${MAX_CONFLICT_LINES_PER_FILE} lines per file, ${MAX_CONFLICT_LINES_TOTAL} in total`)
  );
  // The cut applies to the quoted hunk, not to the file list.
  const quoted = outcome.conflict!.markers.split("\n").filter((l) => !l.startsWith("[") && !l.startsWith("---"));
  assert.equal(quoted.length, MAX_CONFLICT_LINES_PER_FILE);
  destroyProductionLine(line);
});

test("a report that reaches the total cap says how many more files it left out", () => {
  const { project, line } = setUp();
  // Each file's conflict is longer than the per-file cap, so each
  // contributes exactly that cap - more files than the total cap allows.
  const count = MAX_CONFLICT_LINES_TOTAL / MAX_CONFLICT_LINES_PER_FILE + 1;
  const lines = (label: string) =>
    Array.from({ length: MAX_CONFLICT_LINES_PER_FILE + 10 }, (_, i) => `${label} ${i}`).join("\n") + "\n";
  const taskSide: Record<string, string> = {};
  const originSide: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    taskSide[`f${i}.txt`] = lines("task");
    originSide[`f${i}.txt`] = lines("origin");
  }
  for (const [name, content] of Object.entries(taskSide)) writeFileSync(join(line.workdir, name), content);
  commitAll(line.workdir, "task work");
  advanceOrigin(project, originSide);

  const outcome = rebaseOntoOriginDefault(line, { onConflict: "abort" });

  assert.equal(outcome.status, "conflicted");
  assert.equal(outcome.conflict!.files.length, count, "every conflicted file is still named in the file list");
  assert.equal(outcome.conflict!.truncated, true);
  assert.match(outcome.conflict!.markers, /\[cut: 1 more conflicted file not shown/);
  destroyProductionLine(line);
});

test("a binary conflict is named rather than quoted", () => {
  const { project, line } = setUp();
  writeFileSync(join(line.workdir, "blob.bin"), Buffer.from([0, 1, 2, 3, 0]));
  commitAll(line.workdir, "task work");
  writeFileSync(join(project, "blob.bin"), Buffer.from([9, 0, 9, 0, 9]));
  commitAll(project, "origin moves on");
  pushToOrigin(project);

  const outcome = rebaseOntoOriginDefault(line, { onConflict: "abort" });

  assert.equal(outcome.status, "conflicted");
  assert.deepEqual(outcome.conflict!.files, ["blob.bin"]);
  assert.match(outcome.conflict!.markers, /\[binary file - it carries no text conflict markers\]/);
  destroyProductionLine(line);
});

test("rebasing refuses a worktree git does not hold on this line's own branch", () => {
  const { project, recordHome, line } = setUp();
  execFileSync("git", ["checkout", "-q", "--detach"], { cwd: line.workdir, stdio: ["ignore", "pipe", "pipe"] });

  assert.throws(
    () => rebaseOntoOriginDefault(line, { onConflict: "abort" }),
    (err: unknown) => err instanceof LineError && err.code === "unsafe-rebase"
  );

  // And the Client's own checkout is never a rebasable line, whatever it
  // is asked to believe.
  assert.throws(
    () => rebaseOntoOriginDefault({ ...line, workdir: project }, { onConflict: "abort" }),
    (err: unknown) => err instanceof LineError && err.code === "unsafe-teardown"
  );
  assert.equal(recordHome.length > 0, true);
  destroyProductionLine(line);
});

test("rebasing refuses a worktree that already has a rebase in flight", () => {
  const { project, line } = setUp();
  writeFileSync(join(line.workdir, "shared.txt"), "the task's version\n");
  commitAll(line.workdir, "task work");
  advanceOrigin(project, { "shared.txt": "origin's version\n" });
  rebaseOntoOriginDefault(line, { onConflict: "stop" });

  assert.throws(
    () => rebaseOntoOriginDefault(line, { onConflict: "abort" }),
    (err: unknown) => err instanceof LineError && err.code === "unsafe-rebase"
  );

  abortRebase(line.workdir);
  destroyProductionLine(line);
});
