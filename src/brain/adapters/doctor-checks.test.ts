// `fabrica doctor`'s adapter-side checks: the worker image and the worker
// token. They live beside the adapter because only this directory may
// name it (CONTRACT rule 8). Every token here is a fake value.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerfileSha256, probeWorkerToken, workerImageStatus, workerTokenStatus } from "./doctor-checks.ts";

test("worker image: absent is not present, and the fix is the exact build command, stamped with the Dockerfile's hash", () => {
  const status = workerImageStatus(() => null);
  assert.equal(status.ok, false);
  assert.match(status.fix ?? "", new RegExp(`--build-arg DOCKERFILE_SHA256=${dockerfileSha256()}`));
  assert.match(status.fix ?? "", /docker build .*-f src\/brain\/adapters\/docker\/Dockerfile \./);
});

test("worker image: a stamp that differs from the Dockerfile's hash is stale, with the build command", () => {
  const status = workerImageStatus(() => "0".repeat(64));
  assert.equal(status.ok, false);
  assert.match(status.detail, /out of date/);
  assert.match(status.fix ?? "", new RegExp(dockerfileSha256()));
});

test("worker image: an unstamped image (built without the hash) is reported as unknown, not current", () => {
  const status = workerImageStatus(() => "");
  assert.equal(status.ok, false);
  assert.match(status.fix ?? "", /docker build/);
});

test("worker image: a stamp matching the Dockerfile's hash is current", () => {
  const status = workerImageStatus(() => dockerfileSha256());
  assert.equal(status.ok, true);
});

function home(brainEnv?: { content: string; mode: number }): string {
  const dir = mkdtempSync(join(tmpdir(), "fabrica-doctor-token-"));
  if (brainEnv) {
    writeFileSync(join(dir, "brain.env"), brainEnv.content);
    chmodSync(join(dir, "brain.env"), brainEnv.mode);
  }
  return dir;
}

test("worker token: found in the environment, the source is named and the token never is", () => {
  const status = workerTokenStatus({ CLAUDE_CODE_OAUTH_TOKEN: "fake-secret-1" }, home());
  assert.equal(status.ok, true);
  assert.match(status.detail, /environment/);
  assert.ok(!JSON.stringify(status).includes("fake-secret-1"));
});

test("worker token: found in brain.env at mode 600, the file is named and the token never is", () => {
  const dir = home({ content: "CLAUDE_CODE_OAUTH_TOKEN=fake-secret-2\n", mode: 0o600 });
  const status = workerTokenStatus({}, dir);
  assert.equal(status.ok, true);
  assert.ok(status.detail.includes(join(dir, "brain.env")));
  assert.ok(!JSON.stringify(status).includes("fake-secret-2"));
});

test("worker token: brain.env readable by others fails, with chmod 600 as the fix", () => {
  const dir = home({ content: "CLAUDE_CODE_OAUTH_TOKEN=fake-secret-3\n", mode: 0o644 });
  const status = workerTokenStatus({}, dir);
  assert.equal(status.ok, false);
  assert.ok((status.fix ?? "").includes(`chmod 600 ${join(dir, "brain.env")}`));
  assert.ok(!JSON.stringify(status).includes("fake-secret-3"));
});

test("worker token: no source at all fails, naming claude setup-token", () => {
  const status = workerTokenStatus({}, home());
  assert.equal(status.ok, false);
  assert.match(status.fix ?? "", /claude setup-token/);
});

test("live probe: a successful minimal call is alive; an authentication error is dead; neither shows the token", async () => {
  const dir = home({ content: "CLAUDE_CODE_OAUTH_TOKEN=fake-secret-4\n", mode: 0o600 });
  const alive = await probeWorkerToken({}, dir, async () => ({
    exitCode: 0,
    stdout: JSON.stringify({ type: "result", is_error: false, result: "OK", total_cost_usd: 0.001 }),
    stderr: "",
  }));
  assert.equal(alive.ok, true);
  assert.match(alive.detail, /alive/);

  const dead = await probeWorkerToken({}, dir, async () => ({
    exitCode: 1,
    stdout: JSON.stringify({ type: "result", is_error: true, result: "Invalid API key · Please run /login" }),
    stderr: "",
  }));
  assert.equal(dead.ok, false);
  assert.match(dead.detail, /dead/);
  assert.match(dead.fix ?? "", /claude setup-token/);
  for (const s of [alive, dead]) assert.ok(!JSON.stringify(s).includes("fake-secret-4"));
});

test("live probe: running out of the tiny budget still proves the token authenticated", async () => {
  const dir = home({ content: "CLAUDE_CODE_OAUTH_TOKEN=fake-secret-5\n", mode: 0o600 });
  const status = await probeWorkerToken({}, dir, async () => ({
    exitCode: 1,
    stdout: JSON.stringify({ type: "result", is_error: true, subtype: "error_max_budget_usd", total_cost_usd: 0.02 }),
    stderr: "",
  }));
  assert.equal(status.ok, true);
});
