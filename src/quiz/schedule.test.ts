// The repetition scheme, as the Client stated it: "wrong means eligible
// again next session; each consecutive right doubles the wait (1 day, 2,
// 4, 8 ... capped at 30 days)". Pinned here as arithmetic, because every
// other test about the quiz leans on it.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  describeInterval,
  intervalForStreak,
  standingOfMarks,
  QUIZ_MAX_INTERVAL_MS,
  QUIZ_SESSION_GAP_MS,
} from "./schedule.ts";

const DAY = 24 * 60 * 60 * 1000;
const BORN = Date.UTC(2026, 0, 1);

test("intervalForStreak: one day, then doubling, then the thirty-day ceiling", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 20].map(intervalForStreak),
    [1 * DAY, 2 * DAY, 4 * DAY, 8 * DAY, 16 * DAY, 30 * DAY, 30 * DAY, 30 * DAY]
  );
  assert.equal(QUIZ_MAX_INTERVAL_MS, 30 * DAY);
});

test("intervalForStreak: no streak at all is the session gap, not a day", () => {
  // The wrong-answer case. It is deliberately the one interval that is
  // not a doubling of anything.
  assert.equal(intervalForStreak(0), QUIZ_SESSION_GAP_MS);
  assert.equal(intervalForStreak(-1), QUIZ_SESSION_GAP_MS);
});

test("standingOfMarks: a question never answered is due the moment it exists", () => {
  const standing = standingOfMarks([], BORN);
  assert.deepEqual(standing, {
    streak: 0,
    rightCount: 0,
    wrongCount: 0,
    lastAnsweredAtMs: null,
    dueAtMs: BORN,
  });
  assert.equal(describeInterval(standing), "never asked");
});

test("standingOfMarks: each consecutive right pushes the next showing out further", () => {
  const first = standingOfMarks([{ right: true, atMs: BORN }], BORN);
  assert.equal(first.streak, 1);
  assert.equal(first.dueAtMs, BORN + DAY);

  const third = standingOfMarks(
    [
      { right: true, atMs: BORN },
      { right: true, atMs: BORN + DAY },
      { right: true, atMs: BORN + 3 * DAY },
    ],
    BORN
  );
  assert.equal(third.streak, 3);
  assert.equal(third.rightCount, 3);
  assert.equal(third.dueAtMs, BORN + 3 * DAY + 4 * DAY);
  assert.equal(describeInterval(third), "3 right in a row - back in 4 days");
});

test("standingOfMarks: one wrong answer resets the streak and brings it back next session", () => {
  const standing = standingOfMarks(
    [
      { right: true, atMs: BORN },
      { right: true, atMs: BORN + DAY },
      { right: false, atMs: BORN + 3 * DAY },
    ],
    BORN
  );
  assert.equal(standing.streak, 0);
  assert.equal(standing.rightCount, 2);
  assert.equal(standing.wrongCount, 1);
  assert.equal(standing.dueAtMs, BORN + 3 * DAY + QUIZ_SESSION_GAP_MS);
  assert.equal(describeInterval(standing), "missed - back next session");
});

test("standingOfMarks: a right answer after a miss starts the doubling over at one day", () => {
  const standing = standingOfMarks(
    [
      { right: true, atMs: BORN },
      { right: true, atMs: BORN + DAY },
      { right: true, atMs: BORN + 3 * DAY },
      { right: false, atMs: BORN + 7 * DAY },
      { right: true, atMs: BORN + 8 * DAY },
    ],
    BORN
  );
  assert.equal(standing.streak, 1, "the streak counts back from the latest mark, not over the whole history");
  assert.equal(standing.dueAtMs, BORN + 8 * DAY + DAY);
});

test("describeInterval: the cap is worded as the cap, not as a doubling nobody reaches", () => {
  const standing = standingOfMarks(
    Array.from({ length: 8 }, (_, n) => ({ right: true, atMs: BORN + n * DAY })),
    BORN
  );
  assert.equal(standing.streak, 8);
  assert.equal(describeInterval(standing), "8 right in a row - back in 30 days");
});
