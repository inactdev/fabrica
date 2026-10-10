// CONTRACT rule 10's gate at the start of any spend: a new task, a
// resumed round (`fabrica answer`), or a fix round. Read fresh from the
// record every time (spend.ts), so the answer survives restarts and
// agrees across processes. A refusal lands on the refused task's own
// record as "cap-refused" - with the numbers and the exact message the
// Client sees - before it is thrown.

import { appendEvent, readEvents, readEventsForTask } from "../record/index.ts";
import type { Caps, Receipt } from "../../contract/surface.ts";
import { ForemanError } from "./errors.ts";
import type { AttemptSpendLimits, CapStop } from "./attempts.ts";
import {
  daySpend,
  describeTaskCost,
  hasAttempts,
  describeUnmeasured,
  formatUsd,
  SPEND_UNKNOWN_LINE,
  taskSpend,
  unmeasuredSpend,
} from "./spend.ts";
import type { CostRecordedDetails } from "./spend.ts";

export function capsActive(caps: Caps | undefined): boolean {
  return caps?.perTaskUsd !== undefined || caps?.perDayUsd !== undefined;
}

/** Everything a "cap-refused" event's `details` carries. */
export interface CapRefusedDetails {
  reason: "spend-unknown" | "per-day-cap" | "per-task-cap";
  message: string;
  capUsd?: number;
  spentUsd?: number;
  unmeasured?: { taskId: string; attempts: number[] }[];
  /** The project the refused task was for, so `fabrica status` can name it. */
  project?: string;
}

function refuse(recordHome: string, taskId: string, code: "spend-unknown" | "cap-refused", details: CapRefusedDetails): never {
  appendEvent(recordHome, { taskId, name: "cap-refused", details });
  throw new ForemanError(code, details.message);
}

/** Throws (after recording why) when `taskId` may not start spending:
 * any unmeasured spend on the record, the last 24 hours' spend at or past
 * `perDayUsd`, or this task's own spend at or past `perTaskUsd`. A no-op
 * when no cap is set. */
export function requireRoomToStart(
  recordHome: string,
  taskId: string,
  caps: Caps | undefined,
  opts: { project?: string; now?: number } = {}
): void {
  if (!capsActive(caps)) return;
  const now = opts.now ?? Date.now();
  const events = readEvents(recordHome);
  const project = opts.project === undefined ? {} : { project: opts.project };

  const unmeasured = unmeasuredSpend(events);
  if (unmeasured.length > 0) {
    refuse(recordHome, taskId, "spend-unknown", {
      reason: "spend-unknown",
      unmeasured,
      ...project,
      message:
        `${SPEND_UNKNOWN_LINE}. A spending cap is set, and the cost of earlier work was never measured, ` +
        `so nothing new may start until it is recorded - unmeasured spend is never counted as $0:\n` +
        describeUnmeasured(unmeasured).map((line) => `  ${line}`).join("\n"),
    });
  }

  if (caps!.perDayUsd !== undefined) {
    const { knownUsd } = daySpend(events, now);
    if (knownUsd >= caps!.perDayUsd) {
      refuse(recordHome, taskId, "cap-refused", {
        reason: "per-day-cap",
        ...project,
        capUsd: caps!.perDayUsd,
        spentUsd: knownUsd,
        message:
          `Refused by the daily cap: ${formatUsd(knownUsd)} has been spent in the last 24 hours, and the cap ` +
          `is ${formatUsd(caps!.perDayUsd)}. Nothing was started. The window is a rolling 24 hours, so room ` +
          `comes back as older spend ages out; raising [caps].perDayUsd in projects.toml is the other way.`,
      });
    }
  }

  if (caps!.perTaskUsd !== undefined) {
    const { knownUsd } = taskSpend(events, taskId);
    if (knownUsd >= caps!.perTaskUsd) {
      refuse(recordHome, taskId, "cap-refused", {
        reason: "per-task-cap",
        ...project,
        capUsd: caps!.perTaskUsd,
        spentUsd: knownUsd,
        message:
          `Refused by the per-task cap: task ${taskId} has already spent ${formatUsd(knownUsd)}, and the cap ` +
          `is ${formatUsd(caps!.perTaskUsd)}. Nothing was started. Raise [caps].perTaskUsd in projects.toml ` +
          `to let it continue.`,
      });
    }
  }
}

/** The spend limits one round of attempts runs under, with this task's
 * own earlier rounds already counted. */
export function spendLimitsFor(recordHome: string, taskId: string, caps: Caps | undefined): AttemptSpendLimits {
  return {
    capsActive: capsActive(caps),
    perTaskUsd: caps?.perTaskUsd,
    priorKnownUsd: taskSpend(readEventsForTask(recordHome, taskId), taskId).knownUsd,
  };
}

/** Records one attempt's receipt the moment it exists, so its spend is on
 * the record even while the task is still running. */
export function recordReceipt(recordHome: string, receipt: Receipt): void {
  appendEvent(recordHome, { taskId: receipt.task, name: "receipt-recorded", details: { receipt } });
}

/** Records why a running task was stopped, in the words its report uses. */
export function recordCapStop(recordHome: string, taskId: string, capStop: CapStop, message: string): void {
  appendEvent(recordHome, { taskId, name: "cap-stopped", details: { ...capStop, message } });
}

/** This task's cost, worded for its delivery.md. */
export function costLabelOf(recordHome: string, taskId: string): string {
  const events = readEventsForTask(recordHome, taskId);
  const spend = taskSpend(events, taskId);
  return describeTaskCost(spend, hasAttempts(events, taskId));
}

/** True when a cap is set and this task has spend nobody measured. */
export function spendUnknownUnderCap(recordHome: string, taskId: string, caps: Caps | undefined): boolean {
  if (!capsActive(caps)) return false;
  return taskSpend(readEventsForTask(recordHome, taskId), taskId).unknownAttempts.length > 0;
}

/** `fabrica cost <taskId> <usd>`: the owner's own figure for every
 * attempt of `taskId` whose cost is still unknown. Refuses a figure that
 * is not a real dollar amount, and refuses when there is nothing
 * unmeasured to cover - a block only clears when a cost is recorded. */
export function recordCost(recordHome: string, taskId: string, usd: number): void {
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) {
    throw new ForemanError(
      "invalid-cost",
      `fabrica cost: "${usd}" is not a cost - give the real dollar amount, zero or more, e.g. ` +
        `\`fabrica cost ${taskId} 0.42\`.`
    );
  }
  const events = readEventsForTask(recordHome, taskId);
  if (events.length === 0) {
    throw new ForemanError(
      "unknown-task",
      `fabrica cost: no task "${taskId}" in this record. Check the id with \`fabrica status\`.`
    );
  }
  if (!hasAttempts(events, taskId)) {
    throw new ForemanError(
      "nothing-to-record",
      `fabrica cost: task "${taskId}" never ran an attempt, so it has spent nothing to record. Nothing was changed.`
    );
  }
  const { unknownAttempts } = taskSpend(events, taskId);
  if (unknownAttempts.length === 0) {
    throw new ForemanError(
      "nothing-to-record",
      `fabrica cost: task "${taskId}" has nothing unmeasured to record - every attempt's cost is already ` +
        "known. Nothing was changed."
    );
  }
  const details: CostRecordedDetails = { usd, attempts: unknownAttempts };
  appendEvent(recordHome, { taskId, name: "cost-recorded", details });
}
