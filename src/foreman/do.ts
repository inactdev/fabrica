// The loop: SPEC.md "fabrica do". Wires src/record, src/line, src/brain,
// and src/config together — register the task, cut a ProductionLine, run
// the worker for a counted number of attempts, verify with the project's
// check, and deliver. See README.md for the design decisions this file
// leans on (why check.sh, why attempts behaves the way it does, why the
// promise doesn't resolve early).

import { appendEvent, registerTask, writeTaskFile } from "../record/index.ts";
import { createProductionLine, destroyProductionLine } from "../line/index.ts";
import type { Brain } from "../brain/index.ts";
import { ForemanError } from "./errors.ts";
import { requireCheckCommand, DEFAULT_CHECK_COMMAND } from "./check.ts";
import { resolveCheckCommand } from "./resolve-check.ts";
import { gateWasTouched, snapshotGate } from "./gate-changes.ts";
import { listTouchedFiles } from "./files.ts";
import { runAttempts } from "./attempts.ts";
import { buildDelivery, renderDeliveryMarkdown } from "./delivery.ts";
import type { Delivery, FabricaTask } from "./types.ts";

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
  const totalAttempts = opts.attempts ?? DEFAULT_ATTEMPTS;

  const { id: taskId } = registerTask(recordHome, taskText);
  // v1's ask-first dial always proceeds straight to work (SPEC.md step 2):
  // Brain has no way yet to signal "I have questions" back through the
  // seam, and building the resumable clarify round is issue #8's job.
  // brief.md is written now, verbatim from the request, so #8 only has to
  // append answers and re-derive it from here — never reshape this path.
  writeTaskFile(recordHome, taskId, "brief.md", taskText);

  const line = createProductionLine({ project: opts.project, taskId, recordHome });

  try {
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
    });

    const undeclaredGateChange =
      gateBefore !== null && gateWasTouched(line.workdir, gateBefore) && !declaredGateChanges;

    const outcome: Delivery["outcome"] = undeclaredGateChange
      ? "discarded-protected-path"
      : lastGate.green
        ? "done"
        : "failure-report";

    receipts[receipts.length - 1].outcome =
      outcome === "done" ? "delivered" : outcome === "failure-report" ? "failed" : "discarded-protected-path";

    const delivery = buildDelivery(outcome, {
      taskText,
      attempts: receipts.length,
      lastGate,
      branch: line.branch,
      files: listTouchedFiles(line.workdir),
      declaredGateChanges,
    });

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
