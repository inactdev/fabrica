// Read-side of the loop: everything do() writes to events.jsonl, read
// back. events.jsonl is the single source of truth (SPEC.md "The
// record") - deliveryOf and receiptsOf don't parse delivery.md. Delivery
// comes from the latest "delivered" event unless a newer Inspector refusal
// superseded it, while receipts come from the latest event carrying them.

import { readEvents, readEventsForTask } from "../record/index.ts";
import type { FabricaEvent, FabricaEventName } from "../record/index.ts";
import type { Delivery, FabricaTask, Receipt } from "../inspector/types.ts";
import { deliveredState } from "./delivery.ts";
import { UNSTAMPED_OLD_RECORD } from "./fingerprint.ts";
import type { DeliveryStamp, PassFingerprint } from "./fingerprint.ts";

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
  /** THIS round's receipts only (issue #68). It used to be every receipt
   * the task had ever produced, re-stored on every round's event, so four
   * fix rounds stored ten sets of receipts and `src/record/read.ts`
   * parsed all of them for every query. The cumulative view is
   * reconstructed on read instead - `receiptsOf` below. */
  receipts?: Receipt[];
  /** How many attempts the task has had in all, this round's included -
   * the one cumulative fact a reader holding a single event cannot
   * reconstruct from `receipts` any more. Absent on an event written
   * before issue #68, where `receipts.length` was this same number. */
  attemptsSoFar?: number;
  /** Rule 9: the gate declarations THIS round's worker passes made, in
   * order - the raw text, not the merged `delivery.gateChanges` the whole
   * task reports. Kept per round for the same reason `receipts` is, and
   * read back by `gateDeclarationsOf` below. Absent on an event written
   * before issue #68. */
  gateDeclarations?: string[];
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
   * cumulative diff since the task's first attempt, not just its own.
   * A fix round that rebased the branch onto origin's current tip
   * (issue #235) records that tip here instead, since it is the branch's
   * fork point from then on. */
  baseCommit?: string;
  /** Present exactly when this delivery IS a rebase conflict report
   * (issue #235) - the host could not bring the branch up to origin's
   * default branch, even after this round's own worker was handed the
   * stopped rebase, so what is left is a conflict only the Client can
   * rule on. Bookkeeping only: nothing branches on it. It used to be the
   * one field the next fix round read, back when a first conflict was
   * reported before any worker saw it; conflict handling is one round now
   * (see `src/foreman/README.md`) and no round asks what shape the
   * previous delivery was. */
  rebaseConflict?: { base: string; files: string[] };
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

/** The Inspector refusal a `fix` verdict would be answering, or null when
 * the task's latest word is not one: exactly the other side of
 * `refusedWithNoDelivery` above - the latest `"inspection-finished"` is a
 * refusal, it is newer than the task's last `"delivered"` event, and
 * there IS such an event behind it.
 *
 * That combination is the one the Client can still rule `fix` on. The
 * earlier delivery holds everything a round needs to reopen the line
 * (project, baseCommit), and the refusal itself - Inspector reached no
 * verdict, so nothing about the work was judged - is what the next round
 * is being asked to clear, carried into the worker's brief as its
 * correction (`verdict.ts`'s `refusalCorrection`). A refusal with no
 * delivery behind it has none of that and stays closable by `wrong`
 * alone. `report` is Inspector's own words, already bounded for the
 * record by `reportForRecord` (`src/inspector/run.ts`). */
export function refusalAfterDelivery(events: FabricaEvent[]): { report: string } | null {
  const deliveredIndex = events.map((event) => event.name).lastIndexOf("delivered");
  if (deliveredIndex === -1) return null;
  const latestInspection = events.filter((event) => event.name === "inspection-finished").at(-1);
  if (latestInspection === undefined) return null;
  if (events.lastIndexOf(latestInspection) < deliveredIndex) return null;
  const details = latestInspection.details as { verdict?: string; report?: string } | undefined;
  if (details?.verdict !== "refused") return null;
  return { report: details.report ?? "Inspector reached no verdict and said nothing about why" };
}

/**
 * The red read of the pull request's own checks that the task's CURRENT
 * delivery was built from (issue #267), or null when that delivery was
 * not red on them. What a `fix` round hands its worker as a correction,
 * alongside the Client's own note - the counterpart of
 * `refusalAfterDelivery` above, and read back off the record for the
 * same reason everything else a fix round needs is: nothing is threaded
 * across the detached-process boundary (issue #123).
 *
 * Scoped to one round deliberately. A round appends, in order,
 * `"work-started"`, then (per attempt) `"ci-checks-finished"`, then
 * `"delivered"` - so the latest `"ci-checks-finished"` lying between the
 * last `"delivered"` and the `"work-started"` before it is exactly the
 * read that delivery reports. Taking "the latest one anywhere" instead
 * would hand a worker a stale red from two rounds ago whenever the round
 * that actually delivered never reached a pull request at all (Inspector
 * red, an invalid write-up, a rebase conflict).
 *
 * `summary` is the one-phrase version for a line of prose; `output` is
 * the full per-check output and job-log tails, read off the receipt of
 * the last attempt that was judged - rebuilding them from the per-check
 * events would be a second renderer to keep in step with
 * `src/ci/report.ts`. It used to be read off the delivery's own
 * `evidence`, which carried a byte-identical second copy of that same
 * receipt field; issue #68 made `evidence` a pointer plus an excerpt, so
 * the receipt is read directly. A record written before that still has
 * the whole text on `evidence`, which is the fallback.
 */
export function redPublishedChecksOf(events: FabricaEvent[]): { summary: string; output: string } | null {
  const names = events.map((event) => event.name);
  const deliveredIndex = names.lastIndexOf("delivered");
  if (deliveredIndex === -1) return null;
  const roundStart = names.lastIndexOf("work-started", deliveredIndex);
  let found: FabricaEvent | undefined;
  for (let i = deliveredIndex; i > roundStart; i--) {
    if (names[i] === "ci-checks-finished") {
      found = events[i];
      break;
    }
  }
  const details = found?.details as { verdict?: string; summary?: string } | undefined;
  if (details?.verdict !== "red") return null;
  const delivered = events[deliveredIndex].details as DeliveredDetails | undefined;
  const judged = [...(delivered?.receipts ?? [])].reverse().find((receipt) => receipt.checks !== null);
  const output =
    typeof judged?.checks?.output === "string" && judged.checks.output.trim().length > 0
      ? judged.checks.output
      : typeof delivered?.delivery?.evidence === "string"
        ? delivered.delivery.evidence
        : "";
  if (output.trim().length === 0) return null;
  return { summary: details.summary ?? "the pull request's own checks went red", output };
}

export function receiptsOf(recordHome: string, taskId: string): Receipt[] {
  return reconstructReceipts(readEventsForTask(recordHome, taskId));
}

/**
 * Every receipt one task has produced, across every round, keyed by
 * attempt number - the cumulative view issue #68 stopped storing and
 * reconstructs on read instead. Takes the events the caller already
 * holds, for the same reason `deliveredBranchOf` does.
 *
 * Two sources, both walked: each attempt's own `"receipt-recorded"`
 * event, and the per-round list every `"delivered"` event carries. Both
 * are needed - an attempt that ended with no delivery (Inspector refused)
 * is only ever on the first, and a delivery is the only place a receipt
 * the round itself corrected lands (round.ts's commit-failure path marks
 * its last receipt `"failed"` after that receipt's own event was already
 * appended).
 *
 * LATEST wins per attempt, which is what makes both of those true at
 * once: the corrected copy comes after the original, so it stands. It is
 * also what makes a record written BEFORE issue #68 read back exactly as
 * it did then, with no migration and nothing rewritten - every one of its
 * "delivered" events carries the whole history, so the newest restatement
 * of each attempt is the one that survives, which is the value its own
 * delivery reported.
 */
export function reconstructReceipts(events: FabricaEvent[]): Receipt[] {
  const byAttempt = new Map<number, Receipt>();
  for (const event of events) {
    const details = event.details as { receipt?: Receipt; receipts?: unknown } | undefined;
    const carried: Receipt[] = [
      ...(event.name === "receipt-recorded" && details?.receipt ? [details.receipt] : []),
      ...(Array.isArray(details?.receipts) ? (details.receipts as Receipt[]) : []),
    ];
    for (const receipt of carried) {
      if (typeof receipt?.attempt === "number") byAttempt.set(receipt.attempt, receipt);
    }
  }
  return [...byAttempt.values()].sort((a, b) => a.attempt - b.attempt);
}

/**
 * Every gate declaration (rule 9) a task's rounds have made, oldest
 * first - what `gate-declarations.ts`'s `mergeGateDeclarations` folds
 * into the one text the next round's delivery reports. Read off the
 * `"delivered"` events rather than carried forward through the previous
 * delivery's already-merged string, so each round's own words stay
 * separable and a declaration can be keyed by the gate it names.
 *
 * Read-side tolerance for a record written before issue #68, where no
 * event carried a declaration of its own: that event's delivery held the
 * merged, cumulative text, so it is taken whole as one declaration. That
 * can only ever report more than the newest round's words, never less -
 * the direction a rule 9 declaration must fail in.
 */
export function gateDeclarationsOf(events: FabricaEvent[]): string[] {
  const declarations: string[] = [];
  for (const event of events) {
    if (event.name !== "delivered") continue;
    const details = event.details as DeliveredDetails | undefined;
    if (Array.isArray(details?.gateDeclarations)) {
      for (const text of details.gateDeclarations) {
        if (typeof text === "string" && text.trim().length > 0) declarations.push(text);
      }
      continue;
    }
    const merged = details?.delivery?.gateChanges;
    if (typeof merged === "string" && merged.trim().length > 0) declarations.push(merged);
  }
  return declarations;
}

/** Every pass of a task that stamped a change fingerprint, oldest
 * first, with how many passes the task has had in all. */
export interface PassFingerprints {
  passes: PassFingerprint[];
  /** The pass currently running is included: a caller comparing against
   * "every EARLIER pass" filters on `pass < count`. */
  count: number;
}

/**
 * The change fingerprint each of a task's passes ended up carrying
 * (`src/foreman/fingerprint.ts`), read back off the record.
 *
 * A pass opens at its own `"work-started"` event - one per round,
 * whether that round is the task's first, a resume after `fabrica
 * answer`, or a fix - and its stamp is the last one its attempts
 * recorded, taken from the `"receipt-recorded"` events inside it. Read
 * from receipts rather than from deliveries on purpose: a pass
 * Inspector refused delivers nothing at all, and its change is still on
 * the branch for the next pass to be compared against. A pass whose
 * attempts were all unstamped simply does not appear.
 */
export function passFingerprintsOf(events: FabricaEvent[]): PassFingerprints {
  const passes: PassFingerprint[] = [];
  let count = 0;
  let current: string | null = null;
  const closePass = (): void => {
    if (count > 0 && current !== null) passes.push({ pass: count, patchId: current });
  };
  for (const event of events) {
    if (event.name === "work-started") {
      closePass();
      count += 1;
      current = null;
      continue;
    }
    if (event.name !== "receipt-recorded") continue;
    const receipt = (event.details as { receipt?: Receipt } | undefined)?.receipt;
    const patchId = receipt?.fingerprint?.patchId;
    if (typeof patchId === "string" && patchId.length > 0) current = patchId;
  }
  closePass();
  return { passes, count };
}

/** Just the passes BEFORE the one currently running - what a round
 * compares its own stamp against. */
export function priorPassFingerprints(events: FabricaEvent[]): PassFingerprint[] {
  const { passes, count } = passFingerprintsOf(events);
  return passes.filter((entry) => entry.pass < count);
}

/** The change fingerprint a task's current delivery carries, and how it
 * compared with the pass before it - what `fabrica status` marks a
 * delivered line with. Null when the task has no delivery on the record
 * (the same "latest delivered event wins" rule `deliveredBranchOf`
 * applies, minus the refusal clearing: a refusal says nothing about
 * what the branch holds). Undefined fields mean the delivery predates
 * fingerprints, which reads as unstamped. */
export function deliveredFingerprintOf(events: FabricaEvent[]): DeliveryStamp | null {
  const delivered = events.filter((event) => event.name === "delivered").at(-1);
  if (delivered === undefined) return null;
  const delivery = (delivered.details as DeliveredDetails | undefined)?.delivery;
  if (delivery === undefined) return null;
  return {
    fingerprint: delivery.fingerprint ?? { patchId: null, base: null, baseBranch: null, reason: UNSTAMPED_OLD_RECORD },
    ...(delivery.fingerprintMatch === undefined ? {} : { fingerprintMatch: delivery.fingerprintMatch }),
  };
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

/** The branch the task's current delivery names (`Delivery.branch`), or
 * null when there is no delivery on the record. Takes the events the
 * caller already holds, for the same reason `src/cli/render.ts`'s
 * `projectFromEvents` does: `fabrica status` must not re-read
 * events.jsonl once per open task just to name a branch.
 *
 * Latest "delivered" event wins (a fix round appends its own), and an
 * Inspector refusal landing after it clears the answer - the same rule
 * `deliveryOf` applies, since a superseded delivery is not the branch
 * anyone is ruling on any more. */
export function deliveredBranchOf(events: FabricaEvent[]): string | null {
  let branch: string | null = null;
  for (const event of events) {
    if (event.name === "delivered") {
      const delivered = event.details as DeliveredDetails | undefined;
      const named = delivered?.delivery?.branch;
      branch = typeof named === "string" && named.trim().length > 0 ? named : null;
    } else if (
      event.name === "inspection-finished" &&
      (event.details as { verdict?: string } | undefined)?.verdict === "refused"
    ) {
      branch = null;
    }
  }
  return branch;
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

/** The only events that take a task back out of a failure the record
 * already carries (`stateOf`'s `failed` flag, below) - everything else
 * is ignored until one of these lands.
 *
 * The first two are the Client's own two ways of restarting a task, and
 * both are safe to trust for this because of issue #123's split: a
 * resume and a fix round each record their decision in the FOREGROUND
 * (`recordAnswerDecision` / `recordVerdictDecision`) before the round
 * itself is handed to a detached process, so one of these always lands
 * on the record ahead of that round's own `work-started`. A genuine
 * restart therefore always gets through, while a straggler from a round
 * that already died never does.
 *
 * "delivered" is here for a different reason: a round that delivers has
 * not thrown, so a "delivered" event can never be a dying round's
 * trailing append - and two rounds can hold one task id at once (the
 * live view's /review page and `fabrica verdict` call the same
 * record-then-spawn pair, so a double submit is enough). If one of them
 * fails while the other goes on to deliver, that delivery is still the
 * Client's to rule on and must not be swallowed. */
const CLEARS_FAILURE: ReadonlySet<FabricaEventName> = new Set<FabricaEventName>([
  "verdict-recorded",
  "answers-given",
  "delivered",
]);

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
 * Two states are absorbing rather than overwritable: "stopped" (issue
 * #203, the Client's own stop) and a recorded failure (see
 * `CLEARS_FAILURE` below). See the loop's first lines for both. */
export function stateOf(events: FabricaEvent[]): FabricaTask["state"] {
  let state: FabricaTask["state"] = "working";
  let begun = false;
  let stoppedByOwner = false;
  let failed = false;

  for (const event of events) {
    // Issue #203: once the Client has stopped the task, that is the
    // fact. The detached process is being signaled, not asked, so
    // whatever it still manages to append on its way down (a last
    // heartbeat, a check-run, even a delivery from work already
    // finished) is kept on the record but must never move the task back
    // to looking alive. His own verdict is the one thing that still
    // can - "accept"/"wrong" close it, exactly as for any other task.
    if (stoppedByOwner && event.name !== "verdict-recorded") continue;

    // A failure the record already carries is the fact, until something
    // deliberately takes the task back out of it. A round appends
    // "task-failed" from the top of its own stack (task-failure.ts's
    // `recordingFailure`), with both heartbeat intervals already
    // cleared, so nothing it does itself can land afterwards: whatever
    // does land came from a second process holding the same task id, or
    // from a round on its way down, and neither is evidence of a live
    // worker. Without this, any of them - a straggling heartbeat is
    // harmless, but a late "check-run", "inspector-called" or
    // "work-started" is not - put the task back to reading "working" in
    // `fabrica status` and the live view while nothing was running.
    // Same reasoning as "stopped" above, which issue #203 settled first.
    if (failed) {
      if (!CLEARS_FAILURE.has(event.name)) continue;
      failed = false;
    }

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
        if (!begun) {
          state = "failed";
          failed = true;
        }
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
        failed = true;
        break;
      case "ask-failed":
        // brain.ask() itself threw (issue #8 follow-up, Client ruling) -
        // the task never got past its own first step, so it's failed,
        // not still "working" or silently invisible.
        state = "failed";
        failed = true;
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
