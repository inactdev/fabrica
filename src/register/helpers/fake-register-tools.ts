// A RegisterTools that reaches nothing outside the test: no `gh`, no
// Docker daemon, no network. Everything else about a register run - the
// real `git worktree add`, the real commit, a real push to a fixture's
// own bare origin, the real teardown, the real projects.toml write -
// stays real, so what these fakes stand in for is exactly the set of
// things a test machine genuinely may not have.
//
// The check "runs" by reading the worktree's own check.sh and honoring
// what it says, the same trick contract/helpers/fake-check-box.ts uses:
// a fixture written to be red stays red here.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BoxCheckResult } from "../../brain/index.ts";
import type { PrerequisiteResult, PullRequestResult, RegisterTools } from "../tools.ts";

export interface FakeRegisterToolsOptions {
  gh?: PrerequisiteResult;
  docker?: PrerequisiteResult;
  /** Overrides the read-check.sh behavior entirely. */
  check?: (opts: { workdir: string; image: string; command: string }) => BoxCheckResult;
  pullRequest?: PullRequestResult;
}

export interface FakeRegisterToolsHandle extends RegisterTools {
  readonly checkCalls: readonly { workdir: string; image: string; command: string }[];
  readonly pullRequestCalls: readonly {
    worktree: string;
    base: string;
    head: string;
    title: string;
    body: string;
  }[];
}

/** The exit status `check.sh` in `workdir` would produce, read rather
 * than run: a `#!/bin/sh` script whose command is `exit N` (what
 * makeFixtureRepo and scaffold.ts's checkScript both produce). Anything
 * else counts as passing - there is nothing to disbelieve.
 *
 * Only the script's **last** line is read, not any line in it. A
 * preamble can have an `exit` of its own in a branch that is not taken
 * (issue #324's service-waiting loop fails the check with `exit 1` when
 * a server never answers), and reading that one would report a red check
 * for a script whose actual command is the suite. */
function scriptedExit(workdir: string): number {
  let source: string;
  try {
    source = readFileSync(join(workdir, "check.sh"), "utf8");
  } catch {
    return 127;
  }
  const last = source.trimEnd().split("\n").at(-1) ?? ``;
  const match = /^\s*exit\s+(\d+)\s*$/.exec(last);
  return match ? Number(match[1]) : 0;
}

export function fakeRegisterTools(opts: FakeRegisterToolsOptions = {}): FakeRegisterToolsHandle {
  const checkCalls: { workdir: string; image: string; command: string }[] = [];
  const pullRequestCalls: {
    worktree: string;
    base: string;
    head: string;
    title: string;
    body: string;
  }[] = [];

  return {
    checkCalls,
    pullRequestCalls,
    ghStatus: () => opts.gh ?? { ok: true, detail: "fake gh: logged in" },
    dockerStatus: () => opts.docker ?? { ok: true, detail: "fake docker: reachable" },
    async runCheck(call) {
      checkCalls.push(call);
      if (opts.check) return opts.check(call);
      const exitCode = scriptedExit(call.workdir);
      return { ran: true, exitCode, output: `fake container (${call.image}): ${call.command} -> exit ${exitCode}` };
    },
    openPullRequest(call) {
      pullRequestCalls.push(call);
      return opts.pullRequest ?? { url: "https://github.com/fake/repo/pull/1", message: "fake gh pr create" };
    },
  };
}
