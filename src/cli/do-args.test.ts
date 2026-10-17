import { test } from "node:test";
import assert from "node:assert/strict";
import { CliError } from "./errors.ts";
import { parseDoArgs } from "./do-args.ts";

test("parseDoArgs: task text and --project", () => {
  assert.deepEqual(parseDoArgs(["fix the flaky test", "--project", "spending-app"]), {
    taskText: "fix the flaky test",
    projectArg: "spending-app",
  });
});

test("parseDoArgs: --project can come before the task text", () => {
  assert.deepEqual(parseDoArgs(["--project", "spending-app", "fix the flaky test"]), {
    taskText: "fix the flaky test",
    projectArg: "spending-app",
  });
});

test("parseDoArgs: --project=<value> form", () => {
  assert.deepEqual(parseDoArgs(["fix it", "--project=spending-app"]), {
    taskText: "fix it",
    projectArg: "spending-app",
  });
});

test("parseDoArgs: missing task text refuses with exact instructions", () => {
  assert.throws(
    () => parseDoArgs(["--project", "spending-app"]),
    (err: unknown) =>
      err instanceof CliError && err.code === "bad-usage" && err.message.includes('fabrica do "<task text>"')
  );
});

test("parseDoArgs: missing --project refuses with exact instructions", () => {
  assert.throws(
    () => parseDoArgs(["fix the flaky test"]),
    (err: unknown) => err instanceof CliError && err.code === "bad-usage" && err.message.includes("--project")
  );
});

test("parseDoArgs: --project with no value refuses", () => {
  assert.throws(
    () => parseDoArgs(["fix it", "--project"]),
    (err: unknown) => err instanceof CliError && err.code === "bad-usage"
  );
});

test("parseDoArgs: two positionals refuses (task text needs quoting)", () => {
  assert.throws(
    () => parseDoArgs(["fix", "the test", "--project", "spending-app"]),
    (err: unknown) => err instanceof CliError && err.code === "bad-usage" && err.message.includes("quotes")
  );
});

test("parseDoArgs: --issue <N> is the chat agent's explicit alternative to an \"Issue #N:\" prefix", () => {
  assert.deepEqual(parseDoArgs(["fix the flaky test", "--project", "spending-app", "--issue", "186"]), {
    taskText: "fix the flaky test",
    projectArg: "spending-app",
    issue: 186,
  });
});

test("parseDoArgs: --issue=<value> form", () => {
  assert.deepEqual(parseDoArgs(["fix it", "--project=spending-app", "--issue=7"]), {
    taskText: "fix it",
    projectArg: "spending-app",
    issue: 7,
  });
});

test("parseDoArgs: --issue must be a positive integer", () => {
  assert.throws(
    () => parseDoArgs(["fix it", "--project", "spending-app", "--issue", "0"]),
    (err: unknown) => err instanceof CliError && err.code === "bad-usage" && err.message.includes("--issue")
  );
  assert.throws(
    () => parseDoArgs(["fix it", "--project", "spending-app", "--issue", "nope"]),
    (err: unknown) => err instanceof CliError && err.code === "bad-usage" && err.message.includes("--issue")
  );
});

test("parseDoArgs: an unknown flag refuses", () => {
  assert.throws(
    () => parseDoArgs(["fix it", "--project", "spending-app", "--attempts", "3"]),
    (err: unknown) => err instanceof CliError && err.code === "bad-usage" && err.message.includes("--attempts")
  );
});
