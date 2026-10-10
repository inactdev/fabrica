// `fabrica doctor`'s Inspector-side checks: a GitHub token Inspector can
// use, and an installed Inspector that takes -branch.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubTokenStatus, inspectorBranchStatus } from "./doctor-checks.ts";

function pathWith(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fabrica-doctor-insp-"));
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
  return `${dir}:/usr/bin:/bin`;
}

test("GitHub token: GITHUB_TOKEN set is OK, never showing it", () => {
  const status = githubTokenStatus({ PATH: "/usr/bin:/bin", GITHUB_TOKEN: "fake-gh-1" });
  assert.equal(status.ok, true);
  assert.match(status.detail, /GITHUB_TOKEN/);
  assert.ok(!JSON.stringify(status).includes("fake-gh-1"));
});

test("GitHub token: unset but gh auth token works is OK, never showing it", () => {
  const status = githubTokenStatus({ PATH: pathWith("gh", "echo fake-gh-2") });
  assert.equal(status.ok, true);
  assert.match(status.detail, /gh auth token/);
  assert.ok(!JSON.stringify(status).includes("fake-gh-2"));
});

test("GitHub token: unset and gh missing or logged out fails, with gh auth login as the fix", () => {
  for (const PATH of ["/usr/bin:/bin", pathWith("gh", "exit 1")]) {
    const status = githubTokenStatus({ PATH });
    assert.equal(status.ok, false);
    assert.match(status.fix ?? "", /gh auth login/);
  }
});

test("Inspector: on PATH and -h shows -branch is OK", () => {
  const status = inspectorBranchStatus({ PATH: pathWith("inspector", "echo '  -branch string'; exit 0") });
  assert.equal(status.ok, true);
});

test("Inspector: on PATH but -h has no -branch fails - Fabrica's call would be refused", () => {
  const status = inspectorBranchStatus({ PATH: pathWith("inspector", "echo '  -repo string'; exit 0") });
  assert.equal(status.ok, false);
  assert.match(status.detail, /-branch/);
});

test("Inspector: not on PATH fails, saying tasks will be self-tested", () => {
  const status = inspectorBranchStatus({ PATH: "/usr/bin:/bin" });
  assert.equal(status.ok, false);
  assert.match(status.detail, /not on PATH/);
  assert.match(status.detail, /self-tested/);
});
