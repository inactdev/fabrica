// Issue #103, Client ruling 2026-10-08 (the GitHub-token addendum):
// Inspector needs GITHUB_TOKEN to publish a green result. If Fabrica's own
// environment has one, it is passed through. If not, Fabrica asks
// `gh auth token` once and sets GITHUB_TOKEN in the inspector child's
// environment only - never in Fabrica's own process, never in the
// worker's box, never printed. If gh is missing or not logged in, the
// task is refused before any worker starts, naming `gh auth login`.
//
// Every token here is a fake test value; the fake inspector echoes it so
// the test can see what the child received.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "./foreman.ts";
import { ForemanError } from "./errors.ts";
import { inspectorAdapter } from "../inspector/index.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { readEvents } from "../record/index.ts";

function scriptDir(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-gh-token-"));
}

function script(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** A stand-in for the inspector command that reports, green, exactly
 * which GITHUB_TOKEN its own process received. */
function echoingInspector(): string {
  return script(scriptDir(), "inspector", `printf 'child GITHUB_TOKEN=%s' "\${GITHUB_TOKEN:-<unset>}"\nexit 0`);
}

/** PATH holding only a fake `gh` (when given) plus the system basics. */
function pathWith(ghBody: string | null): string {
  const dir = scriptDir();
  if (ghBody !== null) script(dir, "gh", ghBody);
  return `${dir}:/usr/bin:/bin`;
}

function withoutToken(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { GITHUB_TOKEN: _drop, ...rest } = env;
  return rest;
}

test("GITHUB_TOKEN set in Fabrica's environment: the inspector child sees it, and Fabrica's env is untouched", async () => {
  const before = process.env.GITHUB_TOKEN;
  const inspector = inspectorAdapter(echoingInspector(), {
    env: { ...withoutToken(process.env), PATH: pathWith("echo should-not-be-asked; exit 1"), GITHUB_TOKEN: "fake-from-env" },
  });

  inspector.prepare?.();
  const inspection = await inspector.inspect({ branch: "fabrica/t", workdir: scriptDir() });

  assert.equal(inspection.report, "child GITHUB_TOKEN=fake-from-env");
  assert.equal(process.env.GITHUB_TOKEN, before, "Fabrica's own environment was changed");
});

test("GITHUB_TOKEN unset, gh on PATH: the inspector child sees gh's answer, set in its environment only", async () => {
  const before = process.env.GITHUB_TOKEN;
  const ghDir = scriptDir();
  const calls = join(ghDir, "calls.log");
  const env: NodeJS.ProcessEnv = {
    ...withoutToken(process.env),
    PATH: pathWith(`echo "$*" >> "${calls}"\nprintf 'fake-from-gh\\n'`),
  };
  const inspector = inspectorAdapter(echoingInspector(), { env });

  inspector.prepare?.();
  const first = await inspector.inspect({ branch: "fabrica/t", workdir: scriptDir() });
  const second = await inspector.inspect({ branch: "fabrica/t", workdir: scriptDir() });

  assert.equal(first.report, "child GITHUB_TOKEN=fake-from-gh");
  assert.equal(second.report, "child GITHUB_TOKEN=fake-from-gh");
  assert.equal(process.env.GITHUB_TOKEN, before, "Fabrica's own environment was changed");
  assert.equal(env.GITHUB_TOKEN, undefined, "the environment the adapter was given was changed");
  assert.equal(readFileSync(calls, "utf8"), "auth token\n", "gh was asked more than once, or not with `auth token`");
});

for (const [label, ghBody] of [
  ["gh is not installed", null],
  ["gh is not logged in", "echo 'You are not logged into any GitHub hosts. To log in, run: gh auth login' >&2; exit 1"],
] as const) {
  test(`GITHUB_TOKEN unset and ${label}: refused before any worker starts, naming gh auth login`, async () => {
    const recordHome = mkdtempSync(join(tmpdir(), "fabrica-gh-token-home-"));
    const inspector = inspectorAdapter(echoingInspector(), {
      env: { ...withoutToken(process.env), PATH: pathWith(ghBody) },
    });
    const brain = fakeBrain();
    const foreman = createForeman({ recordHome, inspector });

    await assert.rejects(
      () => foreman.do("small change", { project: makeFixtureRepo("exit 0"), brain }),
      (err: unknown) => err instanceof ForemanError && /gh auth login/.test(err.message)
    );

    assert.equal(brain.calls, 0, "a worker ran without the token Inspector needs");
    assert.ok(!readEvents(recordHome).some((e) => e.name === "work-started"), "work started before the refusal");
  });
}
