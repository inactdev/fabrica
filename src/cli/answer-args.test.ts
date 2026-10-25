import { test } from "node:test";
import assert from "node:assert/strict";
import { CliError } from "./errors.ts";
import { parseAnswerArgs } from "./answer-args.ts";

test("parseAnswerArgs: taskId and answer text", () => {
  assert.deepEqual(parseAnswerArgs(["20260804-fix-flaky-test-4f", "-m", "Use Postgres, no multi-tenancy."]), {
    taskId: "20260804-fix-flaky-test-4f",
    text: "Use Postgres, no multi-tenancy.",
  });
});

test("parseAnswerArgs: an answer starting with a dash goes through cleanly", () => {
  assert.deepEqual(parseAnswerArgs(["some-task", "-m", "-1 means unlimited"]), {
    taskId: "some-task",
    text: "-1 means unlimited",
  });
});

test("parseAnswerArgs: missing taskId refuses with exact instructions", () => {
  assert.throws(
    () => parseAnswerArgs(["-m", "an answer"]),
    (err: unknown) => err instanceof CliError && err.code === "bad-usage" && err.message.includes("<taskId>")
  );
});

test("parseAnswerArgs: missing -m refuses with exact instructions", () => {
  assert.throws(
    () => parseAnswerArgs(["some-task"]),
    (err: unknown) =>
      err instanceof CliError && err.code === "bad-usage" && err.message.includes('-m "<text>"')
  );
});

test("parseAnswerArgs: -m with nothing after it refuses", () => {
  assert.throws(
    () => parseAnswerArgs(["some-task", "-m"]),
    (err: unknown) => err instanceof CliError && err.code === "bad-usage" && err.message.includes("-m needs an answer")
  );
});

test("parseAnswerArgs: a bare positional answer refuses, pointing at -m", () => {
  assert.throws(
    () => parseAnswerArgs(["some-task", "use postgres"]),
    (err: unknown) => err instanceof CliError && err.code === "bad-usage" && err.message.includes("-m")
  );
});

test("parseAnswerArgs: too many positionals refuses (the answer needs -m and quoting)", () => {
  assert.throws(
    () => parseAnswerArgs(["some-task", "use", "postgres"]),
    (err: unknown) => err instanceof CliError && err.code === "bad-usage" && err.message.includes("quoted")
  );
});

test("parseAnswerArgs: an unknown flag refuses", () => {
  assert.throws(
    () => parseAnswerArgs(["some-task", "-m", "an answer", "--force"]),
    (err: unknown) => err instanceof CliError && err.code === "bad-usage" && err.message.includes("--force")
  );
});

test("parseAnswerArgs: a blank answer refuses", () => {
  assert.throws(
    () => parseAnswerArgs(["some-task", "-m", "   "]),
    (err: unknown) => err instanceof CliError && err.code === "bad-usage" && err.message.includes("actual text")
  );
});

// Issue #176: a question arrives as a numbered menu, so picking one by
// number is the ordinary way to answer it.
test("parseAnswerArgs: an option pick needs no text at all, in either spelling", () => {
  assert.deepEqual(parseAnswerArgs(["some-task", "--option", "2"]), { taskId: "some-task", text: "", option: 2 });
  assert.deepEqual(parseAnswerArgs(["some-task", "-o", "1"]), { taskId: "some-task", text: "", option: 1 });
});

test("parseAnswerArgs: an option and text together go through - the Foreman decides whether that pairing is allowed", () => {
  assert.deepEqual(parseAnswerArgs(["some-task", "--option", "3", "-m", "DuckDB"]), {
    taskId: "some-task",
    text: "DuckDB",
    option: 3,
  });
});

test("parseAnswerArgs: an option that isn't a positive whole number refuses, naming what it takes", () => {
  for (const bad of ["0", "-1", "two", "1.5", ""]) {
    assert.throws(
      () => parseAnswerArgs(["some-task", "--option", bad]),
      (err: unknown) => err instanceof CliError && err.code === "bad-usage" && err.message.includes("option's number"),
      `--option ${bad} must refuse`
    );
  }
  assert.throws(
    () => parseAnswerArgs(["some-task", "--option"]),
    (err: unknown) => err instanceof CliError && err.message.includes("needs an option number")
  );
});

// Issue #175: naming the question is how a correction reaches an answer
// already given.
test("parseAnswerArgs: --question carries the question id", () => {
  assert.deepEqual(parseAnswerArgs(["some-task", "--question", "q-0123456789ab", "-m", "no, SQLite"]), {
    taskId: "some-task",
    text: "no, SQLite",
    questionId: "q-0123456789ab",
  });
});

test("parseAnswerArgs: a --question that isn't a question id refuses, naming the shape", () => {
  for (const bad of ["1", "q-123", "Q-0123456789AB", "0123456789ab"]) {
    assert.throws(
      () => parseAnswerArgs(["some-task", "--question", bad, "-m", "x"]),
      (err: unknown) => err instanceof CliError && err.code === "bad-usage" && err.message.includes("12 hex"),
      `--question ${bad} must refuse`
    );
  }
  assert.throws(
    () => parseAnswerArgs(["some-task", "--question"]),
    (err: unknown) => err instanceof CliError && err.message.includes("needs a question id")
  );
});

test("parseAnswerArgs: with neither an option nor text, the refusal names both ways to answer", () => {
  assert.throws(
    () => parseAnswerArgs(["some-task", "--question", "q-0123456789ab"]),
    (err: unknown) => err instanceof CliError && err.message.includes("--option <n>") && err.message.includes('-m "<text>"')
  );
});
