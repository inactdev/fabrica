import { test } from "node:test";
import assert from "node:assert/strict";
import { CliError } from "./errors.ts";
import { parseAnswerArgs } from "./answer-args.ts";

test("parseAnswerArgs: taskId and answer text", () => {
  assert.deepEqual(parseAnswerArgs(["20260804-fix-flaky-test-4f", "Use Postgres, no multi-tenancy."]), {
    taskId: "20260804-fix-flaky-test-4f",
    text: "Use Postgres, no multi-tenancy.",
  });
});

test("parseAnswerArgs: missing taskId refuses with exact instructions", () => {
  assert.throws(
    () => parseAnswerArgs([]),
    (err: unknown) => err instanceof CliError && err.code === "bad-usage" && err.message.includes("<taskId>")
  );
});

test("parseAnswerArgs: missing text refuses with exact instructions", () => {
  assert.throws(
    () => parseAnswerArgs(["some-task"]),
    (err: unknown) => err instanceof CliError && err.code === "bad-usage" && err.message.includes('"<text>"')
  );
});

test("parseAnswerArgs: too many positionals refuses (the answer needs quoting)", () => {
  assert.throws(
    () => parseAnswerArgs(["some-task", "use", "postgres"]),
    (err: unknown) => err instanceof CliError && err.code === "bad-usage" && err.message.includes("quotes")
  );
});

test("parseAnswerArgs: an unknown flag refuses", () => {
  assert.throws(
    () => parseAnswerArgs(["some-task", "an answer", "--force"]),
    (err: unknown) => err instanceof CliError && err.code === "bad-usage" && err.message.includes("--force")
  );
});

test("parseAnswerArgs: a blank answer refuses", () => {
  assert.throws(
    () => parseAnswerArgs(["some-task", "   "]),
    (err: unknown) => err instanceof CliError && err.code === "bad-usage" && err.message.includes("can't be empty")
  );
});
