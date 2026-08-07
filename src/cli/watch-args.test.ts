import { test } from "node:test";
import assert from "node:assert/strict";
import { CliError } from "./errors.ts";
import { parseWatchArgs } from "./watch-args.ts";

test("parseWatchArgs: taskId only", () => {
  assert.deepEqual(parseWatchArgs(["t1"]), { taskId: "t1" });
});

test("parseWatchArgs: missing taskId refuses with usage", () => {
  assert.throws(() => parseWatchArgs([]), (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.equal(err.code, "bad-usage");
    assert.match(err.message, /missing <taskId>/);
    return true;
  });
});

test("parseWatchArgs: an unknown flag refuses, naming it", () => {
  assert.throws(() => parseWatchArgs(["t1", "--bogus"]), /unknown flag "--bogus"/);
});

test("parseWatchArgs: extra positionals refuse", () => {
  assert.throws(() => parseWatchArgs(["t1", "t2"]), /expected just a taskId/);
});
