import { test } from "node:test";
import assert from "node:assert/strict";
import { CliError } from "./errors.ts";
import { parseVerdictArgs } from "./verdict-args.ts";

test("parseVerdictArgs: taskId, ruling, and a note", () => {
  assert.deepEqual(parseVerdictArgs(["20260804-fix-flaky-test-4f", "fix", "wrong button spot"]), {
    taskId: "20260804-fix-flaky-test-4f",
    ruling: "fix",
    note: "wrong button spot",
  });
});

test("parseVerdictArgs: accept with no note", () => {
  assert.deepEqual(parseVerdictArgs(["some-task", "accept"]), {
    taskId: "some-task",
    ruling: "accept",
    note: undefined,
  });
});

test("parseVerdictArgs: wrong with an optional note", () => {
  assert.deepEqual(parseVerdictArgs(["some-task", "wrong", "not what I asked for"]), {
    taskId: "some-task",
    ruling: "wrong",
    note: "not what I asked for",
  });
});

test("parseVerdictArgs: missing taskId refuses with exact instructions", () => {
  assert.throws(
    () => parseVerdictArgs([]),
    (err: unknown) => err instanceof CliError && err.code === "bad-usage" && err.message.includes("<taskId>")
  );
});

test("parseVerdictArgs: missing ruling refuses with exact instructions", () => {
  assert.throws(
    () => parseVerdictArgs(["some-task"]),
    (err: unknown) =>
      err instanceof CliError && err.code === "bad-usage" && err.message.includes("<accept|fix|wrong>")
  );
});

test("parseVerdictArgs: an unrecognized ruling refuses, naming the valid ones", () => {
  assert.throws(
    () => parseVerdictArgs(["some-task", "maybe"]),
    (err: unknown) =>
      err instanceof CliError && err.code === "bad-usage" && err.message.includes("accept, fix, wrong")
  );
});

test("parseVerdictArgs: fix without a note refuses, since the note is the correction", () => {
  assert.throws(
    () => parseVerdictArgs(["some-task", "fix"]),
    (err: unknown) => err instanceof CliError && err.code === "bad-usage" && err.message.includes("needs a note")
  );
});

test("parseVerdictArgs: fix with a blank note refuses the same way", () => {
  assert.throws(
    () => parseVerdictArgs(["some-task", "fix", "   "]),
    (err: unknown) => err instanceof CliError && err.code === "bad-usage" && err.message.includes("needs a note")
  );
});

test("parseVerdictArgs: too many positionals refuses (note needs quoting)", () => {
  assert.throws(
    () => parseVerdictArgs(["some-task", "fix", "the", "button"]),
    (err: unknown) => err instanceof CliError && err.code === "bad-usage" && err.message.includes("quotes")
  );
});

test("parseVerdictArgs: an unknown flag refuses", () => {
  assert.throws(
    () => parseVerdictArgs(["some-task", "accept", "--force"]),
    (err: unknown) => err instanceof CliError && err.code === "bad-usage" && err.message.includes("--force")
  );
});
