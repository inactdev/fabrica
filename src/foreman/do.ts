// The loop: SPEC.md "fabrica do". Wires src/record, src/line, src/brain,
// and src/config together — register the task, cut a ProductionLine, run
// the worker for a counted number of attempts, verify with the project's
// check, and deliver. See README.md for the design decisions this file
// leans on (why check.sh, why attempts behaves the way it does, why the
// promise doesn't resolve early).

import { appendEvent, appendTaskFile, registerTask, writeTaskFile } from "../record/index.ts";
import { createProductionLine, destroyProductionLine } from "../line/index.ts";
import type { Brain } from "../brain/index.ts";
import { ForemanError } from "./errors.ts";
import { requireCheckCommand, DEFAULT_CHECK_COMMAND } from "./check.ts";
import { resolveCheckCommand } from "./resolve-check.ts";
import { gateWasTouched, snapshotGate } from "./gate-changes.ts";
import { listTouchedFiles } from "./files.ts";
import { commitWorktreeChanges } from "./commit.ts";
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
    // has something to merge. This now runs uniformly for every outcome,
    // discarded-protected-path included — see the rule 9 comment below for
    // why that outcome no longer skips it.
    if (listTouchedFiles(line.workdir).length > 0) {
      commitWorktreeChanges(line.workdir, `fabrica: ${taskId}`);
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
    // rule9-gate.yml` blocks the merge by reading the pull request's own
    // diff for a touched protected path (`check.sh`) - it needs nothing
    // from Fabrica, so a bug in this detection or a Worker evading it
    // can't also fool the thing policing it. See
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
      details: { outcome: delivery.outcome, delivery, receipts },
    });

    return { id: taskId, state: outcome === "done" ? "delivered" : "failed" };
  } finally {
    destroyProductionLine(line);
  }
}
