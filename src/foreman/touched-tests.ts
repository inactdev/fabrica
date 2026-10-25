// Issue #142: "run only the tests you touched" is the Client's standing
// ruling, so it lives in each project's own settings instead of being
// retyped into every task. This is the one place that decides whether a
// given round's worker hears it, and the one place that builds the
// brief a worker actually receives.
//
// Two ways out, both from the Client's own ruling on this issue:
//
//   - a project turns it off for good with `onlyTouchedTests = false`
//     in its projects.toml entry;
//   - a single task turns it off for itself by asking for the full
//     suite in its own words.
//
// A project nobody registered (every contract fixture, and a bare
// `fabrica do --project <path>`) still gets the ruling: it is a
// standing one, not a per-project preference, and the loader applies
// the same default to every registered entry that predates it.
//
// A project that commits a `tests.map` (src/testmap/, read per round by
// test-map.ts) turns that ruling from advice into a lookup, and its
// notice REPLACES the one above rather than joining it - see
// `withStandingQuestion` for why a brief must never carry both.

import { registeredProject } from "./registered-project.ts";
import { withStandingQuestion } from "./standing-question.ts";
import { reportForRound } from "./test-map.ts";
import { testMapBriefNotice } from "../testmap/index.ts";
import type { TestMapEntry } from "../testmap/index.ts";

/**
 * A task asking, in its own text, for the whole suite to be run.
 *
 * Deliberately narrow: four literal spellings of the one phrase the
 * Client's ruling named ("run the full suite"), case-insensitive. A
 * looser match - any sentence mentioning "all the tests", say - would
 * turn ordinary task text into an accidental opt-out, and an opt-out
 * nobody meant to ask for is worse than one spelled a way this misses:
 * a task that misses still gets the full-suite behaviour by simply
 * running the tests it wants to, since the notice is advice to a
 * worker, not a restriction on it.
 */
const FULL_SUITE_REQUEST = /\brun the (full|whole)( test)? suite\b/i;

export function asksForFullSuite(text: string): boolean {
  return FULL_SUITE_REQUEST.test(text);
}

/**
 * Whether this round's worker is told to run only the tests covering
 * what it touched: the project's setting, unless this task's own words
 * ask for the full suite. `briefText` is the task's own text as the
 * worker will receive it (request plus any answers, plus a fix round's
 * note) - the opt-out therefore holds for every round of the task that
 * asked for it, and for no other task.
 */
export function onlyTouchedTestsFor(recordHome: string, projectPath: string, briefText: string): boolean {
  if (asksForFullSuite(briefText)) return false;
  return registeredProject(recordHome, projectPath)?.onlyTouchedTests ?? true;
}

/**
 * The brief a worker is actually handed: the task's own words behind
 * the standing prefix (CONTRACT rule 11), plus one conditional notice -
 * the project's committed test map where it has one, and otherwise the
 * only-touched-tests ruling when this project and this task both leave
 * it on. Why one and not both is `withStandingQuestion`'s own comment.
 *
 * Every round goes through here - a first attempt, a round resumed
 * after `fabrica answer`, and a fix round - so the resolution happens
 * once per round in one place rather than at each brief builder, where
 * the three would be free to drift apart.
 *
 * `testMap` is the project's parsed map (`testMapFor`), read by the
 * caller before its ProductionLine was cut so a malformed one fails the
 * task with nothing yet to tear down. `touched` is what the task has
 * already changed, where that is knowable - a fix round's branch
 * already carries a diff, so its worker is handed the concrete tests
 * and the concrete unmapped files rather than only the lookup rule. A
 * first round has touched nothing yet, and naming a list derived from a
 * diff that does not exist would be the silent guess CONTRACT rule 4
 * forbids.
 */
export function workerBrief(
  recordHome: string,
  projectPath: string,
  briefText: string,
  opts: { testMap?: TestMapEntry[] | null; touched?: string[] } = {}
): string {
  return withStandingQuestion(briefText, {
    onlyTouchedTests: onlyTouchedTestsFor(recordHome, projectPath, briefText),
    ...(opts.testMap === null || opts.testMap === undefined
      ? {}
      : { testMap: testMapBriefNotice(reportForRound(opts.testMap, projectPath, opts.touched ?? [])) }),
  });
}
