// Every condition's raw material, read off the task's own events - the
// amendment's "answers every condition from the record (Inspector result,
// CI conclusions, inspector-tests state, delivery files, questions asked,
// could-not-verify)". The counts come from git (`git.ts`); nothing here
// asks anything of a model, and nothing here is derived from a worker's
// prose.
//
// The record is read directly rather than through `src/foreman/queries.ts`
// on purpose: `src/foreman/round.ts` is what calls this module, and
// importing back into foreman would make the two import each other. What
// is duplicated is one "latest `delivered` event" lookup, which is a
// three-line read, not a second definition of anything.

import type { FabricaEvent } from "../record/index.ts";
import type { ChangeCounts, ChangeFacts } from "./types.ts";

/** The task's facts, scoped to its CURRENT delivery - the last
 * `"delivered"` event - and, for the per-round readings (Inspector's
 * verdict, the pull request's concluded checks), to the round that
 * produced it. A fix round's own red from two rounds ago must never
 * answer a question about the round that just delivered. */
export function factsFromRecord(events: FabricaEvent[], counts: ChangeCounts | null): ChangeFacts {
  const names = events.map((event) => event.name);
  const deliveredIndex = names.lastIndexOf("delivered");
  const delivery =
    deliveredIndex === -1
      ? undefined
      : (events[deliveredIndex].details as { delivery?: { files?: unknown; outcome?: unknown } } | undefined)?.delivery;

  // The same window `queries.ts`'s `redPublishedChecksOf` uses, and for
  // the same reason: a round appends "work-started", then its per-attempt
  // readings, then "delivered", so what lies between the delivery and the
  // "work-started" before it is exactly this round's own.
  const roundStart = deliveredIndex === -1 ? -1 : names.lastIndexOf("work-started", deliveredIndex);
  const roundEvents = deliveredIndex === -1 ? [] : events.slice(roundStart + 1, deliveredIndex + 1);

  return {
    files: Array.isArray(delivery?.files) ? (delivery.files as unknown[]).filter((f): f is string => typeof f === "string") : [],
    outcome: typeof delivery?.outcome === "string" ? delivery.outcome : null,
    counts,
    inspectorVerdict: inspectorVerdictOf(roundEvents),
    concludedChecks: concludedChecksOf(roundEvents),
    // Asked of the WHOLE task, not one round: a task that stopped for
    // questions once asked the Client, and a later round does not undo
    // that.
    questionsAsked: names.includes("questions-asked"),
    couldNotVerify: couldNotVerifyOf(events, deliveredIndex),
  };
}

/** Inspector's own verdict for this round, or null when Inspector was
 * never involved (a self-tested task, which is `"inspection-skipped"`) or
 * reached nothing recordable. Never inferred from the delivery's outcome:
 * a green Inspector followed by a red pull-request check delivers red
 * (issue #267), and the two facts are separate questions. */
function inspectorVerdictOf(roundEvents: FabricaEvent[]): ChangeFacts["inspectorVerdict"] {
  const latest = roundEvents.filter((event) => event.name === "inspection-finished").at(-1);
  const verdict = (latest?.details as { verdict?: unknown } | undefined)?.verdict;
  return verdict === "green" || verdict === "red" || verdict === "refused" ? verdict : null;
}

/** Every check the repository itself concluded on this round's pull
 * request, by name - including the commit status named `inspector-tests`,
 * which is how Inspector's examiner reports on a test change and so needs
 * no separate question of its own. A check that never concluded is
 * absent, so `requiredGreenChecks` answers it "unknown" rather than
 * reading silence as green. */
function concludedChecksOf(roundEvents: FabricaEvent[]): ChangeFacts["concludedChecks"] {
  const byName = new Map<string, boolean>();
  for (const event of roundEvents) {
    if (event.name !== "ci-check-concluded") continue;
    const details = event.details as { name?: unknown; red?: unknown } | undefined;
    if (typeof details?.name !== "string") continue;
    // Latest wins, and a red anywhere stays red: a check re-run green
    // after a red is still the newest word on it, which is what a
    // reader of the pull request would see too.
    byName.set(details.name, details.red === true);
  }
  return [...byName].map(([name, red]) => ({ name, red }));
}

/** What the worker said it could not check from inside its own box - the
 * write-up's own optional field, read off the delivery's event. Empty
 * when it reported nothing, or when the write-up predates the field. */
function couldNotVerifyOf(events: FabricaEvent[], deliveredIndex: number): string {
  if (deliveredIndex === -1) return "";
  const details = events[deliveredIndex].details as { writeup?: { couldNotVerify?: unknown } } | undefined;
  const text = details?.writeup?.couldNotVerify;
  return typeof text === "string" ? text.trim() : "";
}
