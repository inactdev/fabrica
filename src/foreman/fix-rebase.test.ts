// Issue #235: what the Client sees when a fix round's host-side rebase
// succeeds, is unnecessary, or conflicts. The git mechanics have their own
// tests (src/line/rebase.test.ts); these drive the whole loop through
// `createForeman`, because the thing worth proving here is the policy -
// that one conflicted rebase costs him exactly one round, what the worker
// is told in it, and what the branch is left at whichever way it ends.

import { test } from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "./foreman.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { makeFixtureRepo, pushToOrigin } from "../../contract/helpers/fixture.ts";
import { fixtureInspector } from "../../contract/helpers/fake-inspector.ts";
import { latestDeliveredDetails, stateOf } from "./queries.ts";
import { readEventsForTask } from "../record/index.ts";
import { createProductionLine, destroyProductionLine, rebaseInProgress } from "../line/index.ts";
import {
  continueStoppedRebase,
  MAX_REBASE_STOPS_PER_ROUND,
  publishLeaseAfterRebase,
  rebaseForFixRound,
} from "./fix-rebase.ts";
import type { Inspector } from "../inspector/index.ts";

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-fix-rebase-home-"));
}

function branchHead(project: string, taskId: string): string {
  return execFileSync("git", ["rev-parse", `fabrica/${taskId}`], { cwd: project, encoding: "utf8" }).trim();
}

function originTip(project: string): string {
  return execFileSync("git", ["rev-parse", "refs/remotes/origin/master"], { cwd: project, encoding: "utf8" }).trim();
}

/** Moves origin's default branch on, through the project's own checkout -
 * exactly the situation a fix round ruled days after the task ran lands
 * in. */
function advanceOrigin(project: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) writeFileSync(join(project, name), content);
  execFileSync("git", ["add", "-A"], { cwd: project, stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "origin moves on"], {
    cwd: project,
    stdio: ["ignore", "pipe", "pipe"],
  });
  pushToOrigin(project);
}

/** The `"rebase-conflicted"` events a task's record carries, in order. */
interface ConflictEventDetails {
  base?: string;
  baseCommit?: string;
  files?: string[];
  stop?: number;
  left?: string;
  reason?: string;
}

function conflictEvents(recordHome: string, taskId: string): ConflictEventDetails[] {
  return readEventsForTask(recordHome, taskId)
    .filter((e) => e.name === "rebase-conflicted")
    .map((e) => e.details as ConflictEventDetails);
}

/** Inspector's publish, as far as these tests need it: the task's branch
 * reaches origin. Fabrica never pushes - Inspector owns that - so a test
 * that wants a published branch to lease against does it itself. Returns
 * the commit origin's copy now sits at. */
function publishBranch(project: string, taskId: string): string {
  execFileSync("git", ["push", "-q", "origin", `fabrica/${taskId}`], { cwd: project, stdio: ["ignore", "pipe", "pipe"] });
  return branchHead(project, taskId);
}

/** A green Inspector that records the expected tip of every handoff -
 * inspector#53's flag, as the publishing side actually receives it. */
function leaseRecordingInspector(): Inspector & {
  readonly calls: { branch: string; expectedTip?: string }[];
} {
  const calls: { branch: string; expectedTip?: string }[] = [];
  return {
    calls,
    installed: () => true,
    async inspect(request) {
      calls.push({ branch: request.branch, expectedTip: request.expectedTip });
      return { verdict: "green", report: "fake Inspector: green" };
    },
  };
}

/** The `"inspector-called"` events a task's record carries, in order. */
interface InspectorCalledDetails {
  branch?: string;
  expectedTip?: string;
  localTipBeforeRebase?: string;
}

function inspectorCalls(recordHome: string, taskId: string): InspectorCalledDetails[] {
  return readEventsForTask(recordHome, taskId)
    .filter((e) => e.name === "inspector-called")
    .map((e) => e.details as InspectorCalledDetails);
}

/** A worker resolving markers in place, with no git of its own: writes
 * `resolution` into any file that still holds a conflict marker. */
function resolveMarkers(workdir: string, files: string[], resolution: string): string[] {
  const resolved: string[] = [];
  for (const name of files) {
    const path = join(workdir, name);
    if (existsSync(path) && readFileSync(path, "utf8").includes("<<<<<<<")) {
      writeFileSync(path, resolution);
      resolved.push(name);
    }
  }
  return resolved;
}

test("a fix round rebases the task's branch onto origin's current default branch before its worker runs", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");
  const seen: string[] = [];
  let round = 0;
  const brain = fakeBrain({
    onWork: (_brief, workdir) => {
      round += 1;
      // What the worker can actually see of origin's new commit.
      try {
        seen.push(readFileSync(join(workdir, "origin.txt"), "utf8").trim());
      } catch {
        seen.push("(no origin.txt)");
      }
      writeFileSync(join(workdir, "task.txt"), `round ${round}\n`);
    },
  });
  const foreman = createForeman({ recordHome, inspector: fixtureInspector() });
  const task = await foreman.do("small change", { project, brain });

  advanceOrigin(project, { "origin.txt": "origin work\n" });
  await foreman.verdict(task.id, "fix", "one more tweak");

  assert.deepEqual(seen, ["(no origin.txt)", "origin work"], "the fix round's worker did not see origin's new commit");
  // Origin's tip is the branch's fork point now, so `files` stays the
  // task's own work rather than listing everything origin changed.
  const details = latestDeliveredDetails(recordHome, task.id);
  assert.equal(details?.baseCommit, originTip(project));
  assert.deepEqual(details?.delivery?.files, ["task.txt"]);
  assert.equal(details?.outcome, "done");
  assert.deepEqual(conflictEvents(recordHome, task.id), []);
});

test("a fix round whose branch already contains origin's tip is not rebased at all", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");
  let version = 0;
  const brain = fakeBrain({
    onWork: (_brief, workdir) => writeFileSync(join(workdir, "task.txt"), `v${++version}\n`),
  });
  const foreman = createForeman({ recordHome, inspector: fixtureInspector() });
  const task = await foreman.do("small change", { project, brain });
  const firstBase = latestDeliveredDetails(recordHome, task.id)?.baseCommit;
  const firstHead = branchHead(project, task.id);

  await foreman.verdict(task.id, "fix", "one more tweak");

  const details = latestDeliveredDetails(recordHome, task.id);
  assert.equal(details?.baseCommit, firstBase, "the base commit moved with nothing to rebase onto");
  assert.equal(
    execFileSync("git", ["rev-parse", `fabrica/${task.id}^`], { cwd: project, encoding: "utf8" }).trim(),
    firstHead,
    "the branch's existing commit was rewritten for no reason"
  );
  assert.equal(details?.outcome, "done");
});

test("a conflicting rebase is handed to that same round's worker, with the Client's note, and the host finishes it", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");
  const briefs: string[] = [];
  const brain = fakeBrain({
    onWork: (brief, workdir) => {
      briefs.push(brief);
      if (resolveMarkers(workdir, ["shared.txt"], "both versions, reconciled\n").length === 0) {
        writeFileSync(join(workdir, "shared.txt"), "the task's version\n");
      }
    },
  });
  const foreman = createForeman({ recordHome, inspector: fixtureInspector() });
  const task = await foreman.do("small change", { project, brain });
  const callsAfterFirstRound = brain.calls;

  advanceOrigin(project, { "shared.txt": "origin's version\n" });
  const tip = originTip(project);
  await foreman.verdict(task.id, "fix", "keep both sides, origin's wording wins on the first line");

  // One round, one worker call: the conflict was never reported back for
  // a second ruling before anything was tried.
  assert.equal(brain.calls, callsAfterFirstRound + 1);
  const conflictBrief = briefs.at(-1)!;
  assert.match(conflictBrief, /keep both sides, origin's wording wins/);
  assert.match(conflictBrief, /the rebase stopped on a conflict/);
  assert.match(conflictBrief, /- shared\.txt/);
  assert.match(conflictBrief, /Do not run any git command: your git is read-only here/);

  const delivery = await foreman.deliveryOf(task.id);
  assert.equal(delivery?.outcome, "done", delivery?.summary);
  // The rebase really happened: the task's commit now sits on origin's tip.
  assert.equal(
    execFileSync("git", ["rev-parse", `fabrica/${task.id}^`], { cwd: project, encoding: "utf8" }).trim(),
    tip
  );
  assert.equal(latestDeliveredDetails(recordHome, task.id)?.baseCommit, tip);
  assert.deepEqual(delivery!.files, ["shared.txt"]);
  assert.equal(latestDeliveredDetails(recordHome, task.id)?.rebaseConflict, undefined);
  assert.equal(readFileSync(join(project, "shared.txt"), "utf8"), "origin's version\n", "the project was touched");

  // One stop, handed over rather than aborted.
  assert.deepEqual(conflictEvents(recordHome, task.id), [
    { base: "master", baseCommit: tip, files: ["shared.txt"], stop: 1, left: "stopped" },
  ]);
});

test("a later commit of the same rebase conflicting again goes back to the same warm worker, in the same round", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");
  const briefs: string[] = [];
  const sessions: (string | undefined)[] = [];
  let round = 0;
  const brain = fakeBrain({
    onWork: (brief, workdir) => {
      briefs.push(brief);
      round += 1;
      // Rounds 1 and 2 build a two-commit branch, one file each; every
      // later call is a conflict pass and only resolves markers.
      if (round === 1) writeFileSync(join(workdir, "one.txt"), "the task's one\n");
      else if (round === 2) writeFileSync(join(workdir, "two.txt"), "the task's two\n");
      else resolveMarkers(workdir, ["one.txt", "two.txt"], "reconciled\n");
    },
  });
  const foreman = createForeman({ recordHome, inspector: fixtureInspector() });
  const task = await foreman.do("small change", { project, brain });
  await foreman.verdict(task.id, "fix", "add the second half");
  const callsBefore = brain.calls;

  // Origin now disagrees with both of the branch's commits, so the rebase
  // stops twice: once replaying each.
  advanceOrigin(project, { "one.txt": "origin's one\n", "two.txt": "origin's two\n" });
  const tip = originTip(project);
  await foreman.verdict(task.id, "fix", "reconcile with origin");

  assert.equal(brain.calls, callsBefore + 2, "the second stop did not go back to the worker in the same round");
  for (const options of brain.workOptions.slice(callsBefore)) {
    sessions.push(options?.session);
  }
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0], sessions[1], "the second pass started a cold worker instead of the warm one");
  assert.match(briefs.at(-1)!, /stopped again on a later commit of the same rebase \(stop 2 of at most 5/);
  assert.match(briefs.at(-1)!, /reconcile with origin/);

  const delivery = await foreman.deliveryOf(task.id);
  assert.equal(delivery?.outcome, "done", delivery?.summary);
  assert.equal(
    execFileSync("git", ["rev-parse", `fabrica/${task.id}~2`], { cwd: project, encoding: "utf8" }).trim(),
    tip,
    "both of the branch's commits were not replayed onto origin's tip"
  );
  assert.equal(latestDeliveredDetails(recordHome, task.id)?.baseCommit, tip);
  assert.deepEqual(
    conflictEvents(recordHome, task.id).map((e) => [e.stop, e.left, e.reason]),
    [
      [1, "stopped", undefined],
      [2, "stopped", "new-conflict"],
    ]
  );
  // Both conflict passes are on the record as real attempts of this one
  // round, each with its own receipt, so nothing about what was spent
  // goes missing between them.
  const receipts = await foreman.receiptsOf(task.id);
  assert.equal(receipts.length, 4);
  assert.deepEqual(
    receipts.map((r) => r.attempt),
    [1, 2, 3, 4]
  );
  // Issue #68: the event carries THIS round's receipts - both of its
  // passes - and the task's cumulative count as a number, instead of
  // re-storing the earlier round's receipts a second time.
  const delivered = latestDeliveredDetails(recordHome, task.id);
  assert.deepEqual(
    delivered?.receipts?.map((r) => r.attempt),
    [3, 4]
  );
  assert.equal(delivered?.attemptsSoFar, 4);
});

test("a worker that leaves markers behind is inspection-red, with the branch back where it was", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");
  let resolve = true;
  const brain = fakeBrain({
    onWork: (_brief, workdir) => {
      // The fix round touches nothing, so the markers stay exactly where
      // the stopped rebase left them.
      if (resolve) writeFileSync(join(workdir, "shared.txt"), "the task's version\n");
    },
  });
  const foreman = createForeman({ recordHome, inspector: fixtureInspector() });
  const task = await foreman.do("small change", { project, brain });
  resolve = false;
  const headBeforeFix = branchHead(project, task.id);
  const callsBefore = brain.calls;

  advanceOrigin(project, { "shared.txt": "origin's version\n" });
  await foreman.verdict(task.id, "fix", "bring it up to date");

  assert.equal(brain.calls, callsBefore + 1, "the worker was not handed the stopped rebase");
  const delivery = await foreman.deliveryOf(task.id);
  assert.equal(delivery?.outcome, "inspection-red");
  assert.match(delivery!.summary, /still conflicts in 1 file after the worker's attempt/);
  assert.match(delivery!.evidence, /Conflicted files:\n {2}shared\.txt/);
  assert.match(delivery!.evidence, /^<{7}/m);
  assert.match(delivery!.evidence, /the task's version/);
  assert.match(delivery!.evidence, /origin's version/);
  assert.match(delivery!.gaps, /Nothing was rewritten/);
  assert.match(delivery!.gaps, /did not resolve every marker/);
  // No Inspector ran, so the delivery must not claim one did.
  assert.equal(delivery!.inspection, undefined);

  assert.equal(branchHead(project, task.id), headBeforeFix, "the half-rebased branch was left behind");
  assert.equal(latestDeliveredDetails(recordHome, task.id)?.baseCommit !== undefined, true);
  // Still rulable: the Client can try again with a better note.
  assert.equal((await foreman.status()).find((t) => t.id === task.id)?.state, "delivered");
  assert.deepEqual(latestDeliveredDetails(recordHome, task.id)?.rebaseConflict?.files, ["shared.txt"]);
  // That round's own attempt is on the record as a real, failed attempt.
  const receipts = await foreman.receiptsOf(task.id);
  assert.equal(receipts.at(-1)?.outcome, "failed");
  assert.equal(receipts.at(-1)?.checks, null, "nothing judged an attempt whose rebase never finished");
  assert.deepEqual(
    conflictEvents(recordHome, task.id).map((e) => [e.stop, e.left, e.reason]),
    [
      [1, "stopped", undefined],
      [1, "aborted", "markers-remain"],
    ]
  );
});

test("a conflict markers check looks at the working tree, not only at what git still calls unmerged", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");
  let round = 0;
  const brain = fakeBrain({
    onWork: (_brief, workdir) => {
      round += 1;
      if (round === 1) {
        writeFileSync(join(workdir, "shared.txt"), "the task's version\n");
        return;
      }
      // A worker that "resolved" by leaving one marker line in place.
      writeFileSync(join(workdir, "shared.txt"), "reconciled\n>>>>>>> origin's version\n");
    },
  });
  const foreman = createForeman({ recordHome, inspector: fixtureInspector() });
  const task = await foreman.do("small change", { project, brain });

  advanceOrigin(project, { "shared.txt": "origin's version\n" });
  await foreman.verdict(task.id, "fix", "resolve the conflict");

  const delivery = await foreman.deliveryOf(task.id);
  assert.equal(delivery?.outcome, "inspection-red", "a leftover marker was committed onto the branch");
  assert.match(delivery!.evidence, />{7} origin's version/);
});

test("a spending cap stopping the round underneath a stopped rebase aborts it, and the report says so", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");
  let round = 0;
  const brain = fakeBrain({
    // Free while the two-commit branch is built, then a pass that takes
    // the task past its cap.
    costUsd: (call) => (call <= 2 ? 0 : 1),
    onWork: (_brief, workdir) => {
      round += 1;
      if (round === 1) writeFileSync(join(workdir, "one.txt"), "the task's one\n");
      else if (round === 2) writeFileSync(join(workdir, "two.txt"), "the task's two\n");
      else resolveMarkers(workdir, ["one.txt", "two.txt"], "reconciled\n");
    },
  });
  const foreman = createForeman({ recordHome, inspector: fixtureInspector(), caps: { perTaskUsd: 0.5 } });
  const task = await foreman.do("small change", { project, brain });
  await foreman.verdict(task.id, "fix", "add the second half");
  const headBeforeFix = branchHead(project, task.id);
  const callsBefore = brain.calls;

  advanceOrigin(project, { "one.txt": "origin's one\n", "two.txt": "origin's two\n" });
  await foreman.verdict(task.id, "fix", "reconcile with origin");

  // The cap stopped the loop after the first conflict pass, so the second
  // stop was never handed back and the branch is where it was.
  assert.equal(brain.calls, callsBefore + 1, "the worker was called again after a cap stopped the round");
  assert.equal(branchHead(project, task.id), headBeforeFix, "a half-rebased branch was left behind");
  const delivery = await foreman.deliveryOf(task.id);
  assert.equal(delivery?.outcome, "inspection-red");
  assert.match(delivery!.summary, /was still unfinished when this round stopped/);
  assert.match(delivery!.gaps, /This round stopped for a reason of its own/);
  assert.match(delivery!.gaps, /Nothing was rewritten/);
  assert.deepEqual(
    conflictEvents(recordHome, task.id).map((e) => [e.stop, e.left, e.reason]),
    [
      [1, "stopped", undefined],
      [2, "stopped", "new-conflict"],
      [2, "aborted", "round-ended"],
    ]
  );
  // Rule 10 still has its own say on the record, unchanged.
  assert.equal(
    readEventsForTask(recordHome, task.id).some((e) => e.name === "cap-stopped"),
    true
  );
});

test("a round that dies while the rebase is stopped leaves no rebase behind, and says so", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");
  let fail = false;
  const brain = fakeBrain({
    onWork: (_brief, workdir) => {
      if (fail) throw new Error("the brain is unreachable");
      writeFileSync(join(workdir, "shared.txt"), "the task's version\n");
    },
  });
  const foreman = createForeman({ recordHome, inspector: fixtureInspector() });
  const task = await foreman.do("small change", { project, brain });
  const headBeforeFix = branchHead(project, task.id);
  fail = true;

  advanceOrigin(project, { "shared.txt": "origin's version\n" });
  await assert.rejects(() => foreman.verdict(task.id, "fix", "bring it up to date"), /the brain is unreachable/);

  // The branch is where it was, the task failed honestly, and the record
  // says the stopped rebase was abandoned rather than left for a later
  // round to trip over.
  assert.equal(branchHead(project, task.id), headBeforeFix);
  assert.equal(stateOf(readEventsForTask(recordHome, task.id)), "failed");
  assert.deepEqual(
    conflictEvents(recordHome, task.id).map((e) => [e.stop, e.left, e.reason]),
    [
      [1, "stopped", undefined],
      [1, "aborted", "round-failed"],
    ]
  );
});

// The ceiling is driven directly rather than through `createForeman`:
// reaching it for real needs a branch of six commits that each conflict
// with origin, which costs six rounds to build and proves nothing the
// first two stops do not. What is worth proving is the arithmetic - the
// fifth stop is the last one a worker is handed - and that giving up
// aborts rather than leaving the rebase in flight.
test("a rebase that keeps stopping past the ceiling is aborted and reported, not handed over again", () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");
  const line = createProductionLine({ project, taskId: "ceiling-task", recordHome });
  const commit = (name: string, content: string) => {
    writeFileSync(join(line.workdir, name), content);
    execFileSync("git", ["add", "-A"], { cwd: line.workdir, stdio: ["ignore", "pipe", "pipe"] });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", name], {
      cwd: line.workdir,
      stdio: ["ignore", "pipe", "pipe"],
    });
  };
  commit("one.txt", "the task's one\n");
  commit("two.txt", "the task's two\n");
  const beforeRebase = branchHead(project, "ceiling-task");
  advanceOrigin(project, { "one.txt": "origin's one\n", "two.txt": "origin's two\n" });

  const rebase = rebaseForFixRound(recordHome, "ceiling-task", line);
  assert.equal(rebase.status, "handed-to-worker");
  assert.equal(rebaseInProgress(line.workdir), true);
  resolveMarkers(line.workdir, ["one.txt"], "reconciled one\n");

  // Told it is already at the ceiling: the next stop is one too many.
  const step = continueStoppedRebase(recordHome, "ceiling-task", line, {
    ...(rebase.status === "handed-to-worker" ? rebase.stopped : ({} as never)),
    stop: MAX_REBASE_STOPS_PER_ROUND,
  });

  assert.equal(step.status, "give-up");
  assert.equal(step.status === "give-up" && step.reason, "too-many-stops");
  assert.equal(step.status === "give-up" && step.stops, MAX_REBASE_STOPS_PER_ROUND + 1);
  assert.deepEqual(step.status === "give-up" ? step.conflict.files : [], ["two.txt"]);
  assert.equal(rebaseInProgress(line.workdir), false, "the rebase was left in flight past the ceiling");
  assert.equal(branchHead(project, "ceiling-task"), beforeRebase, "the branch was not put back where it was");
  assert.deepEqual(conflictEvents(recordHome, "ceiling-task").map((e) => [e.stop, e.left, e.reason]), [
    [1, "stopped", undefined],
    [MAX_REBASE_STOPS_PER_ROUND + 1, "aborted", "too-many-stops"],
  ]);
  destroyProductionLine(line);
});

// inspector#53: a rebase rewrites the branch, so publishing it is a
// forced push - and Fabrica is the only side that knows which commit
// origin's copy of it is expected to still be at. These prove the flag
// rides along exactly when a rebase genuinely moved the branch, and
// never otherwise.

test("a fix round that rebased the branch hands Inspector origin's copy of it as the expected tip", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");
  let version = 0;
  const brain = fakeBrain({
    onWork: (_brief, workdir) => writeFileSync(join(workdir, "task.txt"), `v${++version}\n`),
  });
  const inspector = leaseRecordingInspector();
  const foreman = createForeman({ recordHome, inspector });
  const task = await foreman.do("small change", { project, brain });

  // The first round rebased nothing, so its own handoff leases nothing.
  assert.deepEqual(inspector.calls, [{ branch: `fabrica/${task.id}`, expectedTip: undefined }]);
  assert.deepEqual(inspectorCalls(recordHome, task.id), [{ branch: `fabrica/${task.id}` }]);

  const published = publishBranch(project, task.id);
  advanceOrigin(project, { "origin.txt": "origin work\n" });
  await foreman.verdict(task.id, "fix", "one more tweak");

  assert.equal(inspector.calls.length, 2);
  assert.equal(inspector.calls[1].expectedTip, published, "the rebased branch was handed over with no lease");
  assert.notEqual(branchHead(project, task.id), published, "the branch was never rewritten, so nothing was proven");
  // And the record says what was leased against, not just Inspector.
  assert.deepEqual(inspectorCalls(recordHome, task.id).at(-1), {
    branch: `fabrica/${task.id}`,
    expectedTip: published,
  });
});

test("a fix round with nothing to rebase hands Inspector no expected tip, published branch or not", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");
  let version = 0;
  const brain = fakeBrain({
    onWork: (_brief, workdir) => writeFileSync(join(workdir, "task.txt"), `v${++version}\n`),
  });
  const inspector = leaseRecordingInspector();
  const foreman = createForeman({ recordHome, inspector });
  const task = await foreman.do("small change", { project, brain });
  const published = publishBranch(project, task.id);

  // Origin has not moved, so the branch already contains its tip.
  await foreman.verdict(task.id, "fix", "one more tweak");

  assert.equal(inspector.calls.length, 2);
  assert.equal(
    inspector.calls[1].expectedTip,
    undefined,
    "a branch that was only added to, never rewritten, is a fast-forward and needs no lease"
  );
  assert.equal(
    execFileSync("git", ["rev-parse", `fabrica/${task.id}^`], { cwd: project, encoding: "utf8" }).trim(),
    published,
    "the branch was rewritten after all, which would change what this proves"
  );
  assert.deepEqual(inspectorCalls(recordHome, task.id).at(-1), { branch: `fabrica/${task.id}` });
});

test("a rebased branch origin has no copy of is handed over with no expected tip at all", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");
  let version = 0;
  const brain = fakeBrain({
    onWork: (_brief, workdir) => writeFileSync(join(workdir, "task.txt"), `v${++version}\n`),
  });
  const inspector = leaseRecordingInspector();
  const foreman = createForeman({ recordHome, inspector });
  const task = await foreman.do("small change", { project, brain });
  const beforeRebase = branchHead(project, task.id);

  // Never published: there is nothing on origin to lease against, and
  // this must not become a new way for a publish to fail.
  advanceOrigin(project, { "origin.txt": "origin work\n" });
  await foreman.verdict(task.id, "fix", "one more tweak");

  assert.notEqual(branchHead(project, task.id), beforeRebase, "the branch was never rewritten");
  assert.equal(inspector.calls.length, 2);
  assert.equal(inspector.calls[1].expectedTip, undefined);
  assert.deepEqual(inspectorCalls(recordHome, task.id).at(-1), { branch: `fabrica/${task.id}` });
});

test("a rebase finished by the host after a conflict still leases on origin's copy of the branch", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");
  const brain = fakeBrain({
    onWork: (_brief, workdir) => {
      if (resolveMarkers(workdir, ["shared.txt"], "both versions, reconciled\n").length === 0) {
        writeFileSync(join(workdir, "shared.txt"), "the task's version\n");
      }
    },
  });
  const inspector = leaseRecordingInspector();
  const foreman = createForeman({ recordHome, inspector });
  const task = await foreman.do("small change", { project, brain });
  const published = publishBranch(project, task.id);

  advanceOrigin(project, { "shared.txt": "origin's version\n" });
  await foreman.verdict(task.id, "fix", "keep both sides");

  const delivery = await foreman.deliveryOf(task.id);
  assert.equal(delivery?.outcome, "done", delivery?.summary);
  // The lease is only knowable once the host has finished the rebase the
  // worker was handed - after this judge already existed.
  assert.equal(inspector.calls.length, 2);
  assert.equal(inspector.calls[1].expectedTip, published);
});

test("a worker that leaves markers behind leases nothing: the aborted branch never reaches Inspector", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");
  let resolve = true;
  const brain = fakeBrain({
    onWork: (_brief, workdir) => {
      // The fix round touches nothing, so the stopped rebase's markers
      // stay exactly where they were and the host aborts it.
      if (resolve) writeFileSync(join(workdir, "shared.txt"), "the task's version\n");
    },
  });
  const inspector = leaseRecordingInspector();
  const foreman = createForeman({ recordHome, inspector });
  const task = await foreman.do("small change", { project, brain });
  resolve = false;
  const beforeRebase = publishBranch(project, task.id);

  advanceOrigin(project, { "shared.txt": "origin's version\n" });
  await foreman.verdict(task.id, "fix", "keep both sides");

  assert.equal((await foreman.deliveryOf(task.id))?.outcome, "inspection-red");
  assert.equal(branchHead(project, task.id), beforeRebase, "the aborted rebase left the branch moved");
  assert.equal(inspector.calls.length, 1, "an aborted rebase was still handed to Inspector");
});

test("a branch that moved on since it was published leases on origin's copy, and the record says both", () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");
  const line = createProductionLine({ project, taskId: "diverged-task", recordHome });
  const commit = (name: string, content: string) => {
    writeFileSync(join(line.workdir, name), content);
    execFileSync("git", ["add", "-A"], { cwd: line.workdir, stdio: ["ignore", "pipe", "pipe"] });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", name], {
      cwd: line.workdir,
      stdio: ["ignore", "pipe", "pipe"],
    });
  };

  commit("one.txt", "the reviewed round\n");
  const published = publishBranch(project, "diverged-task");
  // A later round's commit that was never published - a red or refused
  // round leaves exactly this.
  commit("two.txt", "the unpublished round\n");
  const localTip = branchHead(project, "diverged-task");
  advanceOrigin(project, { "origin.txt": "origin work\n" });

  const rebase = rebaseForFixRound(recordHome, "diverged-task", line);
  assert.equal(rebase.status, "rebased");

  // The remote one is what force-with-lease compares against; the local
  // one is carried only so the record names both.
  assert.deepEqual(publishLeaseAfterRebase(line, rebase.tips), { expectedTip: published, localTip });
  assert.notEqual(published, localTip, "the two tips never diverged, so this proves nothing");
  destroyProductionLine(line);
});
