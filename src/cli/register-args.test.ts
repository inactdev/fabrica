import { test } from "node:test";
import assert from "node:assert/strict";
import { CliError } from "./errors.ts";
import { REGISTER_USAGE, parseRegisterArgs } from "./register-args.ts";

test("parseRegisterArgs: the documented invocation", () => {
  assert.deepEqual(
    parseRegisterArgs(["/repo", "--check", "npm test", "--image", "cimg/node:24.18.0"]),
    { path: "/repo", check: "npm test", image: "cimg/node:24.18.0", protectedPaths: [] }
  );
});

test("parseRegisterArgs: --protected splits on commas, trimming and dropping empties", () => {
  const args = parseRegisterArgs([
    "/repo",
    "--check",
    "npm test",
    "--image",
    "node:24",
    "--protected",
    " *.test.ts , contract/** ,, CONTRACT.md ",
  ]);
  assert.deepEqual(args.protectedPaths, ["*.test.ts", "contract/**", "CONTRACT.md"]);
});

test("parseRegisterArgs: no --protected is an empty list, not undefined", () => {
  assert.deepEqual(parseRegisterArgs(["/repo"]).protectedPaths, []);
});

test("parseRegisterArgs: --name overrides the default project name", () => {
  assert.equal(parseRegisterArgs(["/repo", "--name", "spending-app"]).name, "spending-app");
});

test("parseRegisterArgs: every value flag also accepts the --flag=value form", () => {
  const args = parseRegisterArgs([
    "--check=npm test",
    "--image=node:24",
    "--protected=*.test.ts",
    "--name=repo",
    "/repo",
  ]);
  assert.deepEqual(args, {
    path: "/repo",
    check: "npm test",
    image: "node:24",
    protectedPaths: ["*.test.ts"],
    name: "repo",
  });
});

// --check and --image are checked for presence by src/register, which is
// the only layer that knows whether this repository needs them (Client
// ruling: in the shortcut case they are not required). Parsing must not
// pre-empt that decision.
test("parseRegisterArgs: a bare path parses - --check/--image are not required here", () => {
  assert.deepEqual(parseRegisterArgs(["/repo"]), { path: "/repo", protectedPaths: [] });
});

test("parseRegisterArgs: missing path refuses with the usage line", () => {
  assert.throws(
    () => parseRegisterArgs(["--check", "npm test"]),
    (err: unknown) =>
      err instanceof CliError && err.code === "bad-usage" && err.message.includes(REGISTER_USAGE)
  );
});

test("parseRegisterArgs: two positionals refuses rather than guessing which is the path", () => {
  assert.throws(
    () => parseRegisterArgs(["/repo", "npm test"]),
    (err: unknown) => err instanceof CliError && err.message.includes("expected one path")
  );
});

test("parseRegisterArgs: an unknown flag refuses, naming it", () => {
  assert.throws(
    () => parseRegisterArgs(["/repo", "--force", "yes"]),
    (err: unknown) => err instanceof CliError && err.message.includes("--force")
  );
});

// inspector#47 retired the key --network wrote, so the flag is gone
// outright (issue #303, Client ruling): an unknown-flag refusal whose
// message says where dependencies go now, since "unknown flag" alone
// would read as a typo in a flag that used to work.
test("parseRegisterArgs: --network is gone, and the refusal says what replaced it", () => {
  for (const spelling of ["--network", "--network=true", "--network=false"]) {
    assert.throws(
      () => parseRegisterArgs(["/repo", spelling]),
      (err: unknown) =>
        err instanceof CliError &&
        err.code === "bad-usage" &&
        err.message.includes(`unknown flag "--network"`) &&
        err.message.includes("no network") &&
        err.message.includes("Dockerfile.inspector"),
      `${spelling} should refuse, naming Dockerfile.inspector`
    );
  }
});

test("parseRegisterArgs: the usage line no longer offers --network", () => {
  assert.ok(!REGISTER_USAGE.includes("--network"), REGISTER_USAGE);
});

test("parseRegisterArgs: --timeout takes a whole number of seconds", () => {
  assert.equal(parseRegisterArgs(["/repo", "--timeout", "1200"]).timeoutSeconds, 1200);
  assert.equal(parseRegisterArgs(["/repo", "--timeout=600"]).timeoutSeconds, 600);
  assert.equal(parseRegisterArgs(["/repo"]).timeoutSeconds, undefined, "absent leaves Inspector's own default");
});

// A timeout written into .inspector.json has to be a number of seconds -
// "0" is a check given no time at all, and "10m" is a spelling the key
// cannot carry.
test("parseRegisterArgs: a --timeout that is not a positive whole number refuses", () => {
  for (const bad of ["0", "10m", "-5", "1.5", "lots", "  "]) {
    assert.throws(
      () => parseRegisterArgs(["/repo", "--timeout", bad]),
      (err: unknown) => err instanceof CliError && err.message.includes("whole number of seconds"),
      `--timeout ${bad} should refuse`
    );
  }
});

test("parseRegisterArgs: a flag with no value refuses", () => {
  for (const flag of ["--check", "--image", "--protected", "--name", "--timeout"]) {
    assert.throws(
      () => parseRegisterArgs(["/repo", flag]),
      (err: unknown) => err instanceof CliError && err.message.includes(`${flag} needs a value`),
      `${flag} with no value should refuse`
    );
  }
});

// An empty --check would be written into check.sh as an empty command,
// which passes vacuously - exactly the "verified" work rule 2 forbids.
test("parseRegisterArgs: an empty value refuses rather than becoming a vacuous check", () => {
  for (const flag of ["--check", "--image", "--name"]) {
    assert.throws(
      () => parseRegisterArgs(["/repo", flag, "   "]),
      (err: unknown) => err instanceof CliError && err.message.includes("empty value"),
      `${flag} with a blank value should refuse`
    );
  }
});
