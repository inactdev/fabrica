import { test } from "node:test";
import assert from "node:assert/strict";
import { CliError } from "./errors.ts";
import { parseLogArgs } from "./log-args.ts";

test("parseLogArgs: taskId only", () => {
  assert.deepEqual(parseLogArgs(["t1"]), { taskId: "t1", transcript: false });
});

test("parseLogArgs: --transcript flag, in either position", () => {
  assert.deepEqual(parseLogArgs(["t1", "--transcript"]), { taskId: "t1", transcript: true });
  assert.deepEqual(parseLogArgs(["--transcript", "t1"]), { taskId: "t1", transcript: true });
});

test("parseLogArgs: missing taskId refuses with usage", () => {
  assert.throws(() => parseLogArgs([]), (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.equal(err.code, "bad-usage");
    assert.match(err.message, /missing <taskId>/);
    return true;
  });
});

test("parseLogArgs: an unknown flag refuses, naming it", () => {
  assert.throws(() => parseLogArgs(["t1", "--bogus"]), /unknown flag "--bogus"/);
});

test("parseLogArgs: extra positionals refuse", () => {
  assert.throws(() => parseLogArgs(["t1", "t2"]), /expected just a taskId/);
});
