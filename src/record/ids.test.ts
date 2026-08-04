import { test } from "node:test";
import assert from "node:assert/strict";
import { TASK_ID_PATTERN, claimTaskId, generateCandidateId } from "./ids.ts";
import { RecordError } from "./errors.ts";

const FIXED_NOW = new Date("2026-08-04T12:00:00.000Z");

test("generateCandidateId: matches the documented YYYYMMDD-<slug>-<2 chars> shape", () => {
  const id = generateCandidateId("Fix the login bug", FIXED_NOW);
  assert.match(id, TASK_ID_PATTERN);
  assert.ok(id.startsWith("20260804-fix-the-login-bug-"), id);
});

test("generateCandidateId: punctuation collapses to single dashes, lowercased", () => {
  const id = generateCandidateId("  Ship v1.2!! Now??  ", FIXED_NOW);
  assert.match(id, TASK_ID_PATTERN);
  assert.ok(id.startsWith("20260804-ship-v1-2-now-"), id);
});

test("generateCandidateId: an all-punctuation task text falls back to a non-empty slug", () => {
  const id = generateCandidateId("!!!???", FIXED_NOW);
  assert.match(id, TASK_ID_PATTERN);
  assert.ok(id.startsWith("20260804-task-"), id);
});

test("generateCandidateId: a very long task text is capped, never producing a runaway id", () => {
  const id = generateCandidateId("x".repeat(500), FIXED_NOW);
  assert.match(id, TASK_ID_PATTERN);
  assert.ok(id.length < 100, `expected a capped id, got ${id.length} chars`);
});

test("claimTaskId: returns the first candidate the claim function accepts", () => {
  const id = claimTaskId("small change", FIXED_NOW, () => true);
  assert.match(id, TASK_ID_PATTERN);
});

test("claimTaskId: retries on collision until claim() accepts a candidate", () => {
  let calls = 0;
  const seen: string[] = [];
  const id = claimTaskId("small change", FIXED_NOW, (candidate) => {
    calls += 1;
    seen.push(candidate);
    return calls === 3; // first two candidates are "taken", third succeeds
  });
  assert.equal(calls, 3);
  assert.match(id, TASK_ID_PATTERN);
  assert.equal(seen[seen.length - 1], id);
});

test("claimTaskId: gives up with a RecordError if every attempt collides", () => {
  assert.throws(
    () => claimTaskId("small change", FIXED_NOW, () => false),
    (err: unknown) => {
      assert.ok(err instanceof RecordError);
      assert.equal(err.code, "id-exhausted");
      return true;
    }
  );
});
