// Issue #187: the credential Inspector publishes with is a GitHub App
// installation token, minted for this task's repository alone with only
// `contents: write` and `pull_requests: write`, handed to the inspector
// child as GITHUB_TOKEN, and discarded when that child exits. It is
// minted once per handoff, never cached across rounds, and never put in
// Fabrica's own process environment or the worker's box.
//
// This file replaces inspector-github-token.test.ts, which pinned the
// behaviour this issue removed: GITHUB_TOKEN passed through from
// Fabrica's environment, else `gh auth token`, with a refusal naming
// `gh auth login`. There is no personal-token path left to test.
//
// Every token here is a fake test value; the fake inspector echoes it so
// the test can see what the child received.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "./foreman.ts";
import { ForemanError } from "./errors.ts";
import { inspectorAdapter } from "../inspector/index.ts";
import { PUBLISH_PERMISSIONS, scopedToken } from "../githubapp/index.ts";
import { fakeMinter } from "../githubapp/helpers/fake-minter.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { readEvents } from "../record/index.ts";

const SCOPE = { owner: "acme", repo: "widgets", permissions: PUBLISH_PERMISSIONS };

function scriptDir(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-gh-app-"));
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

test("the minted token reaches the inspector child as GITHUB_TOKEN, and Fabrica's own environment is untouched", async () => {
  const before = process.env.GITHUB_TOKEN;
  const minter = fakeMinter({ token: "fake-installation-token-1" });
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
  const inspector = inspectorAdapter(echoingInspector(), {
    env,
    token: scopedToken(minter, "publish", SCOPE),
  });

  inspector.prepare?.();
  const inspection = await inspector.inspect({ branch: "fabrica/t", workdir: scriptDir() });

  assert.equal(inspection.report, "child GITHUB_TOKEN=fake-installation-token-1");
  assert.equal(process.env.GITHUB_TOKEN, before, "Fabrica's own environment was changed");
  assert.equal(env.GITHUB_TOKEN, undefined, "the environment the adapter was given was changed");
});

test("one token per handoff, each scoped to the task's own repository and the two publish permissions", async () => {
  const minter = fakeMinter();
  const inspector = inspectorAdapter(echoingInspector(), {
    env: { PATH: "/usr/bin:/bin" },
    token: scopedToken(minter, "publish", SCOPE),
  });

  await inspector.inspect({ branch: "fabrica/t", workdir: scriptDir() });
  await inspector.inspect({ branch: "fabrica/t", workdir: scriptDir() });

  // Two handoffs, two mints - never one token cached across rounds: an
  // installation token lives an hour, and a fix round days later must
  // not try to publish with the first pass's.
  assert.equal(minter.calls.length, 2);
  for (const call of minter.calls) {
    assert.equal(call.purpose, "publish");
    assert.equal(call.scope.owner, "acme");
    assert.equal(call.scope.repo, "widgets");
    assert.deepEqual(call.scope.permissions, { contents: "write", pull_requests: "write" });
  }
});

test("prepare() asks nothing of GitHub - the mint happens at the handoff, not before it", () => {
  const minter = fakeMinter();
  const inspector = inspectorAdapter(echoingInspector(), { token: scopedToken(minter, "publish", SCOPE) });

  inspector.prepare?.();

  assert.equal(minter.calls.length, 0, "prepare() minted a token it had no call to spend");
});

test("an unconfigured GitHub App refuses the task before any worker starts, naming the setup", async () => {
  const recordHome = mkdtempSync(join(tmpdir(), "fabrica-gh-app-home-"));
  const minter = fakeMinter({
    refuse: new Error("No GitHub App is configured, and every push ... Set FABRICA_GITHUB_APP_ID and ..."),
  });
  const inspector = inspectorAdapter(echoingInspector(), {
    env: { PATH: "/usr/bin:/bin" },
    token: scopedToken(minter, "publish", SCOPE),
  });
  const brain = fakeBrain();
  const foreman = createForeman({ recordHome, inspector });

  await assert.rejects(
    () => foreman.do("small change", { project: makeFixtureRepo("exit 0"), brain }),
    (err: unknown) => err instanceof ForemanError && /FABRICA_GITHUB_APP_ID/.test(err.message)
  );

  assert.equal(brain.calls, 0, "a worker ran without the credential Inspector needs");
  assert.ok(!readEvents(recordHome).some((e) => e.name === "work-started"), "work started before the refusal");
});

test("an adapter built with no token source at all refuses every handoff rather than publishing anonymously", async () => {
  const inspector = inspectorAdapter(echoingInspector(), { env: { PATH: "/usr/bin:/bin" } });

  assert.throws(() => inspector.prepare?.(), /no GitHub App/);
  const inspection = await inspector.inspect({ branch: "fabrica/t", workdir: scriptDir() });
  assert.equal(inspection.verdict, "refused");
  assert.match(inspection.report, /no GitHub App/);
});

test("a mint GitHub refuses is a refused inspection carrying the cause, not a red one", async () => {
  const inspector = inspectorAdapter(echoingInspector(), {
    env: { PATH: "/usr/bin:/bin" },
    token: scopedToken(
      fakeMinter({ refuseMint: new Error("The GitHub App is not installed on acme/widgets (GitHub answered 404)") }),
      "publish",
      SCOPE
    ),
  });

  const inspection = await inspector.inspect({ branch: "fabrica/t", workdir: scriptDir() });

  assert.equal(inspection.verdict, "refused");
  assert.match(inspection.report, /not installed on acme\/widgets/);
});
