import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildArgsIn, declaredBuildArgs, BUILD_ARGS_KEY } from "./declared.ts";

function configDir(text: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "fabrica-declared-args-"));
  if (text !== null) writeFileSync(join(dir, ".inspector.json"), text);
  return dir;
}

test("both entry forms are read: a file on its own, and a file with a pattern", () => {
  const dir = configDir(
    JSON.stringify({
      check: "./check.sh",
      [BUILD_ARGS_KEY]: {
        NODE_VERSION: { file: ".node-version" },
        GO_VERSION: { file: "go.mod", pattern: "^go[ \\t]+([0-9][^\\s]*)$" },
      },
    })
  );
  assert.deepEqual(declaredBuildArgs(dir), {
    NODE_VERSION: { file: ".node-version" },
    GO_VERSION: { file: "go.mod", pattern: "^go[ \\t]+([0-9][^\\s]*)$" },
  });
});

test("no config, no key, and an unparseable config all read as no build arguments", () => {
  assert.deepEqual(declaredBuildArgs(configDir(null)), {});
  assert.deepEqual(declaredBuildArgs(configDir(`{"check":"./check.sh"}`)), {});
  assert.deepEqual(declaredBuildArgs(configDir(`{ not json`)), {});
  assert.deepEqual(declaredBuildArgs(configDir(`[]`)), {});
});

// Each of these could not become an `ARG` in any Dockerfile, or could
// not be read out of any file - so each is dropped here rather than
// turned into a build argument nothing could resolve.
test("an entry nothing could consume is dropped", () => {
  assert.deepEqual(
    buildArgsIn({
      [BUILD_ARGS_KEY]: {
        "9LIVES": { file: ".ruby-version" },
        "has-a-dash": { file: ".ruby-version" },
        EMPTY_FILE: { file: "   " },
        NOT_A_STRING: { file: 7 },
        A_LIST: ["x"],
        NOTHING: null,
        GOOD: { file: ".ruby-version" },
      },
    }),
    { GOOD: { file: ".ruby-version" } }
  );
  assert.deepEqual(buildArgsIn({ [BUILD_ARGS_KEY]: [] }), {});
  assert.deepEqual(buildArgsIn(null), {});
});

test("an unusable pattern leaves the file, since the file alone still names a value", () => {
  assert.deepEqual(buildArgsIn({ [BUILD_ARGS_KEY]: { RUBY_VERSION: { file: ".ruby-version", pattern: 7 } } }), {
    RUBY_VERSION: { file: ".ruby-version" },
  });
  assert.deepEqual(buildArgsIn({ [BUILD_ARGS_KEY]: { RUBY_VERSION: { file: ".ruby-version", pattern: "" } } }), {
    RUBY_VERSION: { file: ".ruby-version" },
  });
});

// A round reads its answer at the commit its task was cut from, the
// same way `declaredBuildSecrets` and `declaresTestPaths` do: the
// worktree's copy of this file is one a Worker has had its hands on.
test("a revision reads the config out of that commit, not the working tree", () => {
  const dir = mkdtempSync(join(tmpdir(), "fabrica-declared-args-git-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  writeFileSync(
    join(dir, ".inspector.json"),
    JSON.stringify({ [BUILD_ARGS_KEY]: { RUBY_VERSION: { file: ".ruby-version" } } })
  );
  git("add", "-A");
  git("commit", "-qm", "committed");
  // What a Worker could do to its own worktree's copy.
  writeFileSync(
    join(dir, ".inspector.json"),
    JSON.stringify({ [BUILD_ARGS_KEY]: { RUBY_VERSION: { file: "anything-i-like" } } })
  );

  assert.deepEqual(declaredBuildArgs(dir, "HEAD"), { RUBY_VERSION: { file: ".ruby-version" } });
  assert.deepEqual(declaredBuildArgs(dir), { RUBY_VERSION: { file: "anything-i-like" } });
  // A revision with no such file is no build arguments, never a throw.
  assert.deepEqual(declaredBuildArgs(dir, "HEAD~0:nope"), {});
});
