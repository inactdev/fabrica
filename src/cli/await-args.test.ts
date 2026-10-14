import { test } from "node:test";
import assert from "node:assert/strict";
import { CliError } from "./errors.ts";
import { parseAwaitArgs } from "./await-args.ts";

test("parseAwaitArgs: taskId only", () => {
  assert.deepEqual(parseAwaitArgs(["t1"]), { taskId: "t1" });
});

test("parseAwaitArgs: missing taskId refuses with usage", () => {
  assert.throws(() => parseAwaitArgs([]), (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.equal(err.code, "bad-usage");
    assert.match(err.message, /missing <taskId>/);
    return true;
  });
});

test("parseAwaitArgs: an unknown flag refuses, naming it", () => {
  assert.throws(() => parseAwaitArgs(["t1", "--bogus"]), /unknown flag "--bogus"/);
});

test("parseAwaitArgs: extra positionals refuse", () => {
  assert.throws(() => parseAwaitArgs(["t1", "t2"]), /expected just a taskId/);
});
