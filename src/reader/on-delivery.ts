// What the delivery says about the read, which is also what the record
// carries: inspector issue #34 asks for "the findings and the model
// used" on both, and its amendment adds the worker's own declines
// "recorded in the delivery beside the finding" - hence one shape with
// the decline folded into the finding it answers, rather than two lists
// a reader of the delivery would have to join by number themselves.

import type { ReaderDecline, ReaderOnDelivery, ReaderOutcome } from "./types.ts";

/**
 * One read, as the delivery and the record report it.
 *
 * `note` carries anything about the *worker's* answer that could not be
 * read (a declines file that would not parse, a decline naming no
 * finding) - kept, rather than dropped, because the alternative is a
 * delivery that reads as "the worker acted on everything" when nobody
 * knows that.
 */
export function readerOnDelivery(outcome: ReaderOutcome): ReaderOnDelivery {
  if (outcome.kind === "failed") {
    return { model: outcome.failure.model, state: "failed", findings: [], error: outcome.failure.error };
  }
  if (outcome.kind === "clean") {
    return { model: outcome.report.model, state: "clean", findings: [] };
  }
  return {
    model: outcome.report.model,
    state: "flagged",
    findings: outcome.report.findings.map((finding, index) => {
      const declined = declineFor(outcome.declines, index + 1);
      return { ...finding, ...(declined === undefined ? {} : { declined }) };
    }),
    ...(outcome.declineProblem === undefined ? {} : { note: outcome.declineProblem }),
  };
}

/** The reason given for declining finding `number`, if one was. The
 * numbering is the brief's own, 1-based, end to end. */
function declineFor(declines: ReaderDecline[], number: number): string | undefined {
  return declines.find((decline) => decline.finding === number)?.reason;
}

/** The one-phrase summary every task line and status row shows. Worded
 * once, here, so `fabrica status`, `fabrica log`, `fabrica watch`, the
 * live view and the delivery can never describe the same read
 * differently. */
export function describeRead(read: ReaderOnDelivery): string {
  if (read.state === "failed") return `code reader failed (${read.model}): ${read.error}`;
  if (read.state === "clean") return `code reader found nothing to flag (${read.model})`;
  const declined = read.findings.filter((finding) => finding.declined !== undefined).length;
  const flagged = `code reader flagged ${read.findings.length} ${read.findings.length === 1 ? "thing" : "things"}`;
  return declined === 0
    ? `${flagged} (${read.model})`
    : `${flagged}, ${declined} declined by the worker (${read.model})`;
}
