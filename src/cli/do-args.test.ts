import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

// The two spellings that name a repository (Client ruling on carrying an
// issue into the brief) travel as the text they were typed as: which
// repository a bare number means is only knowable once the project's
// origin remote is read, at registration, so the CLI deliberately
// resolves nothing here - it only refuses a value that names no issue at
// all, before a detached process is spawned for it.
test("parseDoArgs: --issue owner/repo#N and a pasted issue URL are kept as typed", () => {
  for (const value of ["inactdev/inspector#45", "https://github.com/inactdev/inspector/issues/45"]) {
    assert.deepEqual(parseDoArgs(["do the Fabrica half", "--project", "fabrica", "--issue", value]), {
      taskText: "do the Fabrica half",
      projectArg: "fabrica",
      issue: value,
    });
  }
});

test("parseDoArgs: --issue must name an issue", () => {
  assert.throws(
    () => parseDoArgs(["fix it", "--project", "spending-app", "--issue", "0"]),
    (err: unknown) => err instanceof CliError && err.code === "bad-usage" && err.message.includes("--issue")
  );
  for (const bad of ["nope", "-3", "owner/repo#", "https://github.com/inactdev/fabrica/pull/4"]) {
    assert.throws(
      () => parseDoArgs(["fix it", "--project", "spending-app", "--issue", bad]),
      (err: unknown) => err instanceof CliError && err.code === "bad-usage" && err.message.includes("--issue"),
      bad
    );
  }
});

// Issue #184: "nothing lets a project ask for a cheaper one" - this is
// the per-task half of the answer, the project's own `model` setting
// being the standing one.
test("parseDoArgs: --model <name> names the model this one task asks for", () => {
  assert.deepEqual(parseDoArgs(["fix it", "--project", "spending-app", "--model", "small-5"]), {
    taskText: "fix it",
    projectArg: "spending-app",
    model: "small-5",
  });
  assert.deepEqual(parseDoArgs(["fix it", "--project=spending-app", "--model=small-5"]), {
    taskText: "fix it",
    projectArg: "spending-app",
    model: "small-5",
  });
  // Both flags together, and neither at all.
  assert.deepEqual(parseDoArgs(["fix it", "--project", "app", "--issue", "184", "--model", "small-5"]), {
    taskText: "fix it",
    projectArg: "app",
    issue: 184,
    model: "small-5",
  });
  assert.deepEqual(parseDoArgs(["fix it", "--project", "app"]), { taskText: "fix it", projectArg: "app" });
});

test("parseDoArgs: --model with nothing behind it refuses rather than silently running the default", () => {
  for (const argv of [
    ["fix it", "--project", "app", "--model"],
    ["fix it", "--project", "app", "--model", "   "],
    ["fix it", "--project", "app", "--model="],
  ]) {
    assert.throws(
      () => parseDoArgs(argv),
      (err: unknown) => err instanceof CliError && err.code === "bad-usage" && err.message.includes("--model"),
      `${argv.join(" ")} must refuse`
    );
  }
});

test("parseDoArgs: an unknown flag refuses", () => {
  assert.throws(
    () => parseDoArgs(["fix it", "--project", "spending-app", "--attempts", "3"]),
    (err: unknown) => err instanceof CliError && err.code === "bad-usage" && err.message.includes("--attempts")
  );
});

// Deciding *when* the chat agent should pass --issue itself is a
// judgment call written down in HANDBOOK.md's case 1, not something
// Fabrica's own code enforces - there's nothing under src/ that chooses
// it for the agent (see pr-body.ts's issueNamedByTaskText, which only
// ever matches the literal "Issue #N:" prefix). These read the
// handbook's own prose directly, the same way rule9-gate.contract-paths
// .test.ts proves CI wording with no Fabrica code behind it to unit-test.
const here = dirname(fileURLToPath(import.meta.url));
const handbook = readFileSync(join(here, "..", "..", "HANDBOOK.md"), "utf8");

test("HANDBOOK.md: --issue is attached when the sentence names exactly one issue as the whole of the task, in any wording", () => {
  assert.match(handbook, /look at issue #203 and\s+make a pull request to close it/);
  assert.match(handbook, /"?do #203"?/);
  assert.match(handbook, /fix the bug in #203/);
});

test("HANDBOOK.md: --issue stays off when the issue is only part of the task, or more than one is named", () => {
  assert.match(handbook, /the first half of #186/);
  assert.match(handbook, /the Inspector side of #109/);
  assert.match(handbook, /more than one issue is named/);
});

test("HANDBOOK.md: the \"Issue #N:\" prefix still works automatically, with no flag needed", () => {
  assert.match(handbook, /already open with "Issue #N:"/);
  assert.match(handbook, /that happens automatically/);
});
