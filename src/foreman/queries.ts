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
 * the whole record just to ask. */
export function stateOf(events: FabricaEvent[]): FabricaTask["state"] {
  // The task closes only once the Client's MOST RECENT verdict is "accept"
  // or "wrong" — a "fix" verdict is recorded on the record too (rule 6:
  // "verdict-recorded goes on the record every time"), but it reopens the
  // loop rather than closing it, so the events after it (a fresh
  // work-started/check-run/delivered round) are what state should reflect.
  const lastVerdict = events.filter((e) => e.name === "verdict-recorded").at(-1);
  if (lastVerdict) {
    const ruling = (lastVerdict.details as { ruling?: string } | undefined)?.ruling;
    if (ruling === "accept" || ruling === "wrong") return "closed";
  }

  // A fix round appends a second "delivered" event on the same task; the
  // last one is the one that reflects where things stand now.
  const delivered = events.filter((e) => e.name === "delivered").at(-1);
  if (delivered) {
    const details = delivered.details as { outcome?: Delivery["outcome"] } | undefined;
    return details?.outcome === "done" ? "delivered" : "failed";
  }

  // brain.ask() itself threw (issue #8 follow-up, Client ruling) - the
  // task never got past its own first step, so it is failed, not still
  // "working" or silently invisible. Checked before check-run/work-started
  // only for read order; the two never coexist; a task whose ask() threw
  // never reaches either.
  if (events.some((e) => e.name === "ask-failed")) return "failed";

  if (events.some((e) => e.name === "check-run")) return "checking";
  if (events.some((e) => e.name === "work-started")) return "working";
  // The Client already answered (issue #8) - even if runProductionRound
  // then failed before ever reaching "work-started" (e.g. a missing
  // check command), "asking" below would wrongly suggest the answer
  // never registered.
  if (events.some((e) => e.name === "answers-given")) return "working";
  if (events.some((e) => e.name === "questions-asked")) return "asking";
  return "working";
}
