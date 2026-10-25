import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTestsMapArgs, TESTS_MAP_USAGE } from "./tests-map-args.ts";
import { CliError } from "./errors.ts";

test("the path defaults to the current directory, and --force is off", () => {
  assert.deepEqual(parseTestsMapArgs([]), { pathArg: ".", force: false });
});

test("one positional is the project folder; --force and -f both ask to replace", () => {
  assert.deepEqual(parseTestsMapArgs(["../demo"]), { pathArg: "../demo", force: false });
  assert.deepEqual(parseTestsMapArgs(["../demo", "--force"]), { pathArg: "../demo", force: true });
  assert.deepEqual(parseTestsMapArgs(["-f"]), { pathArg: ".", force: true });
});

test("an unknown flag and a second path both refuse with the usage line", () => {
  for (const argv of [["--all"], ["-x"], ["a", "b"]]) {
    assert.throws(
      () => parseTestsMapArgs(argv),
      (err: unknown) => {
        assert.ok(err instanceof CliError, `not a CliError: ${err}`);
        assert.equal(err.code, "bad-usage");
        assert.ok(err.message.includes(TESTS_MAP_USAGE), `no usage line in: ${err.message}`);
        return true;
      },
      `parseTestsMapArgs accepted ${JSON.stringify(argv)}`
    );
  }
});
