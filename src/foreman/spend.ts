// CONTRACT rule 10's ledger: what has been spent, derived from the
// append-only record every time it is asked - never held in memory, so a
// restart, a second process, or a fresh Foreman all see the same total.
// Spend lives on receipts (one per attempt): each attempt's own
// "receipt-recorded" event, plus the receipts every "delivered" event
// carries (the only place a receipt landed before issue #11), counted
// once per task and attempt. A hand-recorded cost ("cost-recorded",
// `fabrica cost`) fills in attempts whose cost was unknown.
//
// Unknown is never zero: an attempt with a null cost is reported as
// unknown everywhere, never folded into a total as $0.

import type { FabricaEvent } from "../record/index.ts";
import type { Receipt, TranscriptEntry } from "../../contract/surface.ts";

/** The daily cap's window: a rolling 24 hours ending now, not a calendar
 * day - so there is no midnight at which a day's spend resets at once. */
export const DAY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** contract/surface.ts's TranscriptEntry: an entry with kind "usage"
 * carries `{ totalCostUsd: number | null, ... }`. The attempt's cost is
 * the sum of them all, and unknown (null) if any one is null or
 * unreadable, or there is none at all. */
export function costFromTranscript(transcript: TranscriptEntry[]): number | null {
  let total = 0;
  let seen = false;
  for (const entry of transcript) {
    if (entry.kind !== "usage") continue;
    let cost: unknown;
    try {
      cost = (JSON.parse(entry.text) as { totalCostUsd?: unknown } | null)?.totalCostUsd;
    } catch {
      return null;
    }
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return null;
    total += cost;
    seen = true;
  }
  return seen ? total : null;
}

interface AttemptSpend {
  taskId: string;
  attempt: number;
  startedAtMs: number;
  costUsd: number | null;
}

/** Everything a "cost-recorded" event's `details` carries. */
export interface CostRecordedDetails {
  usd: number;
  /** The attempts whose unknown cost this figure covers. */
  attempts: number[];
}

interface HandCost extends CostRecordedDetails {
  taskId: string;
}

function receiptsIn(event: FabricaEvent): Receipt[] {
  const details = event.details as { receipt?: Receipt; receipts?: Receipt[] } | undefined;
  if (event.name === "receipt-recorded" && details?.receipt) return [details.receipt];
  return Array.isArray(details?.receipts) ? details.receipts : [];
}

function ledger(events: FabricaEvent[]): { attempts: AttemptSpend[]; handCosts: HandCost[] } {
  const byAttempt = new Map<string, AttemptSpend>();
  const handCosts: HandCost[] = [];
  for (const event of events) {
    if (event.name === "cost-recorded") {
      const details = event.details as CostRecordedDetails;
      handCosts.push({ taskId: event.taskId, usd: details.usd, attempts: details.attempts });
      continue;
    }
    for (const receipt of receiptsIn(event)) {
      const key = `${receipt.task}\u0000${receipt.attempt}`;
      if (byAttempt.has(key)) continue;
      byAttempt.set(key, {
        taskId: receipt.task,
        attempt: receipt.attempt,
        startedAtMs: Date.parse(receipt.startedAt),
        costUsd: typeof receipt.costUsd === "number" ? receipt.costUsd : null,
      });
    }
  }
  return { attempts: [...byAttempt.values()], handCosts };
}

function isCovered(handCosts: HandCost[], attempt: AttemptSpend): boolean {
  return handCosts.some((h) => h.taskId === attempt.taskId && h.attempts.includes(attempt.attempt));
}

/** Every task with an attempt whose cost is unknown and has not been
 * recorded by hand - no matter how old it is. While a cap is set, each
 * one blocks new work until `fabrica cost` records its real figure. */
export function unmeasuredSpend(events: FabricaEvent[]): { taskId: string; attempts: number[] }[] {
  const { attempts, handCosts } = ledger(events);
  const byTask = new Map<string, number[]>();
  for (const attempt of attempts) {
    if (attempt.costUsd !== null || isCovered(handCosts, attempt)) continue;
    byTask.set(attempt.taskId, [...(byTask.get(attempt.taskId) ?? []), attempt.attempt]);
  }
  return Array.from(byTask, ([taskId, list]) => ({ taskId, attempts: list }));
}

/** Known spend over the last 24 hours, ending at `now`. A hand-recorded
 * cost counts when any attempt it covers started inside the window. */
export function daySpend(events: FabricaEvent[], now: number): { knownUsd: number } {
  const since = now - DAY_WINDOW_MS;
  const { attempts, handCosts } = ledger(events);
  let knownUsd = 0;
  for (const attempt of attempts) {
    if (attempt.costUsd !== null && attempt.startedAtMs >= since) knownUsd += attempt.costUsd;
  }
  for (const hand of handCosts) {
    const covered = attempts.filter((a) => a.taskId === hand.taskId && hand.attempts.includes(a.attempt));
    if (covered.some((a) => a.startedAtMs >= since)) knownUsd += hand.usd;
  }
  return { knownUsd };
}

/** One task's own spend across every round: known dollars (measured or
 * recorded by hand) and, separately, the attempts still unknown. */
export function taskSpend(events: FabricaEvent[], taskId: string): { knownUsd: number; unknownAttempts: number[] } {
  const { attempts, handCosts } = ledger(events.filter((e) => e.taskId === taskId));
  let knownUsd = handCosts.reduce((sum, h) => sum + h.usd, 0);
  const unknownAttempts: number[] = [];
  for (const attempt of attempts) {
    if (attempt.costUsd !== null) knownUsd += attempt.costUsd;
    else if (!isCovered(handCosts, attempt)) unknownAttempts.push(attempt.attempt);
  }
  return { knownUsd, unknownAttempts };
}

/** Whether `taskId` has run any attempt at all - "no attempts yet" is a
 * different fact from "spent $0.00". */
export function hasAttempts(events: FabricaEvent[], taskId: string): boolean {
  return events.some((e) => e.taskId === taskId && receiptsIn(e).length > 0);
}

/** Dollars for a person to read: cents when that is exact ("$6.50"),
 * otherwise up to four decimals ("$0.0421"). */
export function formatUsd(usd: number): string {
  const cents = usd.toFixed(2);
  if (Number(cents) === usd) return `$${cents}`;
  if (usd > 0 && usd < 0.0001) return "under $0.0001";
  return `$${usd.toFixed(4).replace(/(\.\d\d\d?)0+$/, "$1")}`;
}

/** A task's cost in one phrase - never blank, and never $0 for spend
 * nobody measured. */
export function describeTaskCost(spend: { knownUsd: number; unknownAttempts: number[] }, hasAttempts: boolean): string {
  if (!hasAttempts) return "no attempts yet";
  if (spend.unknownAttempts.length === 0) return formatUsd(spend.knownUsd);
  return spend.knownUsd > 0 ? `unknown (${formatUsd(spend.knownUsd)} measured)` : "unknown";
}

/** The one wording for the SPEND UNKNOWN block, shared by the refusal,
 * a stopped task's report, and `fabrica status`. */
export const SPEND_UNKNOWN_LINE = "SPEND UNKNOWN - tasks blocked";

export function describeUnmeasured(unmeasured: { taskId: string; attempts: number[] }[]): string[] {
  return unmeasured.map(
    ({ taskId, attempts }) =>
      `task ${taskId}, attempt${attempts.length === 1 ? "" : "s"} ${attempts.join(", ")}: ` +
      `record its real cost with \`fabrica cost ${taskId} <usd>\``
  );
}
