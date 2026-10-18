// Read-side of the loop: everything do() writes to events.jsonl, read
// back. events.jsonl is the single source of truth (SPEC.md "The
// record") - deliveryOf and receiptsOf don't parse delivery.md. Delivery
// comes from the latest "delivered" event unless a newer Inspector refusal
// superseded it, while receipts come from the latest event carrying them.

import { readEvents, readEventsForTask } from "../record/index.ts";
import type { FabricaEvent } from "../record/index.ts";
import type { Receipt } from "../../contract/surface.ts";
import type { Delivery, FabricaTask } from "../inspector/types.ts";
import { deliveredState } from "./delivery.ts";

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
  const events = readEventsForTask(recordHome, taskId);
  const deliveredIndex = events.map((event) => event.name).lastIndexOf("delivered");
  const refusedIndex = events
    .map(
      (event) =>
        event.name === "inspection-finished" &&
        (event.details as { verdict?: string } | undefined)?.verdict === "refused"
    )
    .lastIndexOf(true);
  if (refusedIndex > deliveredIndex) return null;
  return (events[deliveredIndex]?.details as DeliveredDetails | undefined)?.delivery ?? null;
}

/** True exactly when Inspector refused before this task ever reached a
 * delivery at all — nothing to accept or fix (no delivery details to
 * reopen a line from, no brain memory of a verdict to repair toward), but
 * a real terminal outcome the Client can still close with a "wrong"
 * verdict (rule 6's one exception for this state) rather than being stuck
 * refusing every ruling forever. Deliberately narrower than "the latest
 * inspection-finished is a refusal" (deliveryOf's own check, above): a fix
 * round's refusal that supersedes an EARLIER real delivery still has that
 * delivery for the Client to rule on directly, so it is not this case. */
export function refusedWithNoDelivery(events: FabricaEvent[]): boolean {
  const deliveredIndex = events.map((event) => event.name).lastIndexOf("delivered");
  if (deliveredIndex !== -1) return false;
  const latestInspection = events.filter((event) => event.name === "inspection-finished").at(-1);
  return (latestInspection?.details as { verdict?: string } | undefined)?.verdict === "refused";
}

export function receiptsOf(recordHome: string, taskId: string): Receipt[] {
  const events = readEventsForTask(recordHome, taskId);
  const receiptEvent = events
    .filter((event) => Array.isArray((event.details as { receipts?: unknown } | undefined)?.receipts))
    .at(-1);
  const receipts = [...((receiptEvent?.details as { receipts?: Receipt[] } | undefined)?.receipts ?? [])];
  // An attempt that ended with no delivery (Inspector refused) is on the
  // record only as its own "receipt-recorded" event.
  for (const event of events) {
    const receipt = event.name === "receipt-recorded" ? (event.details as { receipt?: Receipt }).receipt : undefined;
    if (receipt && !receipts.some((r) => r.attempt === receipt.attempt)) receipts.push(receipt);
  }
  return receipts.sort((a, b) => a.attempt - b.attempt);
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
 * hand - not something this ordinary status/log/watch work needs to touch.
 *
 * One state is absorbing rather than overwritable: "stopped" (issue
 * #203, the Client's own stop). See the loop's first lines for why. */
export function stateOf(events: FabricaEvent[]): FabricaTask["state"] {
  let state: FabricaTask["state"] = "working";
  let begun = false;
  let stoppedByOwner = false;

  for (const event of events) {
    // Issue #203: once the Client has stopped the task, that is the
    // fact. The detached process is being signaled, not asked, so
    // whatever it still manages to append on its way down (a last
    // heartbeat, a check-run, even a delivery from work already
    // finished) is kept on the record but must never move the task back
    // to looking alive. His own verdict is the one thing that still
    // can - "accept"/"wrong" close it, exactly as for any other task.
    if (stoppedByOwner && event.name !== "verdict-recorded") continue;

    switch (event.name) {
      case "stopped-by-owner":
        state = "stopped";
        stoppedByOwner = true;
        break;
      case "cap-refused":
        // Rule 10 refused this task's very first start - it never ran and
        // never will (a new `fabrica do` is a new task). A refused resume
        // or fix leaves the state as it was: that task can still be
        // answered or fixed once there is room.
        if (!begun) state = "failed";
        break;
      case "task-received":
        break;
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
      case "task-failed":
        // #73: any error after task-received and before a delivery.
        state = "failed";
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
      case "inspector-called":
        state = "working";
        break;
      case "inspection-finished": {
        const details = event.details as { verdict?: string } | undefined;
        state = details?.verdict === "refused" ? "refused" : "working";
        break;
      }
      case "inspection-skipped":
        state = "working";
        break;
      case "delivered": {
        // A fix round appends a second "delivered" event on the same
        // task; the forward pass naturally lands on the last one.
        const details = event.details as { outcome?: Delivery["outcome"] } | undefined;
        state = deliveredState(details?.outcome);
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
    if (event.name !== "task-received" && event.name !== "cap-refused") begun = true;
  }

  return state;
}

/** True exactly when a task failed before it ever reached a delivery -
 * `brain.ask()` threw ("ask-failed"), a spending cap refused its very
 * first start ("cap-refused" before the task ever began), or some other
 * error killed it first ("task-failed") - and nothing since has moved it
 * anywhere else. Mirrors `refusedWithNoDelivery`'s reasoning for
 * Inspector's own refusal: there is no delivery for "accept" or "fix" to
 * work with, and no warm worker or line left to reopen, but "wrong" needs
 * none of that and can still close it (issue #143) instead of leaving it
 * stuck refusing every ruling forever. Checks for no "delivered" event
 * anywhere in the task's history, not just since the latest failure, for
 * the same reason `refusedWithNoDelivery` does: a fix round's own failure
 * that comes AFTER an earlier real delivery is a different case - that
 * delivery is still there for the Client to rule on. */
export function failedWithNoDelivery(events: FabricaEvent[]): boolean {
  if (events.some((event) => event.name === "delivered")) return false;
  return stateOf(events) === "failed";
}

/** The one thing worth telling the Client about a task that is waiting on
 * a "wrong" verdict despite never reaching a delivery - `null` for every
 * other task (still open, delivered, or already closed). `fabrica status`
 * and the phone review page (issue #202 follow-up: "show every task
 * waiting on me") both call this instead of each working out their own
 * wording, so the reason shown in one can never disagree with the reason
 * shown in the other. "refused" names Inspector's own report
 * (`inspection-finished`'s `report` field) rather than the generic
 * "Inspector reached no verdict" label `nameLastSignal` uses elsewhere -
 * here, the actual words matter. "failed" names whichever of
 * `"cap-refused"`/`"task-failed"`/`"ask-failed"` actually killed the task,
 * in that order (a cap refusal before any work started takes precedence
 * since it's the most specific; "ask-failed" has no matching "task-failed"
 * - see task-failure.ts's `alreadyRecorded`), falling back to the same
 * generic sentence `formatStatusLine` always used to. */
export function earlyStopKindOf(events: FabricaEvent[]): { kind: "refused" | "failed"; reason: string } | null {
  if (refusedWithNoDelivery(events)) {
    const latestInspection = events.filter((event) => event.name === "inspection-finished").at(-1);
    const report = (latestInspection?.details as { report?: string } | undefined)?.report;
    return { kind: "refused", reason: report ?? "Inspector reached no verdict" };
  }
  if (failedWithNoDelivery(events)) {
    return { kind: "failed", reason: earlyFailureReason(events) };
  }
  return null;
}

function earlyFailureReason(events: FabricaEvent[]): string {
  const refusedByCap = events.some((event) => event.name === "cap-refused") && !events.some((event) => event.name === "work-started");
  if (refusedByCap) {
    const message = (events.filter((event) => event.name === "cap-refused").at(-1)?.details as { message?: string } | undefined)
      ?.message;
    return message ?? "a spending cap refused it before any work started";
  }
  const taskFailedMessage = (events.filter((event) => event.name === "task-failed").at(-1)?.details as
    | { message?: string }
    | undefined)?.message;
  if (taskFailedMessage) return taskFailedMessage.split("\n")[0];
  const askFailedMessage = (events.filter((event) => event.name === "ask-failed").at(-1)?.details as
    | { error?: string }
    | undefined)?.error;
  if (askFailedMessage) return askFailedMessage;
  return "brain's clarify step threw before any work started";
}
