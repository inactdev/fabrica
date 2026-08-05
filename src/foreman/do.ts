// The loop: SPEC.md "fabrica do". Wires src/record, src/line, src/brain,
// and src/config together — register the task, cut a ProductionLine, run
// the worker for a counted number of attempts, verify with the project's
// check, and deliver. See README.md for the design decisions this file
// leans on (why check.sh, why attempts behaves the way it does, why the
// promise doesn't resolve early).

import { execFileSync } from "node:child_process";
import { appendEvent, appendTaskFile, registerTask, writeTaskFile } from "../record/index.ts";
import { createProductionLine, destroyProductionLine } from "../line/index.ts";
import type { Brain } from "../brain/index.ts";
import { ForemanError } from "./errors.ts";
import { requireCheckCommand, DEFAULT_CHECK_COMMAND } from "./check.ts";
import { resolveCheckCommand } from "./resolve-check.ts";
import { gateWasTouched, snapshotGate } from "./gate-changes.ts";
import { listTouchedFiles } from "./files.ts";
import { commitWorktreeChanges } from "./commit.ts";
import { captureDiscardedPatch } from "./discard.ts";
import { runAttempts } from "./attempts.ts";
import { buildDelivery, renderDeliveryMarkdown } from "./delivery.ts";
import { baseCommitOf, diffFiles, validateDelivery } from "../delivery/index.ts";
import type { Delivery, FabricaTask } from "../../contract/surface.ts";

/** SPEC.md step 5's default: one attempt, and on red one fix pass with the
 * failure output, then re-check — a ceiling of 2 worker runs. */
export const DEFAULT_ATTEMPTS = 2;

export async function doTask(
  recordHome: string,
  taskText: string,
  opts: { project: string; attempts?: number; brain?: Brain }
): Promise<FabricaTask> {
  const brain = opts.brain;
  if (!brain) {
    throw new ForemanError(
      "no-brain",
      "fabrica do: no brain was provided, and v1 has no default adapter wired in yet " +
        "(issue #6 builds the first one). Pass one explicitly."
    );
  }

  const explicitAttempts = opts.attempts !== undefined;
  if (explicitAttempts && (!Number.isInteger(opts.attempts) || opts.attempts! < 1)) {
    throw new ForemanError(
      "invalid-attempts",
      `fabrica do: attempts must be a positive integer, got ${opts.attempts}.`
    );
  }
  const totalAttempts = opts.attempts ?? DEFAULT_ATTEMPTS;

  const { id: taskId } = registerTask(recordHome, taskText);
  // Ownership split: registerTask (src/record) writes request.md as part
  // of registration — the record owns what the Client said. The Foreman
  // writes brief.md here, afterwards — the Foreman owns what a Worker is
  // actually given.
  //
  // Two complementary reasons to write it now, upfront, rather than
  // deriving it on demand later:
  //   - #8 is why it exists NOW: brief.md is written here so fabrica
  //     answer only has to append a round to answers.md and re-derive
  //     brief.md from what's already there, instead of having to create
  //     the file itself and reshape this path.
  //   - #19 is why it must be STORED rather than derived LATER: once
  //     per-project lessons get primed into the brief, brief.md becomes
  //     the record of what was actually handed to a Worker, not a cache
  //     of request.md — a brief will contain material that cannot be
  //     reconstructed later from request.md + answers.md alone, because
  //     lessons change over time. Storing it is evidence, not a
  //     convenience.
  // Today brief.md is byte-identical to request.md — v1 neither asks a
  // clarifying question (#8) nor primes lessons (#19) yet — and that
  // sameness is expected to end the moment either one lands.
  writeTaskFile(recordHome, taskId, "brief.md", taskText);

  const line = createProductionLine({ project: opts.project, taskId, recordHome });

  try {
    // Pin the diff's fork point to the exact commit the ProductionLine was
    // cut from, before any worker attempt runs — so the delivery's `files`
    // list can't drift if the Client's own checkout moves to a different
    // branch while the task is still running.
    const baseCommit = baseCommitOf(line.workdir);

    const check = resolveCheckCommand(recordHome, line.project);
    requireCheckCommand(line.workdir, check);
    const protectedPathApplies = check === DEFAULT_CHECK_COMMAND;
    const gateBefore = protectedPathApplies ? snapshotGate(line.workdir) : null;

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
      gateBefore !== null && gateWasTouched(line.workdir, gateBefore) && !declaredGateChanges;

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
    // has something to merge.
    //
    // The one exception is discarded-protected-path. Rule 5 keeps EVIDENCE
    // (the delivery, outcome, receipts, and transcript stay on the record
    // regardless of outcome) while rule 9 discards the WORK — different
    // things, not in conflict. Committing tampered code onto a durable,
    // mergeable branch would turn "thrown away, no matter how good the
    // result looks" into "thrown away, but here it is anyway, one click
    // from merging." Emptying the branch means `files` (read from the
    // branch's diff) comes back empty, which is honest — nothing is handed
    // over on the branch. But "discarded" must not mean "destroyed": an
    // undeclared gate change is often a declaration mistake, and the work
    // behind it may be entirely good, so everything changed since the fork
    // point is captured to the record as discarded.patch instead — never
    // committed. The ratified rule 9 tests
    // (contract/rule9.no-self-grading.test.ts) pass either way — they
    // assert on delivery.outcome and delivery.gateChanges, never on what
    // survives on the branch or in the record — so this is a deliberate
    // product decision the contract does not force, not something derived
    // from a failing test.
    let discardedPatchSaved = false;
    if (outcome === "discarded-protected-path") {
      const patch = captureDiscardedPatch(line.workdir, baseCommit);
      if (patch.length > 0) {
        writeTaskFile(recordHome, taskId, "discarded.patch", patch);
        discardedPatchSaved = true;
      }
      // Rule 9 says the attempt is thrown away automatically, no matter
      // how good the result looks — and a branch a Worker committed to
      // itself (it has full git access inside the worktree) is exactly as
      // mergeable as one Fabrica committed to. So the branch ref itself is
      // forced back to the exact commit the line was cut from; merely
      // skipping Fabrica's own commit step (the previous fix) stopped
      // Fabrica from adding a commit but did nothing about a Worker
      // committing directly. update-ref rather than `branch -f` because
      // git refuses to force-move a branch checked out in a worktree, and
      // this one still is until teardown. After this, diffFiles below
      // naturally reports an empty files list — branch and baseCommit are
      // the same commit.
      execFileSync("git", ["update-ref", `refs/heads/${line.branch}`, baseCommit], {
        cwd: line.project,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } else if (listTouchedFiles(line.workdir).length > 0) {
      commitWorktreeChanges(line.workdir, `fabrica: ${taskId}`);
    }

    const delivery = buildDelivery(outcome, {
      taskText,
      attempts: receipts.length,
      lastGate,
      branch: line.branch,
      files: diffFiles(line.project, line.branch, baseCommit),
      declaredGateChanges,
      taskId,
      discardedPatchSaved,
    });

    // Never present a malformed delivery as done (rule 4), and never trust
    // the files list on faith (rule 4's diff check, run because `project`
    // is passed) — prove the Foreman's own output before anyone else has
    // to.
    validateDelivery(delivery, line.project, baseCommit);

    writeTaskFile(recordHome, taskId, "delivery.md", renderDeliveryMarkdown(delivery));
    appendEvent(recordHome, {
      taskId,
      name: "delivered",
      details: { outcome: delivery.outcome, delivery, receipts },
    });

    return { id: taskId, state: outcome === "done" ? "delivered" : "failed" };
  } finally {
    destroyProductionLine(line);
  }
}
