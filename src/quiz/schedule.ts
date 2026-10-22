// When a quiz question comes back - the whole repetition scheme, pure
// and with no record access, so it can be read and tested as the one
// rule it is (Client ruling: "wrong means eligible again next session;
// each consecutive right doubles the wait, 1 day, 2, 4, 8 ... capped at
// 30 days").
//
// Deliberately derived from the marks themselves on every read rather
// than stored as a "next due" number anywhere: the marks are on the
// append-only record, so a schedule computed from them cannot drift out
// of step with what actually happened, and changing the scheme later
// re-schedules the whole history correctly instead of only what is
// answered from then on.

const DAY_MS = 24 * 60 * 60 * 1000;

/** The first interval a correct answer earns, and the base the doubling
 * runs from. */
export const QUIZ_FIRST_INTERVAL_MS = DAY_MS;

/** The ceiling the doubling stops at - a question answered right six
 * times running is asked monthly and no less often than that. */
export const QUIZ_MAX_INTERVAL_MS = 30 * DAY_MS;

/**
 * What "eligible again next session" is measured as. A review session is
 * a run of marks with no gap this long in it, so a question answered
 * wrong comes back once the run it was missed in has lapsed - rather
 * than immediately, which would ask it again two taps later, or at some
 * fixed hour, which would need a clock the record does not keep.
 */
export const QUIZ_SESSION_GAP_MS = 30 * 60 * 1000;

/** One recorded mark, in the order the record holds them. */
export interface QuizMark {
  right: boolean;
  atMs: number;
}

/** Where a question stands: how many right answers in a row it has, when
 * it is next due, and the counts behind both. */
export interface QuizStanding {
  /** Consecutive right answers, counting back from the latest mark. Zero
   * for a question whose last answer was wrong and for one never asked. */
  streak: number;
  rightCount: number;
  wrongCount: number;
  lastAnsweredAtMs: number | null;
  /** When it may be asked again. For a question never answered this is
   * `bornAtMs` - due from the moment it existed. */
  dueAtMs: number;
}

/** The wait a given streak earns: 1 day, then doubling, capped. A streak
 * of zero earns the session gap instead - that is the wrong-answer case,
 * and it is the one interval that is not a doubling of anything. */
export function intervalForStreak(streak: number): number {
  if (streak <= 0) return QUIZ_SESSION_GAP_MS;
  return Math.min(QUIZ_FIRST_INTERVAL_MS * 2 ** (streak - 1), QUIZ_MAX_INTERVAL_MS);
}

/**
 * Folds a question's marks into where it stands. `bornAtMs` is when the
 * question itself became askable - its task's acceptance, or the moment
 * a re-check rewrote it - and is what an unanswered question is due at,
 * so a brand new question is due immediately rather than at some epoch.
 *
 * Marks must already be filtered to the ones that are about these exact
 * words (see `questions.ts`: a rewrite resets the schedule, because the
 * answers before it were about a different question).
 */
export function standingOfMarks(marks: QuizMark[], bornAtMs: number): QuizStanding {
  let streak = 0;
  let rightCount = 0;
  let wrongCount = 0;
  let lastAnsweredAtMs: number | null = null;
  for (const mark of marks) {
    if (mark.right) {
      streak += 1;
      rightCount += 1;
    } else {
      streak = 0;
      wrongCount += 1;
    }
    lastAnsweredAtMs = mark.atMs;
  }
  return {
    streak,
    rightCount,
    wrongCount,
    lastAnsweredAtMs,
    dueAtMs: lastAnsweredAtMs === null ? bornAtMs : lastAnsweredAtMs + intervalForStreak(streak),
  };
}

/** The scheme in one sentence, for the page to show next to the card -
 * so the Client can see why a question went away for as long as it did
 * without reading this file. */
export function describeInterval(standing: QuizStanding): string {
  if (standing.lastAnsweredAtMs === null) return "never asked";
  if (standing.streak === 0) return "missed - back next session";
  const days = Math.round(intervalForStreak(standing.streak) / DAY_MS);
  return `${standing.streak} right in a row - back in ${days} day${days === 1 ? "" : "s"}`;
}
