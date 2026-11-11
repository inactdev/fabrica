// Which run of a check answers for it (issue #348). The case this file
// exists for is a workflow that cancels its own older runs: one commit,
// one check name, several runs, only one of them an answer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { latestRunPerCheck, ONLY_CANCELLED } from "./latest.ts";
import type { CheckRunRead } from "./latest.ts";

function run(over: Partial<CheckRunRead> & { name: string }): CheckRunRead {
  return {
    status: "completed",
    conclusion: "success",
    url: `https://github.com/o/r/runs/${over.id ?? 1}`,
    ...over,
  };
}

test("the issue's own case: two cancelled runs and a later pass read as one green check", () => {
  const { concluded, unresolved } = latestRunPerCheck([
    run({ name: "tests", id: 1, conclusion: "cancelled", startedAt: "2026-11-01T10:00:00Z" }),
    run({ name: "tests", id: 2, conclusion: "cancelled", startedAt: "2026-11-01T10:05:00Z" }),
    run({ name: "tests", id: 3, conclusion: "success", startedAt: "2026-11-01T10:10:00Z" }),
  ]);
  assert.deepEqual(unresolved, []);
  assert.equal(concluded.length, 1);
  assert.equal(concluded[0].conclusion, "success");
  assert.equal(concluded[0].red, false);
  assert.equal(concluded[0].checkRunId, 3);
});

test("a cancelled run is no result even when it is the newest one", () => {
  const { concluded } = latestRunPerCheck([
    run({ name: "tests", id: 1, conclusion: "success", startedAt: "2026-11-01T10:00:00Z" }),
    run({ name: "tests", id: 2, conclusion: "cancelled", startedAt: "2026-11-01T10:05:00Z" }),
  ]);
  assert.equal(concluded.length, 1);
  assert.equal(concluded[0].conclusion, "success");
});

test("a check whose every run was cancelled has no answer yet, and is never red", () => {
  const { concluded, unresolved } = latestRunPerCheck([
    run({ name: "tests", id: 1, conclusion: "cancelled", startedAt: "2026-11-01T10:00:00Z" }),
    run({ name: "tests", id: 2, conclusion: "cancelled", startedAt: "2026-11-01T10:05:00Z" }),
  ]);
  assert.deepEqual(concluded, []);
  assert.deepEqual(unresolved, [
    {
      name: "tests",
      source: "check-run",
      status: ONLY_CANCELLED,
      // The newest of the cancelled runs - where a human sees it.
      url: "https://github.com/o/r/runs/2",
    },
  ]);
});

test("a newer run that has not finished keeps the whole check waiting", () => {
  const { concluded, unresolved } = latestRunPerCheck([
    run({ name: "tests", id: 1, conclusion: "failure", startedAt: "2026-11-01T10:00:00Z" }),
    run({ name: "tests", id: 2, status: "in_progress", conclusion: null, startedAt: "2026-11-01T10:05:00Z" }),
  ]);
  assert.deepEqual(concluded, []);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].status, "in_progress");
});

test("the newest answer wins, so a failure a later run replaced is not reported", () => {
  const { concluded } = latestRunPerCheck([
    run({ name: "tests", id: 9, conclusion: "failure", startedAt: "2026-11-01T10:00:00Z" }),
    run({ name: "tests", id: 4, conclusion: "success", startedAt: "2026-11-01T10:30:00Z" }),
  ]);
  assert.equal(concluded.length, 1);
  assert.equal(concluded[0].red, false);
});

test("the newest failure is still a failure - nothing here invents a pass", () => {
  const { concluded } = latestRunPerCheck([
    run({ name: "tests", id: 1, conclusion: "success", startedAt: "2026-11-01T10:00:00Z" }),
    run({ name: "tests", id: 2, conclusion: "failure", startedAt: "2026-11-01T10:30:00Z" }),
  ]);
  assert.equal(concluded.length, 1);
  assert.equal(concluded[0].red, true);
  assert.equal(concluded[0].conclusion, "failure");
});

test("same started_at: the larger id breaks the tie", () => {
  const { concluded } = latestRunPerCheck([
    run({ name: "tests", id: 7, conclusion: "failure", startedAt: "2026-11-01T10:00:00Z" }),
    run({ name: "tests", id: 8, conclusion: "success", startedAt: "2026-11-01T10:00:00Z" }),
  ]);
  assert.equal(concluded[0].checkRunId, 8);
  assert.equal(concluded[0].red, false);
});

test("nothing to order two runs by: the red one is read, whichever way GitHub listed them", () => {
  for (const order of [0, 1]) {
    const runs = [run({ name: "tests", conclusion: "success" }), run({ name: "tests", conclusion: "failure" })];
    const { concluded } = latestRunPerCheck(order === 0 ? runs : [...runs].reverse());
    assert.equal(concluded[0].red, true, `order ${order}`);
  }
});

test("a run with no started_at never outranks one that has it", () => {
  const { concluded } = latestRunPerCheck([
    run({ name: "tests", id: 2, conclusion: "failure" }),
    run({ name: "tests", id: 1, conclusion: "success", startedAt: "2026-11-01T10:00:00Z" }),
  ]);
  assert.equal(concluded[0].conclusion, "success");
});

test("an unparseable started_at is read as no timestamp at all, not as the newest", () => {
  const { concluded } = latestRunPerCheck([
    run({ name: "tests", id: 2, conclusion: "failure", startedAt: "whenever" }),
    run({ name: "tests", id: 1, conclusion: "success", startedAt: "2026-11-01T10:00:00Z" }),
  ]);
  assert.equal(concluded[0].conclusion, "success");
});

test("a run GitHub gave neither a timestamp nor an id never outranks one it did", () => {
  // Both directions of the same rule: ordering follows the evidence, and
  // a run with no ordering fields at all is read as the oldest whatever
  // colour it is - never promoted to "newest" by the absence itself.
  const redHasThem = latestRunPerCheck([
    run({ name: "tests", id: 5, conclusion: "failure", startedAt: "2026-11-01T10:00:00Z" }),
    { name: "tests", status: "completed", conclusion: "success", url: null },
  ]);
  assert.equal(redHasThem.concluded.length, 1);
  assert.equal(redHasThem.concluded[0].red, true, "a real failure must not be replaced by an unplaceable pass");

  const greenHasThem = latestRunPerCheck([
    run({ name: "tests", id: 2, conclusion: "success", startedAt: "2026-11-01T10:00:00Z" }),
    { name: "tests", status: "completed", conclusion: "failure", url: null },
  ]);
  assert.equal(greenHasThem.concluded[0].checkRunId, 2);
});

test("with no timestamps anywhere, the larger id is the one read", () => {
  const { concluded } = latestRunPerCheck([
    run({ name: "tests", id: 3, conclusion: "failure" }),
    run({ name: "tests", id: 4, conclusion: "success" }),
  ]);
  assert.equal(concluded.length, 1);
  assert.equal(concluded[0].checkRunId, 4);
});

test("cancelled-only with nothing to order the runs by still answers once, and with a link", () => {
  const { concluded, unresolved } = latestRunPerCheck([
    run({ name: "tests", conclusion: "cancelled", url: "https://github.com/o/r/runs/a" }),
    run({ name: "tests", conclusion: "cancelled", url: "https://github.com/o/r/runs/b" }),
  ]);
  assert.deepEqual(concluded, []);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].status, ONLY_CANCELLED);
  // Deliberate and deterministic: with nothing at all to separate two
  // runs, the one GitHub listed first stands, so two reads of the same
  // commit never disagree about which link to show.
  assert.equal(unresolved[0].url, "https://github.com/o/r/runs/a");
});

test("a repository whose workflows cancel nothing reads exactly as it did before", () => {
  // One run per check, which is every repository without
  // `cancel-in-progress`: each check's own answer, unchanged, and the
  // one still running still the only thing waited for.
  const { concluded, unresolved } = latestRunPerCheck([
    run({ name: "gate", id: 1, conclusion: "success", startedAt: "2026-11-01T10:00:00Z" }),
    run({ name: "docker-tests", id: 2, conclusion: "failure", startedAt: "2026-11-01T10:00:05Z" }),
    run({ name: "stamp", id: 3, status: "in_progress", conclusion: null, startedAt: "2026-11-01T10:00:06Z" }),
    run({ name: "rehearsal", id: 4, conclusion: "skipped", startedAt: "2026-11-01T10:00:07Z" }),
  ]);
  assert.deepEqual(
    concluded.map((check) => `${check.name}:${check.conclusion}:${check.red}`),
    ["gate:success:false", "docker-tests:failure:true", "rehearsal:skipped:false"]
  );
  assert.deepEqual(
    unresolved.map((check) => `${check.name}:${check.status}`),
    ["stamp:in_progress"]
  );
});

test("different names are different checks, in the order GitHub listed them", () => {
  const { concluded, unresolved } = latestRunPerCheck([
    run({ name: "lint", id: 1, conclusion: "success" }),
    run({ name: "tests", id: 2, conclusion: "cancelled" }),
    run({ name: "rehearsal", id: 3, conclusion: "failure" }),
  ]);
  assert.deepEqual(
    concluded.map((check) => check.name),
    ["lint", "rehearsal"]
  );
  assert.deepEqual(
    unresolved.map((check) => check.name),
    ["tests"]
  );
});

test("a completed run with no conclusion is unfinished, not an empty answer", () => {
  const { concluded, unresolved } = latestRunPerCheck([run({ name: "tests", conclusion: null })]);
  assert.deepEqual(concluded, []);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].status, "completed");
});

test("GitHub's word is matched case-insensitively, so CANCELLED is no result either", () => {
  const { concluded, unresolved } = latestRunPerCheck([run({ name: "tests", conclusion: " CANCELLED " })]);
  assert.deepEqual(concluded, []);
  assert.equal(unresolved[0].status, ONLY_CANCELLED);
});

test("one run of one check is that check's answer, id and url carried through", () => {
  const { concluded } = latestRunPerCheck([
    run({ name: "docker-tests", id: 42, conclusion: "skipped", url: "https://github.com/o/r/runs/42" }),
  ]);
  assert.deepEqual(concluded, [
    {
      name: "docker-tests",
      source: "check-run",
      conclusion: "skipped",
      red: false,
      url: "https://github.com/o/r/runs/42",
      checkRunId: 42,
    },
  ]);
});

test("no runs at all is no answers at all", () => {
  assert.deepEqual(latestRunPerCheck([]), { concluded: [], unresolved: [] });
});
