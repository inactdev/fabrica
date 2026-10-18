// Issue #235: what the Client sees when a fix round's host-side rebase
// succeeds, is unnecessary, or conflicts. The git mechanics have their own
// tests (src/line/rebase.test.ts); these drive the whole loop through
// `createForeman`, because the thing worth proving here is the policy -
// which conflict is reported to him, which is handed to a worker, and
// what the branch is left at either way.

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
import { latestDeliveredDetails } from "./queries.ts";

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-fix-rebase-home-"));
}

function branchHead(project: string, taskId: string): string {
  return execFileSync("git", ["rev-parse", `fabrica/${taskId}`], { cwd: project, encoding: "utf8" }).trim();
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
  assert.equal(
    details?.baseCommit,
    execFileSync("git", ["rev-parse", "refs/remotes/origin/master"], { cwd: project, encoding: "utf8" }).trim()
  );
  assert.deepEqual(details?.delivery?.files, ["task.txt"]);
  assert.equal(details?.outcome, "done");
  assert.equal(
    (await foreman.events(task.id)).some((e) => e.name === "rebase-conflicted"),
    false
  );
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

test("a conflicting rebase delivers inspection-red with the markers, and never runs a worker", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");
  const brain = fakeBrain({
    onWork: (_brief, workdir) => writeFileSync(join(workdir, "shared.txt"), "the task's version\n"),
  });
  const foreman = createForeman({ recordHome, inspector: fixtureInspector() });
  const task = await foreman.do("small change", { project, brain });
  const callsAfterFirstRound = brain.calls;
  const headBeforeFix = branchHead(project, task.id);

  advanceOrigin(project, { "shared.txt": "origin's version\n" });
  await foreman.verdict(task.id, "fix", "bring it up to date");

  assert.equal(brain.calls, callsAfterFirstRound, "a worker ran on a conflict the Client has not ruled on yet");

  const delivery = await foreman.deliveryOf(task.id);
  assert.equal(delivery?.outcome, "inspection-red");
  assert.match(delivery!.summary, /Rebasing `fabrica\//);
  assert.match(delivery!.summary, /onto origin\/master conflicts in 1 file/);
  assert.match(delivery!.evidence, /Conflicted files:\n {2}shared\.txt/);
  assert.match(delivery!.evidence, /^<{7}/m);
  assert.match(delivery!.evidence, /the task's version/);
  assert.match(delivery!.evidence, /origin's version/);
  assert.match(delivery!.gaps, /Nothing was rewritten/);
  assert.match(delivery!.gaps, /Give a fix verdict saying how to resolve these conflicts/);
  // No Inspector ran, so the delivery must not claim one did.
  assert.equal(delivery!.inspection, undefined);

  assert.equal(branchHead(project, task.id), headBeforeFix, "the branch did not stay at its pre-rebase commit");

  const conflictEvent = (await foreman.events(task.id)).filter((e) => e.name === "rebase-conflicted").at(-1);
  assert.deepEqual((conflictEvent?.details as { files?: string[]; left?: string }).files, ["shared.txt"]);
  assert.equal((conflictEvent?.details as { left?: string }).left, "aborted");

  // The task is in front of the Client, not failed.
  assert.equal((await foreman.status()).find((t) => t.id === task.id)?.state, "delivered");
  // And the delivery itself is what the next round reads to know he has
  // already seen this conflict.
  assert.deepEqual(latestDeliveredDetails(recordHome, task.id)?.rebaseConflict, {
    base: "master",
    files: ["shared.txt"],
  });
});

test("the fix round the Client rules after that report hands the stopped rebase to the worker, and the host finishes it", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");
  const briefs: string[] = [];
  const brain = fakeBrain({
    onWork: (brief, workdir) => {
      briefs.push(brief);
      const path = join(workdir, "shared.txt");
      // A worker resolving markers in place, with no git of its own.
      if (existsSync(path) && readFileSync(path, "utf8").includes("<<<<<<<")) {
        writeFileSync(path, "both versions, reconciled\n");
      } else {
        writeFileSync(path, "the task's version\n");
      }
    },
  });
  const foreman = createForeman({ recordHome, inspector: fixtureInspector() });
  const task = await foreman.do("small change", { project, brain });

  advanceOrigin(project, { "shared.txt": "origin's version\n" });
  const originTip = execFileSync("git", ["rev-parse", "refs/remotes/origin/master"], {
    cwd: project,
    encoding: "utf8",
  }).trim();
  await foreman.verdict(task.id, "fix", "bring it up to date");
  assert.equal((await foreman.deliveryOf(task.id))?.outcome, "inspection-red");

  await foreman.verdict(task.id, "fix", "keep both sides, origin's wording wins on the first line");

  // The worker was told what it was handed, with the conflicted files
  // named, on top of the Client's own note.
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
    originTip
  );
  assert.equal(latestDeliveredDetails(recordHome, task.id)?.baseCommit, originTip);
  assert.deepEqual(delivery!.files, ["shared.txt"]);
  assert.equal(latestDeliveredDetails(recordHome, task.id)?.rebaseConflict, undefined);

  const conflictEvents = (await foreman.events(task.id)).filter((e) => e.name === "rebase-conflicted");
  assert.deepEqual(
    conflictEvents.map((e) => (e.details as { left?: string }).left),
    ["aborted", "stopped"]
  );
});

test("a worker that leaves markers behind is inspection-red again, with the branch back where it was", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");
  let resolve = true;
  const brain = fakeBrain({
    onWork: (_brief, workdir) => {
      if (resolve) writeFileSync(join(workdir, "shared.txt"), "the task's version\n");
      // Second call: touches nothing, so the markers stay exactly where
      // the stopped rebase left them.
    },
  });
  const foreman = createForeman({ recordHome, inspector: fixtureInspector() });
  const task = await foreman.do("small change", { project, brain });
  resolve = false;

  advanceOrigin(project, { "shared.txt": "origin's version\n" });
  await foreman.verdict(task.id, "fix", "bring it up to date");
  const headBeforeSecondFix = branchHead(project, task.id);
  const callsBefore = brain.calls;

  await foreman.verdict(task.id, "fix", "resolve the conflict");

  assert.equal(brain.calls, callsBefore + 1, "the worker was not handed the stopped rebase");
  const delivery = await foreman.deliveryOf(task.id);
  assert.equal(delivery?.outcome, "inspection-red");
  assert.match(delivery!.summary, /still conflicts in 1 file after the worker's attempt/);
  assert.match(delivery!.gaps, /did not resolve every marker/);
  assert.equal(branchHead(project, task.id), headBeforeSecondFix, "the half-rebased branch was left behind");
  assert.equal(latestDeliveredDetails(recordHome, task.id)?.baseCommit !== undefined, true);
  // Still rulable: the Client can try again with a better note.
  assert.equal((await foreman.status()).find((t) => t.id === task.id)?.state, "delivered");
  assert.deepEqual(latestDeliveredDetails(recordHome, task.id)?.rebaseConflict?.files, ["shared.txt"]);
  // That round's own attempt is on the record as a real, failed attempt.
  const receipts = await foreman.receiptsOf(task.id);
  assert.equal(receipts.at(-1)?.outcome, "failed");
  assert.equal(receipts.at(-1)?.checks, null, "nothing judged an attempt whose rebase never finished");
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
  await foreman.verdict(task.id, "fix", "bring it up to date");
  await foreman.verdict(task.id, "fix", "resolve the conflict");

  const delivery = await foreman.deliveryOf(task.id);
  assert.equal(delivery?.outcome, "inspection-red", "a leftover marker was committed onto the branch");
  assert.match(delivery!.evidence, />{7} origin's version/);
});
