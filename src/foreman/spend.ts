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
import type { TranscriptEntry } from "../../contract/surface.ts";
import type { Receipt } from "../inspector/types.ts";

/** The daily cap's window: a rolling 24 hours ending now, not a calendar
 * day - so there is no midnight at which a day's spend resets at once. */
export const DAY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** What one attempt's usage entries add up to: the dollar figure (null if
 * unknown), and whether that figure is real, billed money or a flat-rate
 * subscription's own notional estimate (issue #188). */
export interface AttemptCost {
  costUsd: number | null;
  costBasis: "metered" | "subscription-estimate";
}

/** contract/surface.ts's TranscriptEntry: an entry with kind "usage"
 * carries `{ totalCostUsd: number | null, costBasis?: ..., ... }`. The
 * attempt's cost is the sum of them all, and unknown (null) if any one is
 * null or unreadable, or there is none at all. `costBasis` defaults to
 * "metered" when an entry omits it (the conservative default - an
 * adapter that says nothing is still held to the caps); the last entry
 * to declare "subscription-estimate" wins, since a real attempt carries
 * exactly one usage entry from one adapter in practice. */
export function costFromTranscript(transcript: TranscriptEntry[]): AttemptCost {
  let total = 0;
  let seen = false;
  let costBasis: "metered" | "subscription-estimate" = "metered";
  for (const entry of transcript) {
    if (entry.kind !== "usage") continue;
    let parsed: { totalCostUsd?: unknown; costBasis?: unknown } | null;
    try {
      parsed = JSON.parse(entry.text) as { totalCostUsd?: unknown; costBasis?: unknown } | null;
    } catch {
      return { costUsd: null, costBasis };
    }
    const cost = parsed?.totalCostUsd;
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return { costUsd: null, costBasis };
    total += cost;
    seen = true;
    if (parsed?.costBasis === "subscription-estimate") costBasis = "subscription-estimate";
  }
  return { costUsd: seen ? total : null, costBasis };
}

interface AttemptSpend {
  taskId: string;
  attempt: number;
  startedAtMs: number;
  costUsd: number | null;
  /** Issue #188: defaults to "metered" for the clarifying step (whose
   * BrainAskResult has no basis field of its own) and for any stored
   * receipt from before this field existed. */
  costBasis: "metered" | "subscription-estimate";
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

/** Inside this ledger the clarifying step (ask()) is attempt 0 - spend
 * like any attempt's, but never a Receipt (receiptsOf never sees it). */
export const CLARIFYING_STEP = 0;

function askSpendIn(event: FabricaEvent): AttemptSpend | undefined {
  if (event.name !== "ask-cost-recorded") return undefined;
  const details = event.details as { costUsd?: number | null; startedAt?: string };
  return {
    taskId: event.taskId,
    attempt: CLARIFYING_STEP,
    startedAtMs: Date.parse(details.startedAt ?? event.occurredAt),
    costUsd: typeof details.costUsd === "number" ? details.costUsd : null,
    costBasis: "metered",
  };
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
    const ask = askSpendIn(event);
    if (ask) {
      byAttempt.set(`${ask.taskId}\u0000${ask.attempt}`, ask);
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
        costBasis: receipt.costBasis === "subscription-estimate" ? "subscription-estimate" : "metered",
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

/** Known spend, split by whether it is real, billed money or a flat-rate
 * subscription's own notional estimate (issue #188). Rule 10's caps bind
 * only on `meteredUsd` - `subscriptionUsd` is recorded and shown, never
 * refused on its own. A hand-recorded cost (`fabrica cost`) is always
 * metered: the owner is vouching for a real figure. */
export interface SpendTotals {
  meteredUsd: number;
  subscriptionUsd: number;
}

/** Known spend over the last 24 hours, ending at `now`. A hand-recorded
 * cost counts when any attempt it covers started inside the window. */
export function daySpend(events: FabricaEvent[], now: number): SpendTotals {
  const since = now - DAY_WINDOW_MS;
  const { attempts, handCosts } = ledger(events);
  let meteredUsd = 0;
  let subscriptionUsd = 0;
  for (const attempt of attempts) {
    if (attempt.costUsd === null || attempt.startedAtMs < since) continue;
    if (attempt.costBasis === "subscription-estimate") subscriptionUsd += attempt.costUsd;
    else meteredUsd += attempt.costUsd;
  }
  for (const hand of handCosts) {
    const covered = attempts.filter((a) => a.taskId === hand.taskId && hand.attempts.includes(a.attempt));
    if (covered.some((a) => a.startedAtMs >= since)) meteredUsd += hand.usd;
  }
  return { meteredUsd, subscriptionUsd };
}

/** One task's own spend across every round: known dollars (measured or
 * recorded by hand), split the same way `daySpend` is, and, separately,
 * the attempts still unknown. */
export function taskSpend(events: FabricaEvent[], taskId: string): SpendTotals & { unknownAttempts: number[] } {
  const { attempts, handCosts } = ledger(events.filter((e) => e.taskId === taskId));
  let meteredUsd = handCosts.reduce((sum, h) => sum + h.usd, 0);
  let subscriptionUsd = 0;
  const unknownAttempts: number[] = [];
  for (const attempt of attempts) {
    if (attempt.costUsd !== null) {
      if (attempt.costBasis === "subscription-estimate") subscriptionUsd += attempt.costUsd;
      else meteredUsd += attempt.costUsd;
    } else if (!isCovered(handCosts, attempt)) unknownAttempts.push(attempt.attempt);
  }
  return { meteredUsd, subscriptionUsd, unknownAttempts };
}

/** Whether `taskId` has run any attempt at all - "no attempts yet" is a
 * different fact from "spent $0.00". */
export function hasAttempts(events: FabricaEvent[], taskId: string): boolean {
  return events.some((e) => e.taskId === taskId && (receiptsIn(e).length > 0 || askSpendIn(e) !== undefined));
}

/** Dollars for a person to read: cents when that is exact ("$6.50"),
 * otherwise up to four decimals ("$0.0421"). */
export function formatUsd(usd: number): string {
  const cents = usd.toFixed(2);
  if (Number(cents) === usd) return `$${cents}`;
  if (usd > 0 && usd < 0.0001) return "under $0.0001";
  return `$${usd.toFixed(4).replace(/(\.\d\d\d?)0+$/, "$1")}`;
}

/** The known part of a spend, worded for a person: metered dollars alone
 * read exactly as before this field existed ("$6.50"); a subscription
 * estimate is marked with a "~" and named, so it is never mistaken for
 * billed money (issue #188). */
function formatKnownCost(spend: SpendTotals): string {
  if (spend.subscriptionUsd === 0) return formatUsd(spend.meteredUsd);
  if (spend.meteredUsd === 0) return `~${formatUsd(spend.subscriptionUsd)} subscription-estimate`;
  return `${formatUsd(spend.meteredUsd)} + ~${formatUsd(spend.subscriptionUsd)} subscription-estimate`;
}

/** A task's cost in one phrase - never blank, and never $0 for spend
 * nobody measured. */
export function describeTaskCost(spend: SpendTotals & { unknownAttempts: number[] }, hasAttempts: boolean): string {
  if (!hasAttempts) return "no attempts yet";
  const known = formatKnownCost(spend);
  if (spend.unknownAttempts.length === 0) return known;
  return spend.meteredUsd > 0 || spend.subscriptionUsd > 0 ? `unknown (${known} measured)` : "unknown";
}

/** The one wording for the SPEND UNKNOWN block, shared by the refusal,
 * a stopped task's report, and `fabrica status`. */
export const SPEND_UNKNOWN_LINE = "SPEND UNKNOWN - tasks blocked";

export function describeUnmeasured(unmeasured: { taskId: string; attempts: number[] }[]): string[] {
  return unmeasured.map(({ taskId, attempts }) => {
    const parts: string[] = [];
    if (attempts.includes(CLARIFYING_STEP)) parts.push("the clarifying step");
    const real = attempts.filter((a) => a !== CLARIFYING_STEP);
    if (real.length > 0) parts.push(`attempt${real.length === 1 ? "" : "s"} ${real.join(", ")}`);
    return `task ${taskId}, ${parts.join(" and ")}: record its real cost with \`fabrica cost ${taskId} <usd>\``;
  });
}
