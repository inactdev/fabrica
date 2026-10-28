import { test } from "node:test";
import assert from "node:assert/strict";
import { factsFromRecord } from "./facts.ts";
import type { FabricaEvent } from "../record/index.ts";

function event(name: FabricaEvent["name"], details?: unknown): FabricaEvent {
  return { occurredAt: "2026-10-25T12:00:00.000Z", taskId: "task-1", name, ...(details === undefined ? {} : { details }) };
}

const COUNTS = { files: 2, insertions: 3, deletions: 1 };

test("the delivery's own files and outcome are what the file questions are asked of", () => {
  const facts = factsFromRecord(
    [
      event("task-received"),
      event("work-started", { project: "/p" }),
      event("delivered", { outcome: "done", delivery: { outcome: "done", files: ["docs/a.md", "docs/b.md"] } }),
    ],
    COUNTS
  );
  assert.deepEqual(facts.files, ["docs/a.md", "docs/b.md"]);
  assert.equal(facts.outcome, "done");
  assert.deepEqual(facts.counts, COUNTS);
});

test("the LATEST delivery wins, since a fix round appends its own", () => {
  const facts = factsFromRecord(
    [
      event("work-started"),
      event("delivered", { delivery: { outcome: "inspection-red", files: ["a.ts"] } }),
      event("verdict-recorded", { ruling: "fix" }),
      event("work-started"),
      event("delivered", { delivery: { outcome: "done", files: ["docs/a.md"] } }),
    ],
    COUNTS
  );
  assert.equal(facts.outcome, "done");
  assert.deepEqual(facts.files, ["docs/a.md"]);
});

test("Inspector's verdict is read from THIS round only, so an old red never answers a new round", () => {
  const facts = factsFromRecord(
    [
      event("work-started"),
      event("inspection-finished", { verdict: "red" }),
      event("delivered", { delivery: { outcome: "inspection-red", files: ["a.ts"] } }),
      event("verdict-recorded", { ruling: "fix" }),
      event("work-started"),
      event("inspection-finished", { verdict: "green" }),
      event("delivered", { delivery: { outcome: "done", files: ["docs/a.md"] } }),
    ],
    COUNTS
  );
  assert.equal(facts.inspectorVerdict, "green");
});

test("a self-tested round has no Inspector verdict at all, which is not the same as red", () => {
  const facts = factsFromRecord(
    [
      event("work-started"),
      event("inspection-skipped", { reason: "no .inspector.json at the task base commit" }),
      event("check-run", { attempt: 1, green: true }),
      event("delivered", { delivery: { outcome: "done", files: ["docs/a.md"] } }),
    ],
    COUNTS
  );
  assert.equal(facts.inspectorVerdict, null);
});

test("this round's concluded checks are collected by name, red flag and all", () => {
  const facts = factsFromRecord(
    [
      event("work-started"),
      event("ci-check-concluded", { name: "inspector-tests", source: "status", conclusion: "success", red: false }),
      event("ci-check-concluded", { name: "docker-tests", source: "check_run", conclusion: "failure", red: true }),
      event("ci-checks-finished", { verdict: "red" }),
      event("delivered", { delivery: { outcome: "done", files: ["docs/a.md"] } }),
    ],
    COUNTS
  );
  assert.deepEqual(facts.concludedChecks, [
    { name: "inspector-tests", red: false },
    { name: "docker-tests", red: true },
  ]);
});

test("a check concluded twice in one round reads as its newest conclusion", () => {
  const facts = factsFromRecord(
    [
      event("work-started"),
      event("ci-check-concluded", { name: "docker-tests", red: true }),
      event("ci-check-concluded", { name: "docker-tests", red: false }),
      event("delivered", { delivery: { outcome: "done", files: ["docs/a.md"] } }),
    ],
    COUNTS
  );
  assert.deepEqual(facts.concludedChecks, [{ name: "docker-tests", red: false }]);
});

test("checks concluded in an EARLIER round do not answer for this one", () => {
  const facts = factsFromRecord(
    [
      event("work-started"),
      event("ci-check-concluded", { name: "inspector-tests", red: false }),
      event("delivered", { delivery: { outcome: "done", files: ["a.ts"] } }),
      event("verdict-recorded", { ruling: "fix" }),
      event("work-started"),
      event("delivered", { delivery: { outcome: "done", files: ["docs/a.md"] } }),
    ],
    COUNTS
  );
  assert.deepEqual(facts.concludedChecks, [], "a check from the previous round answered for this one");
});

test("questions asked is a fact about the whole task, and a later round does not undo it", () => {
  const asked = [
    event("task-received"),
    event("questions-asked", { questions: ["which button?"] }),
    event("answers-given"),
    event("work-started"),
    event("delivered", { delivery: { outcome: "done", files: ["docs/a.md"] } }),
  ];
  assert.equal(factsFromRecord(asked, COUNTS).questionsAsked, true);
  assert.equal(
    factsFromRecord([event("work-started"), event("delivered", { delivery: { outcome: "done", files: [] } })], COUNTS)
      .questionsAsked,
    false
  );
});

test("couldNotVerify comes off the delivery's write-up, trimmed, and is empty when there is none", () => {
  const withIt = factsFromRecord(
    [
      event("work-started"),
      event("delivered", {
        delivery: { outcome: "done", files: ["docs/a.md"] },
        writeup: { couldNotVerify: "  could not reach the staging API  " },
      }),
    ],
    COUNTS
  );
  assert.equal(withIt.couldNotVerify, "could not reach the staging API");

  const without = factsFromRecord(
    [event("work-started"), event("delivered", { delivery: { outcome: "done", files: ["docs/a.md"] }, writeup: {} })],
    COUNTS
  );
  assert.equal(without.couldNotVerify, "");
});

test("a task with no delivery at all answers no outcome and no files", () => {
  const facts = factsFromRecord([event("task-received"), event("work-started")], COUNTS);
  assert.equal(facts.outcome, null);
  assert.deepEqual(facts.files, []);
  assert.equal(facts.inspectorVerdict, null);
  assert.deepEqual(facts.concludedChecks, []);
});

test("a delivery whose details are the wrong shape answers nothing rather than throwing", () => {
  const facts = factsFromRecord([event("delivered", { delivery: { files: "not-a-list", outcome: 7 } })], null);
  assert.deepEqual(facts.files, []);
  assert.equal(facts.outcome, null);
  assert.equal(facts.counts, null);
});
