// The loop: SPEC.md "fabrica do". Wires src/record, src/line, src/brain,
// and src/config together — register the task, ask-or-proceed (issue #8,
// ask.ts), cut a ProductionLine, run the worker for a counted number of
// attempts, verify with the project's check, and deliver. See README.md
// for the design decisions this file leans on (why check.sh, why
// attempts behaves the way it does, why the promise doesn't resolve
// early).

import { appendEvent, appendTaskFile, writeTaskFile } from "../record/index.ts";
import { createProductionLine, destroyProductionLine, reopenProductionLine } from "../line/index.ts";
import type { Brain } from "../brain/index.ts";
import { ForemanError } from "./errors.ts";
import { requireCheckCommand, DEFAULT_CHECK_COMMAND } from "./check.ts";
import { resolveCheckCommand } from "./resolve-check.ts";
import { gateWasTouched, requireGateBaseline } from "./gate-changes.ts";
import { commitWorktreeChanges } from "./commit.ts";
import { runAttempts } from "./attempts.ts";
import { buildDelivery, buildCommitFailureDelivery, renderDeliveryMarkdown } from "./delivery.ts";
import { baseCommitOf, diffFiles, validateDelivery } from "../delivery/index.ts";
import { registerAndAsk } from "./ask.ts";
import type { Delivery, FabricaTask } from "../../contract/surface.ts";

export { DEFAULT_ATTEMPTS } from "./ask.ts";

export async function doTask(
  recordHome: string,
  taskText: string,
  opts: { project: string; attempts?: number; brain?: Brain }
): Promise<FabricaTask> {
  // SPEC.md steps 1-2: register the task, then give the brain one pass
  // at the bare task text (issue #8) before any ProductionLine exists.
  // registerAndAsk raises ForemanError("no-brain"/"invalid-attempts")
  // up front, same as this function always has, before anything is
  // registered.
  const { taskId, brief, questions, project, totalAttempts, explicitAttempts } = await registerAndAsk(
    recordHome,
    taskText,
    opts
  );

  // A materially ambiguous task stops here - no ProductionLine is ever
  // cut, no Worker ever runs. `fabrica answer <id> -m "<text>"`
  // (src/foreman/answer.ts) resumes it, extending this same brief.
  if (questions.length > 0) return { id: taskId, state: "asking" };

  // Always a first-ever round: registerAndAsk just claimed this taskId,
  // so no ProductionLine for it can exist yet. Never derived from
  // whether a branch happens to exist (see runProductionRound's own
  // comment for why that was the weaker, unsafe signal).
  return runProductionRound(recordHome, taskId, brief, {
    project,
    brain: opts.brain!,
    totalAttempts,
    explicitAttempts,
    isRetry: false,
  });
}

/**
 * SPEC.md steps 3-6: isolate, work, verify, deliver. Shared by a task
 * proceeding straight out of `doTask` and one resuming after `fabrica
 * answer` (answer.ts) - `brief` is whatever the brain should actually
 * receive: the bare task text in doTask's case, request.md plus every
 * answer so far in answer.ts's.
 */
export async function runProductionRound(
  recordHome: string,
  taskId: string,
  brief: string,
  ctx: { project: string; brain: Brain; totalAttempts: number; explicitAttempts: boolean; isRetry: boolean }
): Promise<FabricaTask> {
  const { project, brain, totalAttempts, explicitAttempts, isRetry } = ctx;
  const taskText = brief;
  // `isRetry` is an explicit signal the caller derives from the RECORD -
  // answer.ts sets it true only when this exact taskId, in this exact
  // record home, already has a prior "answers-given" that never
  // delivered (a resumed round that threw before finishing - a missing
  // check command, a moved project path, an unreachable brain).
  // doTask's first-ever call always passes false.
  //
  // This used to be decided by asking git whether a `fabrica/<taskId>`
  // branch already existed, on the theory that a first-ever round could
  // never see one. That was the weaker evidence: a taskId is only unique
  // within one record home (registerTask claims tasks/<id>/), while
  // branches live in the project - a same-named branch left by a
  // different record home, a record home recreated while the project's
  // branches survived, or a hand-made branch, would all have been
  // silently reopened and committed onto, on what was actually this
  // task's first round, exactly where createProductionLine's own loud
  // refusal used to apply. The record - whether this taskId's own
  // history shows a prior incomplete resume - is a claim only this
  // task's own retry can make true, so it can't be spoofed by an
  // unrelated branch happening to share a name.
  //
  // Note what reopening does and doesn't fix. It makes a retry possible
  // at all, and a failure unrelated to the branch's own content (an
  // unreachable brain, a transient error) then succeeds once that
  // condition clears. It does NOT re-cut from the project's current
  // HEAD: the reopened branch is still forked from wherever it was
  // first cut, so a failure baked into that history - no check.sh in
  // that commit, a project path already wrong then - throws the same
  // error on every retry.
  const line = isRetry
    ? reopenProductionLine({ project, taskId, recordHome })
    : createProductionLine({ project, taskId, recordHome });

  try {
    // Pin the diff's fork point to the exact commit the ProductionLine was
    // cut from, before any worker attempt runs — so the delivery's `files`
    // list can't drift if the Client's own checkout moves to a different
    // branch while the task is still running.
    const baseCommit = baseCommitOf(line.workdir);

    const check = resolveCheckCommand(recordHome, line.project);
    requireCheckCommand(line.workdir, check);
    const protectedPathApplies = check === DEFAULT_CHECK_COMMAND;
    if (protectedPathApplies) requireGateBaseline(line.workdir, baseCommit);

    appendEvent(recordHome, { taskId, name: "work-started" });

    const { receipts, lastGate, declaredGateChanges } = await runAttempts({
      brain,
      brief: taskText,
      workdir: line.workdir,
      taskId,
      check,
      totalAttempts,
      stopEarlyOnGreen: !explicitAttempts,
      onCheckRun: (attempt, gate) => {
        appendEvent(recordHome, { taskId, name: "check-run", details: { attempt, green: gate.green } });
      },
      onTranscript: (transcript) => {
        appendTaskFile(
          recordHome,
          taskId,
          "transcript.log",
          transcript.map((entry) => JSON.stringify(entry) + "\n").join("")
        );
      },
    });

    const undeclaredGateChange =
      protectedPathApplies && gateWasTouched(line.workdir, baseCommit) && !declaredGateChanges;

    const outcome: Delivery["outcome"] = undeclaredGateChange
      ? "discarded-protected-path"
      : lastGate.green
        ? "done"
        : "failure-report";

    if (outcome === "discarded-protected-path") {
      receipts[receipts.length - 1].outcome = "discarded-protected-path";
    }

    // A worker's edits live only as uncommitted changes in this throwaway
    // worktree, and destroyProductionLine (below, in `finally`) force-
    // removes it. Left alone, that is PR #43's flagged tension: the
    // delivery's `files` field could name real work that is about to
    // vanish, while `branch` points at a branch with nothing ever
    // committed to it. Committing here, before teardown, resolves it by
    // construction rather than by validating around it: `files` is then
    // read back from the branch's own diff (diffFiles), so it and `branch`
    // describe the same surviving reality, and the Client's `git merge`
    // has something to merge. This now runs uniformly for every outcome,
    // discarded-protected-path included — see the rule 9 comment below for
    // why that outcome no longer skips it. Called unconditionally:
    // commitWorktreeChanges already asks the index directly and no-ops
    // when there is nothing staged, so a separate "is there anything to
    // commit" check here would only re-answer the same question.
    try {
      commitWorktreeChanges(line.workdir, `fabrica: ${taskId}`);
    } catch (err) {
      if (!(err instanceof ForemanError) || err.code !== "commit-failed") throw err;
      // A commit failure here (a stale lock, a full disk, a read-only
      // mount) used to propagate straight out of doTask: `finally` below
      // still force-removes the worktree, destroying the Worker's
      // uncommitted work, and nothing was ever written to the record - a
      // task vanishing without a trace, the worst version of losing work
      // (Client ruling, PR #54 follow-up). The record must always say
      // what happened, so this is caught and turned into a delivery of
      // its own instead - scoped minimally, no retry machinery, just an
      // honest failure report.
      receipts[receipts.length - 1].outcome = "failed";
      const delivery = buildCommitFailureDelivery({
        attempts: receipts.length,
        lastGate,
        branch: line.branch,
        declaredGateChanges,
        error: err.message,
      });
      validateDelivery(delivery);
      writeTaskFile(recordHome, taskId, "delivery.md", renderDeliveryMarkdown(delivery));
      appendEvent(recordHome, {
        taskId,
        name: "delivered",
        details: { outcome: delivery.outcome, delivery, receipts, project: line.project, totalAttempts, baseCommit },
      });
      return { id: taskId, state: "failed" };
    }

    // CONTRACT rule 9 (Client ruling, superseding the original
    // force-reset-and-patch design, and then again superseding a
    // branch-rename design): an undeclared gate change is never force-
    // reset, thrown away, or specially marked on the branch any more. The
    // branch stays `fabrica/<taskId>` for every outcome, discarded-
    // protected-path included - the uniform commit above already put the
    // work there. Detection stays exactly as it was (`gate-changes.ts`
    // still forces this outcome, honestly, regardless of how good the
    // check looked); what moved is enforcement. `.github/workflows/
    // rule9-gate.yml` blocks the merge by asking the GitHub API which
    // files the pull request changed and matching them against its
    // protected paths (`check.sh`, plus the workflow directory itself) -
    // it needs nothing from Fabrica, so a bug in this detection or a
    // Worker evading it can't also fool the thing policing it. See
    // `src/foreman/README.md`'s "Rule 9: blocked by CI, not by Fabrica's
    // own mark" for the full reasoning, and issue #55 for the limitation
    // that this check exists only in Fabrica's own repository today.
    const delivery = buildDelivery(outcome, {
      taskText,
      attempts: receipts.length,
      lastGate,
      branch: line.branch,
      files: diffFiles(line.project, line.branch, baseCommit),
      declaredGateChanges,
    });

    // Never present a malformed delivery as done (rule 4) — prove the
    // Foreman's own output before anyone else has to. `files` above is
    // already read straight from the real diff, not a separate claim, so
    // there is nothing left to verify it against (src/delivery/README.md).
    validateDelivery(delivery);

    writeTaskFile(recordHome, taskId, "delivery.md", renderDeliveryMarkdown(delivery));
    appendEvent(recordHome, {
      taskId,
      name: "delivered",
      details: { outcome: delivery.outcome, delivery, receipts, project: line.project, totalAttempts, baseCommit },
    });

    return { id: taskId, state: outcome === "done" ? "delivered" : "failed" };
  } finally {
    destroyProductionLine(line);
  }
}
