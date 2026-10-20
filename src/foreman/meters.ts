// Issue #189's pause rule: the subscription meters, and what Fabrica
// does about them.
//
// Rule 10's caps are about money. These are about a flat-rate
// subscription's own windows, which cost nothing to fill - so no dollar
// cap can ever notice them, and a task can run the Client's whole week
// down without a single cent of metered spend appearing anywhere. Hence
// a second, separate rule, deliberately not folded into caps.ts:
//
//   - above `sevenDayRefusePercent` (default 70), nothing new starts;
//   - above `sevenDayStopPercent` (default 90), an attempt already
//     running is stopped gracefully and the round is delivered as
//     "paused-by-meter";
//   - above `fiveHourRefusePercent` (default 90), nothing new starts
//     either, but work in flight is never stopped for it - that window
//     refills within hours (Client's clarification).
//
// Two rules the whole module follows, both the Client's own
// clarification:
//
//   - FAIL OPEN. A reading that is missing, unreadable or stale is
//     "unknown", which warns and refuses nothing. Never refuse work on
//     a number nobody could read.
//   - A pause is never a failure. A stopped attempt gets its own
//     outcome, and the task waits on the Client's `fix` verdict exactly
//     as a cap-stopped one does. Nothing here resumes anything by
//     itself.
//
// Where the numbers come from is deliberately not this module's
// business: they arrive as percentages through src/brain/meters.ts,
// which the brain's own adapter fills in. See
// notes/20261020-do-fabrica-issue-189-as-written-closing-i3.md for
// where they actually live and why nothing reads them off a worker
// CLI's own output.

import { appendEvent, readEvents, readEventsForTask } from "../record/index.ts";
import { DEFAULT_PAUSE_RULE, loadConfig } from "../config/index.ts";
import type { PauseRule } from "../config/index.ts";
import { ConfigError } from "../config/index.ts";
import type { MeterReading } from "../brain/index.ts";
import type { FabricaEvent } from "../record/index.ts";
import type { Receipt } from "../inspector/types.ts";
import { ForemanError } from "./errors.ts";
import { markRecorded } from "./task-failure.ts";

/** How old a reading may be and still be evidence about now. A reading
 * from last night says nothing useful about either window: the 5-hour
 * one has reset outright, and the 7-day one has had a whole night of
 * somebody else's work to move under it. Past this, the reading is
 * treated as unknown and the pause rule refuses nothing - the first
 * attempt that then runs produces a fresh reading, so the very next
 * decision has a real number to use (see this module's header on
 * failing open).
 *
 * Deliberately far shorter than either window it talks about: this is
 * "how long ago did we last look", not "how long until the quota
 * resets". */
export const METER_READING_MAX_AGE_MS = 60 * 60 * 1000;

/** The pause rule in force, from projects.toml's `[pause]` table.
 * A record home with no projects.toml yet still has a pause rule - the
 * defaults - because this guards the Client's subscription rather than
 * a figure he configured (the same reason `src/cli/load-config.ts`
 * defaults it). Read where it is needed, like `resolveCheckCommand`
 * does, rather than threaded through every caller: unlike `caps`, there
 * is no "unset" for it to mean. */
export function pauseRuleFor(recordHome: string): PauseRule {
  try {
    return loadConfig(recordHome).pause;
  } catch (err) {
    if (err instanceof ConfigError && err.code === "not-found") return { ...DEFAULT_PAUSE_RULE };
    throw err;
  }
}

/** Everything a `"meter-refused"` event's `details` carries. */
export interface MeterRefusedDetails {
  /** Which meter was over, and so which threshold refused this start. */
  meter: "seven-day" | "five-hour";
  usedPercent: number;
  thresholdPercent: number;
  message: string;
  /** When the reading that refused this was taken. */
  observedAt: string;
  /** The project the refused task was for, so `fabrica status` can name
   * it - same as `CapRefusedDetails`. */
  project?: string;
}

/** Everything a `"meter-paused"` event's `details` carries. */
export interface MeterPausedDetails {
  attempt: number;
  usedPercent: number;
  thresholdPercent: number;
  observedAt: string;
  message: string;
  /** False when the worker could not actually be asked to stop (the
   * adapter's own `pause()` threw) - the record then says the pause was
   * decided but not carried out, which is a different fact from a clean
   * stop. A decision is only ever reached where a reading arrived, and
   * a reading only ever comes from a registered source, so there is no
   * "nothing to ask" case behind this. */
  workerStopped: boolean;
}

/** A reading plus how it should be read: `usable` is false for a
 * reading that is missing, has neither meter, or is too old to be
 * evidence about now. */
export interface MeterStanding {
  reading: MeterReading | null;
  usable: boolean;
  /** Why it is not usable, worded for a person - undefined when it is. */
  unknownBecause?: string;
}

/** How a reading stands as of `now`. */
export function standingOf(reading: MeterReading | null | undefined, now: number): MeterStanding {
  if (reading === undefined || reading === null) {
    return { reading: null, usable: false, unknownBecause: "no subscription-meter reading has been recorded yet" };
  }
  if (reading.fiveHourPercent === null && reading.sevenDayPercent === null) {
    return { reading, usable: false, unknownBecause: "the last reading carried neither meter" };
  }
  const takenAt = Date.parse(reading.observedAt);
  if (!Number.isFinite(takenAt)) {
    return { reading, usable: false, unknownBecause: "the last reading has no readable time on it" };
  }
  const ageMs = now - takenAt;
  if (ageMs > METER_READING_MAX_AGE_MS) {
    return {
      reading,
      usable: false,
      unknownBecause: `the last reading is ${Math.round(ageMs / 60_000)} minutes old, too stale to judge by`,
    };
  }
  return { reading, usable: true };
}

/** The attempt's own meter reading out of its transcript - the same
 * route `spend.ts`'s `costFromTranscript` takes for cost, and for the
 * same reason: `Brain.work()`'s ratified return shape has no field for
 * either, so an adapter reports one as a reserved transcript entry
 * (`kind: "meters"`, whose `text` is a JSON `MeterReading`) and
 * whatever assembles the Receipt reads it back out. The last such entry
 * wins; anything unparseable, or shaped like something else, is no
 * reading at all rather than a half-read one. */
export function meterReadingFromTranscript(transcript: { kind: string; text: string }[]): MeterReading | null {
  let reading: MeterReading | null = null;
  for (const entry of transcript) {
    if (entry.kind !== "meters") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(entry.text);
    } catch {
      continue;
    }
    const candidate = parsed as Partial<MeterReading> | null;
    if (candidate === null || typeof candidate !== "object") continue;
    if (typeof candidate.observedAt !== "string") continue;
    reading = {
      observedAt: candidate.observedAt,
      fiveHourPercent: percentOrNull(candidate.fiveHourPercent),
      sevenDayPercent: percentOrNull(candidate.sevenDayPercent),
    };
  }
  return reading;
}

function percentOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** The most recent meter reading anywhere on the record. Read from
 * receipts - every attempt records one (issue #189), so the record
 * already carries the full history and there is nothing separate to
 * keep in step. Across every task, not just one: the windows belong to
 * the Client's account, not to a task.
 *
 * "Most recent" by the reading's own `observedAt`, never by where it
 * sits in the log: a receipt is appended when its attempt ends, so two
 * tasks running at once append out of order with respect to when their
 * readings were actually taken. */
export function latestMeterReading(events: FabricaEvent[]): MeterReading | null {
  let latest: MeterReading | null = null;
  let latestAt = -Infinity;
  for (const event of events) {
    const details = event.details as { receipt?: Receipt; receipts?: Receipt[] } | undefined;
    const receipts = [
      ...(details?.receipt ? [details.receipt] : []),
      ...(Array.isArray(details?.receipts) ? details.receipts : []),
    ];
    for (const receipt of receipts) {
      const reading = receipt?.meters;
      if (reading === null || reading === undefined) continue;
      const at = Date.parse(reading.observedAt);
      if (!Number.isFinite(at) || at <= latestAt) continue;
      latestAt = at;
      latest = reading;
    }
  }
  return latest;
}

/** Issue #189's two refuse thresholds, against one reading. Returns the
 * refusal that applies - the 7-day meter first, since that is the
 * window that does not refill on its own - or undefined when neither
 * does, which includes every unusable reading (fail open). */
export function refusalFor(standing: MeterStanding, rule: PauseRule): Omit<MeterRefusedDetails, "project"> | undefined {
  if (!standing.usable || standing.reading === null) return undefined;
  const { fiveHourPercent, sevenDayPercent, observedAt } = standing.reading;
  if (sevenDayPercent !== null && sevenDayPercent > rule.sevenDayRefusePercent) {
    return {
      meter: "seven-day",
      usedPercent: sevenDayPercent,
      thresholdPercent: rule.sevenDayRefusePercent,
      observedAt,
      message:
        `Paused by the subscription meter: ${formatPercent(sevenDayPercent)} of the 7-day window is used, and ` +
        `new work stops above ${formatPercent(rule.sevenDayRefusePercent)}. Nothing was started. The window ` +
        `refills as it rolls forward; raising [pause].sevenDayRefusePercent in projects.toml is the other way.`,
    };
  }
  if (fiveHourPercent !== null && fiveHourPercent > rule.fiveHourRefusePercent) {
    return {
      meter: "five-hour",
      usedPercent: fiveHourPercent,
      thresholdPercent: rule.fiveHourRefusePercent,
      observedAt,
      message:
        `Paused by the subscription meter: ${formatPercent(fiveHourPercent)} of the 5-hour window is used, and ` +
        `new work stops above ${formatPercent(rule.fiveHourRefusePercent)}. Nothing was started. This window ` +
        `resets within hours, so waiting is usually all it takes.`,
    };
  }
  return undefined;
}

/** Issue #189's one stop threshold, against one reading: the 7-day
 * meter only. The 5-hour meter never stops work in flight however full
 * it is (Client's clarification) - it resets within hours, and
 * throwing away an attempt's work for it would cost more than it
 * saves. Undefined for an unusable reading, same as `refusalFor`. */
export function stopFor(
  standing: MeterStanding,
  rule: PauseRule
): { usedPercent: number; thresholdPercent: number; observedAt: string } | undefined {
  if (!standing.usable || standing.reading === null) return undefined;
  const { sevenDayPercent, observedAt } = standing.reading;
  if (sevenDayPercent === null || sevenDayPercent <= rule.sevenDayStopPercent) return undefined;
  return { usedPercent: sevenDayPercent, thresholdPercent: rule.sevenDayStopPercent, observedAt };
}

/** What a stopped attempt's report says, shared by the `"meter-paused"`
 * event and the delivery built from it, so the two can never word the
 * same stop differently. */
export function pauseMessage(usedPercent: number, thresholdPercent: number): string {
  return (
    `Paused by the subscription meter: ${formatPercent(usedPercent)} of the 7-day window is used, past the ` +
    `${formatPercent(thresholdPercent)} this task stops at, so the attempt was stopped rather than run the ` +
    `week down. Nothing failed.`
  );
}

/**
 * Throws (after recording why) when the pause rule will not let
 * `taskId` start: a new task, a resumed round (`fabrica answer`), or a
 * fix round. The counterpart of `caps.ts`'s `requireRoomToStart`, and
 * called right after it at all three of its call sites.
 *
 * Fails open, loudly: a reading nobody can use refuses nothing, and
 * says so on stderr rather than silently - the Client's clarification
 * was "record the meters as unknown, warn on stderr, and never refuse
 * on a number that could not be read", and a pause rule that quietly
 * does nothing is indistinguishable from one that is working.
 */
export function requireMeterRoomToStart(
  recordHome: string,
  taskId: string,
  opts: { project?: string; now?: number; warn?: (line: string) => void } = {}
): void {
  const now = opts.now ?? Date.now();
  const warn = opts.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
  const rule = pauseRuleFor(recordHome);
  const standing = standingOf(latestMeterReading(readEvents(recordHome)), now);

  if (!standing.usable) {
    warn(
      `fabrica: the subscription meters are unknown (${standing.unknownBecause}), so the pause rule let this ` +
        `start go ahead. Nothing was refused on an unread number.`
    );
    return;
  }

  const refusal = refusalFor(standing, rule);
  if (refusal === undefined) return;

  const details: MeterRefusedDetails = {
    ...refusal,
    ...(opts.project === undefined ? {} : { project: opts.project }),
  };
  appendEvent(recordHome, { taskId, name: "meter-refused", details });
  throw markRecorded(new ForemanError("meter-refused", details.message));
}

/** Records why a running task's attempt was paused, in the words its
 * report uses - the counterpart of `caps.ts`'s `recordCapStop`. */
export function recordMeterPause(recordHome: string, taskId: string, details: MeterPausedDetails): void {
  appendEvent(recordHome, { taskId, name: "meter-paused", details });
}

/** The pause rule's own reading of a task's state, for `fabrica status`
 * and the review page: whether this task's latest round was stopped by
 * a meter, and in what words. */
export function meterPauseOf(recordHome: string, taskId: string): MeterPausedDetails | undefined {
  const events = readEventsForTask(recordHome, taskId);
  const paused = events.map((event) => event.name).lastIndexOf("meter-paused");
  if (paused === -1) return undefined;
  // A later round supersedes it: a `fix` the Client ruled after the
  // pause means the task is moving again, whatever the old event says.
  const resumed = events.findIndex(
    (event, index) => index > paused && (event.name === "verdict-recorded" || event.name === "answers-given")
  );
  if (resumed !== -1) return undefined;
  return events[paused].details as MeterPausedDetails;
}

/** Both meters in one phrase, for a person: "5h 7%, 7d 64%". Never
 * blank, and never a number for a meter nobody reported. */
export function describeMeters(standing: MeterStanding): string {
  if (standing.reading === null) return "not read yet";
  const { fiveHourPercent, sevenDayPercent } = standing.reading;
  const parts = [
    `5h ${fiveHourPercent === null ? "unknown" : formatPercent(fiveHourPercent)}`,
    `7d ${sevenDayPercent === null ? "unknown" : formatPercent(sevenDayPercent)}`,
  ];
  return parts.join(", ");
}

/** Percentages for a person: whole numbers stay whole ("64%"), and
 * anything finer keeps one decimal rather than printing "63.6999%". */
export function formatPercent(percent: number): string {
  return `${Number.isInteger(percent) ? percent : Math.round(percent * 10) / 10}%`;
}
