// CONTRACT rule 6 ("You get the last word"): the Client's ruling on a
// delivered task. `accept` and `wrong` both close the loop - `wrong` is a
// real outcome, not a failure of the system, and the record shows it
// plainly rather than folding it into "failed". `fix` does not close the
// task: the Client's note re-enters the SAME warm worker on the SAME line
// (src/line/resume.ts) as a correction. Unlike Fabrica's own retry loop
// (src/foreman/attempts.ts, rule 3's "three means three"), a `fix` has no
// budget and no refusal - the Client asked for it, so the Client is the
// stop condition, not a counter (issue #65). Each round is still counted
// and reported, derived from the record rather than stored separately -
// see `fixRoundOf` in queries.ts. `verdict-recorded` lands on the record
// for every ruling, per rule 6, before any of "fix"'s follow-up work
// happens.

import { appendEvent, appendTaskFile, readEventsForTask, readTaskFile, writeTaskFile } from "../record/index.ts";
import { destroyProductionLine, reopenProductionLine } from "../line/index.ts";
import type { Brain } from "../brain/index.ts";
import { ForemanError } from "./errors.ts";
import { latestDeliveredDetails } from "./queries.ts";
import { DEFAULT_CHECK_COMMAND, requireCheckCommand } from "./check.ts";
import { resolveCheckCommand } from "./resolve-check.ts";
import { gateWasTouched, requireGateBaseline } from "./gate-changes.ts";
import { commitWorktreeChanges } from "./commit.ts";
import { runAttempts } from "./attempts.ts";
import { buildCommitFailureDelivery, buildDelivery, renderDeliveryMarkdown } from "./delivery.ts";
import { diffFiles, validateDelivery } from "../delivery/index.ts";
import type { Delivery, Receipt } from "../../contract/surface.ts";

const RULINGS = new Set(["accept", "fix", "wrong"]);

export async function recordVerdict(
  recordHome: string,
  taskId: string,
  ruling: "accept" | "fix" | "wrong",
  note: string | undefined,
  opts: { brain: Brain }
): Promise<void> {
  if (!RULINGS.has(ruling)) {
    throw new ForemanError(
      "invalid-verdict",
      `fabrica verdict: "${ruling}" is not a verdict. Use one of: accept, fix, wrong.`
    );
  }

  const events = readEventsForTask(recordHome, taskId);
  if (events.length === 0) {
    throw new ForemanError(
      "unknown-task",
      `fabrica verdict: no task "${taskId}" in this record. Check the id with \`fabrica status\`.`
    );
  }

  const lastVerdict = events.filter((e) => e.name === "verdict-recorded").at(-1);
  const lastRuling = (lastVerdict?.details as { ruling?: string } | undefined)?.ruling;
  if (lastRuling === "accept" || lastRuling === "wrong") {
    throw new ForemanError(
      "already-closed",
      `fabrica verdict: task "${taskId}" already has a final verdict ("${lastRuling}") and is closed. ` +
        `There is nothing left to rule on.`
    );
  }

  const delivered = events.filter((e) => e.name === "delivered").at(-1);
  if (!delivered) {
    throw new ForemanError(
      "not-delivered",
      `fabrica verdict: task "${taskId}" has not been delivered yet — there is nothing to rule on until ` +
        `\`fabrica do\` finishes it. Check \`fabrica status\`.`
    );
  }

  if (ruling === "fix" && (!note || note.trim().length === 0)) {
    throw new ForemanError(
      "missing-note",
      `fabrica verdict: a "fix" verdict needs a note saying what to change - it becomes the correction ` +
        `handed back to the worker. Usage: fabrica verdict ${taskId} fix -m "<what to fix>"`
    );
  }

  const details = latestDeliveredDetails(recordHome, taskId);
  const totalAttempts = details?.totalAttempts;
  const priorReceipts = details?.receipts ?? [];
  const project = details?.project;
  const baseCommit = details?.baseCommit;

  if (ruling === "fix" && (project === undefined || baseCommit === undefined)) {
    throw new ForemanError(
      "not-delivered",
      `fabrica verdict: task "${taskId}"'s delivery record is missing what a "fix" needs to reopen its ` +
        `line. Record "accept" or "wrong" instead.`
    );
  }

  // Write the human-readable verdict file before the record event that
  // closes (or reopens) the loop on it — same principle as the
  // commit-failure delivery in do.ts writing delivery.md before its
  // "delivered" event: a failure between the two must never leave a task
  // showing as ruled on with no record of what the Client actually said.
  appendTaskFile(recordHome, taskId, "verdict", `${new Date().toISOString()} ${ruling}${note ? `: ${note}` : ""}\n`);
  appendEvent(recordHome, { taskId, name: "verdict-recorded", details: { ruling, note: note ?? "" } });

  if (ruling !== "fix") return;

  await runFixRound(recordHome, taskId, note!, {
    brain: opts.brain,
    project: project!,
    totalAttempts,
    baseCommit: baseCommit!,
    priorReceipts,
    priorGateChanges: details?.delivery?.gateChanges || undefined,
  });
}

/** Told exactly what the Client asked for, on top of the original ask -
 * mirrors attempts.ts's correctionBrief, but from the Client's review
 * rather than a failed check. */
function buildFixBrief(originalBrief: string, note: string): string {
  return (
    `${originalBrief}\n\n---\n\nThe Client reviewed your previous delivery and asked for a change. ` +
    `Keep everything that was already right, and fix exactly this:\n\n${note}`
  );
}

/** Rule 9 across rounds: the gate is compared against the task's pinned
 * baseCommit, so a declaration an earlier round made for a change that is
 * still on the branch has to travel with it — otherwise a round whose
 * worker simply leaves the (declared, legitimate) gate change alone would
 * be reported as an undeclared one. Both rounds' declarations are kept
 * when they differ; the delivery reports the whole cumulative diff, so it
 * must account for all of it. */
function mergeGateDeclarations(prior: string | undefined, current: string | undefined): string | undefined {
  if (!prior) return current;
  if (!current || current === prior) return prior;
  return `${prior}\n\n${current}`;
}

async function runFixRound(
  recordHome: string,
  taskId: string,
  note: string,
  ctx: {
    brain: Brain;
    project: string;
    totalAttempts: number | undefined;
    baseCommit: string;
    priorReceipts: Receipt[];
    priorGateChanges: string | undefined;
  }
): Promise<void> {
  const { brain, project, totalAttempts, baseCommit, priorReceipts, priorGateChanges } = ctx;
  const lastSession = priorReceipts.at(-1)?.session ?? undefined;
  const originalBrief = readTaskFile(recordHome, taskId, "brief.md") ?? "";
  const taskText = readTaskFile(recordHome, taskId, "request.md") ?? originalBrief;

  // Reopens the same line directly rather than going through
  // runProductionRound, so this round appends "work-started" below but
  // no "line-cut" - deliberately: the task already has one from its
  // original round, and nothing here reads it again. See
  // src/foreman/README.md's `verdict(taskId, ruling, note?)` section for
  // why a general reader of "line-cut" as "this task has a live line"
  // must treat the fix path as an exception.
  const line = reopenProductionLine({ project, taskId, recordHome });

  try {
    const check = resolveCheckCommand(recordHome, line.project);
    requireCheckCommand(line.workdir, check);
    const protectedPathApplies = check === DEFAULT_CHECK_COMMAND;
    if (protectedPathApplies) requireGateBaseline(line.workdir, baseCommit);

    appendEvent(recordHome, { taskId, name: "work-started", details: { verdict: "fix" } });

    const { receipts: newReceipts, lastGate, declaredGateChanges: roundGateChanges } = await runAttempts({
      brain,
      brief: buildFixBrief(originalBrief, note),
      workdir: line.workdir,
      taskId,
      check,
      totalAttempts: 1,
      stopEarlyOnGreen: true,
      initialSession: lastSession,
      startAttempt: priorReceipts.length + 1,
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

    const declaredGateChanges = mergeGateDeclarations(priorGateChanges, roundGateChanges);

    const undeclaredGateChange =
      protectedPathApplies && gateWasTouched(line.workdir, baseCommit) && !declaredGateChanges;

    const outcome: Delivery["outcome"] = undeclaredGateChange
      ? "discarded-protected-path"
      : lastGate.green
        ? "done"
        : "failure-report";

    if (outcome === "discarded-protected-path") {
      newReceipts[newReceipts.length - 1].outcome = "discarded-protected-path";
    }

    const allReceipts = [...priorReceipts, ...newReceipts];

    try {
      commitWorktreeChanges(line.workdir, `fabrica: ${taskId} (fix)`);
    } catch (err) {
      if (!(err instanceof ForemanError) || err.code !== "commit-failed") throw err;
      newReceipts[newReceipts.length - 1].outcome = "failed";
      const delivery = buildCommitFailureDelivery({
        attempts: allReceipts.length,
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
        details: { outcome: delivery.outcome, delivery, receipts: allReceipts, project, totalAttempts, baseCommit },
      });
      return;
    }

    const delivery = buildDelivery(outcome, {
      taskText,
      attempts: allReceipts.length,
      lastGate,
      branch: line.branch,
      files: diffFiles(line.project, line.branch, baseCommit),
      declaredGateChanges,
    });

    validateDelivery(delivery);
    writeTaskFile(recordHome, taskId, "delivery.md", renderDeliveryMarkdown(delivery));
    appendEvent(recordHome, {
      taskId,
      name: "delivered",
      details: { outcome: delivery.outcome, delivery, receipts: allReceipts, project, totalAttempts, baseCommit },
    });
  } finally {
    destroyProductionLine(line);
  }
}
