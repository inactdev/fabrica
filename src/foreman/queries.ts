// Read-side of the loop: everything do() writes to events.jsonl, read
// back. events.jsonl is the single source of truth (SPEC.md "The
// record") — deliveryOf and receiptsOf don't parse delivery.md; they read
// the same "delivered" event do() wrote, which carries the structured
// Delivery and Receipt[] in its `details`.

import { readEvents, readEventsForTask } from "../record/index.ts";
import type { FabricaEvent } from "../record/index.ts";
import type { Delivery, FabricaTask, Receipt } from "../../contract/surface.ts";

export function eventsOf(recordHome: string, taskId: string): FabricaEvent[] {
  return readEventsForTask(recordHome, taskId);
}

/** Everything a "delivered" event's `details` carries. A fix round (rule
 * 6) appends a second "delivered" event on the same task, so every reader
 * of this shape must look at the LAST one, not the first — `project`,
 * `totalAttempts`, and `baseCommit` are carried forward round to round so
 * a later fix round can still find them. */
export interface DeliveredDetails {
  outcome?: Delivery["outcome"];
  delivery?: Delivery;
  receipts?: Receipt[];
  /** Resolved project path the ProductionLine was cut from — verdict's
   * "fix" path needs this to reopen the same line; not part of the
   * contract's Delivery shape, so it rides along here instead. */
  project?: string;
  /** The attempt budget `do()` was given for this task (SPEC.md's
   * default of 2, or whatever was passed explicitly) — persisted purely
   * as a record of what `do()` ran with, not as a ceiling on anything:
   * the fix path gets no budget at all (issue #65) and reads this for
   * no decision. */
  totalAttempts?: number;
  /** The fork point `diffFiles` pins to (src/delivery/diff-files.ts) —
   * carried forward so a fix round's delivery still reports the full
   * cumulative diff since the task's first attempt, not just its own. */
  baseCommit?: string;
}

export function deliveryOf(recordHome: string, taskId: string): Delivery | null {
  const details = latestDeliveredDetails(recordHome, taskId);
  return details?.delivery ?? null;
}

export function receiptsOf(recordHome: string, taskId: string): Receipt[] {
  const details = latestDeliveredDetails(recordHome, taskId);
  return details?.receipts ?? [];
}

/** The most recent "delivered" event's details — a fix round appends a
 * new one on top of the original, and the latest is always the one that
 * reflects the task's current state. */
export function latestDeliveredDetails(recordHome: string, taskId: string): DeliveredDetails | undefined {
  const delivered = readEventsForTask(recordHome, taskId)
    .filter((e) => e.name === "delivered")
    .at(-1);
  return delivered?.details as DeliveredDetails | undefined;
}

/** How many "fix" verdicts a task has had so far, including the most
 * recent one — rule 6's fix path has no attempt budget (issue #65: "he
 * is the stop condition", not a counter), but each round still reports
 * which one it is. Derived from the record's own verdict-recorded
 * events rather than stored separately, so there is nothing to drift. */
export function fixRoundOf(recordHome: string, taskId: string): number {
  return readEventsForTask(recordHome, taskId).filter(
    (e) => e.name === "verdict-recorded" && (e.details as { ruling?: string } | undefined)?.ruling === "fix"
  ).length;
}

/** Every task's events, grouped by task id, from a single pass over
 * events.jsonl. A reader that needs both the task list and each task's
 * events (`fabrica status`) asks for this once instead of reading the
 * whole log again per task. */
export function eventsByTask(recordHome: string): Map<string, FabricaEvent[]> {
  const byTask = new Map<string, FabricaEvent[]>();
  for (const event of readEvents(recordHome)) {
    const list = byTask.get(event.taskId);
    if (list) list.push(event);
    else byTask.set(event.taskId, [event]);
  }
  return byTask;
}

export function statusOf(recordHome: string): FabricaTask[] {
  return Array.from(eventsByTask(recordHome), ([id, events]) => ({ id, state: stateOf(events) }));
}

/** Where a task stands, derived from its own events alone - so a caller
 * already holding them (`fabrica watch`, polling one task) never re-reads
 * the whole record just to ask. A single forward pass, letting each event
 * overwrite `state` in place - equivalent to (and replacing) separately
 * filtering for the LAST verdict/delivered/check-run, but it also gets
 * "checking" right: a "check-run" event now lands twice per attempt
 * (`details.phase === "started"` right before the check runs - see
 * attempts.ts's `onCheckStarted` - and the existing result-carrying one
 * once it finishes), so a task genuinely mid-check is distinguishable
 * from one that already has a finished check-run sitting in its history.
 * Reusing "check-run" rather than a new event name keeps this out of
 * `contract/surface.ts` (its closed `FabricaEventName` union), which the
 * rule9-gate CI check treats as a protected path the Client merges by
 * hand - not something this ordinary status/log/watch work needs to touch. */
export function stateOf(events: FabricaEvent[]): FabricaTask["state"] {
  let state: FabricaTask["state"] = "working";

  for (const event of events) {
    switch (event.name) {
      case "questions-asked":
        state = "asking";
        break;
      case "answers-given":
        // The Client already answered (issue #8) - even if
        // runProductionRound then fails before ever reaching
        // "work-started" (e.g. a missing check command), staying on
        // "asking" would wrongly suggest the answer never registered.
        state = "working";
        break;
      case "ask-failed":
        // brain.ask() itself threw (issue #8 follow-up, Client ruling) -
        // the task never got past its own first step, so it's failed,
        // not still "working" or silently invisible.
        state = "failed";
        break;
      case "work-started":
        state = "working";
        break;
      case "check-run": {
        const details = event.details as { phase?: string } | undefined;
        state = details?.phase === "started" ? "checking" : "working";
        break;
      }
      case "delivered": {
        // A fix round appends a second "delivered" event on the same
        // task; the forward pass naturally lands on the last one.
        const details = event.details as { outcome?: Delivery["outcome"] } | undefined;
        state = details?.outcome === "done" ? "delivered" : "failed";
        break;
      }
      case "verdict-recorded": {
        // The task closes only once the Client's MOST RECENT verdict is
        // "accept" or "wrong" - a "fix" verdict is recorded too (rule 6:
        // "verdict-recorded goes on the record every time") but reopens
        // the loop rather than closing it, so it leaves `state` alone;
        // the fresh work-started/check-run/delivered round that follows
        // is what should override it.
        const ruling = (event.details as { ruling?: string } | undefined)?.ruling;
        if (ruling === "accept" || ruling === "wrong") state = "closed";
        break;
      }
      default:
        break;
    }
  }

  return state;
}
