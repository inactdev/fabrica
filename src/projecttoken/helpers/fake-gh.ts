// A stand-in `gh` on a PATH of its own, for the tests of issue #331's
// `githubToken = "gh"`.
//
// Deliberately a real executable spawned for real, the same approach
// src/inspector/doctor-checks.test.ts takes for the `inspector` binary:
// what is being tested is how Fabrica reads a command's exit code,
// stdout and stderr, and a function-shaped seam standing in for the
// spawn would test neither.
//
// The PATH handed back holds **only** this fake (plus /usr/bin and /bin
// for the shell itself). A test must never reach the real `gh` on the
// machine running it: the tester's own GitHub login would then decide
// whether a test passes, which is a test passing for the wrong reason.

import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeGh {
  /** The environment to hand `ghAuthToken`/`ghPublishAnswer` - a PATH
   * with the fake on it and nothing else of this machine's. */
  env: NodeJS.ProcessEnv;
  /** The directory holding the fake, for a test that has to prepend it
   * to the real `PATH` instead - one driving a path with no seam to pass
   * an environment through (`fabrica do`'s own start gate). Such a test
   * owns restoring `process.env.PATH` itself. */
  dir: string;
  /** Every invocation's arguments, in order, as one line each. */
  calls(): string[];
}

/**
 * A `gh` whose body is the shell `script` given - `exit 4`, `printf
 * 'gho_x\n'`, whatever the case under test needs.
 *
 * Every call's own arguments are logged first, so a test can assert
 * Fabrica asked for `auth token --hostname github.com` and nothing else.
 */
export function fakeGh(script: string): FakeGh {
  const dir = mkdtempSync(join(tmpdir(), "fabrica-fake-gh-"));
  const calls = join(dir, "calls");
  const command = join(dir, "gh");
  writeFileSync(command, `#!/bin/sh\necho "$@" >> ${JSON.stringify(calls)}\n${script}\n`);
  chmodSync(command, 0o755);
  return {
    env: { PATH: `${dir}:/usr/bin:/bin` },
    dir,
    calls() {
      try {
        return readFileSync(calls, "utf8").split("\n").filter((line) => line.length > 0);
      } catch {
        return [];
      }
    },
  };
}

/** An environment with no `gh` anywhere on it - the machine that never
 * installed the GitHub CLI. */
export function noGh(): NodeJS.ProcessEnv {
  return { PATH: mkdtempSync(join(tmpdir(), "fabrica-no-gh-")) };
}
