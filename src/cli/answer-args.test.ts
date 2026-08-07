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
