// `fabrica doctor`'s adapter-side checks: the worker image and the worker
// token. They live beside the adapter because only this directory may
// name it (CONTRACT rule 8). Every token here is a fake value.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dockerfileSha256,
  pinnedCliVersion,
  probeWorkerToken,
  workerCliVersionStatus,
  workerImageStatus,
  workerTokenStatus,
} from "./doctor-checks.ts";

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

// Issue #130: the build command opens with its own `cd`, so it runs from
// wherever the Client is standing - every state that prints it says so,
// with the command itself still the tail of the line (nothing follows it
// that would break a copy-paste).
test("worker image: every failing state's fix says the command runs from any folder", () => {
  const stamps: (() => string | null)[] = [() => null, () => "", () => "0".repeat(64)];
  for (const stamp of stamps) {
    const status = workerImageStatus(stamp);
    assert.equal(status.ok, false);
    assert.match(status.fix ?? "", /^run from any folder: cd \S+ && docker build .* \.$/);
  }
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

// Issue #200: with the direct-API worker selected, doctor checks that
// worker, not the one the Client is not using - and the live probe
// confirms the one fact its receipts depend on.

const DIRECT = { FABRICA_BRAIN: "openai-compatible", FABRICA_MODEL: "some/open-weight-model" };
const neverCalled = async () => {
  throw new Error("the live probe must not be called here");
};

test("with the direct-API worker selected, the check names its model and endpoint, not a CLI token", () => {
  const status = workerTokenStatus({ ...DIRECT, OPENROUTER_API_KEY: "fake-secret-6" }, home());
  assert.equal(status.ok, true);
  assert.match(status.detail, /some\/open-weight-model/);
  assert.match(status.detail, /openrouter\.ai/);
  assert.doesNotMatch(status.detail, /CLAUDE_CODE_OAUTH_TOKEN/);
  assert.ok(!JSON.stringify(status).includes("fake-secret-6"));
});

test("no credential is fine for a local server, and is said so rather than passed off as configured", () => {
  const status = workerTokenStatus({ ...DIRECT, FABRICA_MODEL_BASE_URL: "http://127.0.0.1:11434/v1" }, home());
  assert.equal(status.ok, true);
  assert.match(status.detail, /no credential configured/);
  assert.match(status.detail, /127\.0\.0\.1:11434/);
});

test("the direct-API worker with no model named fails the check, naming the setting to add", () => {
  const dir = home();
  const status = workerTokenStatus({ FABRICA_BRAIN: "openai-compatible" }, dir);
  assert.equal(status.ok, false);
  assert.match(status.fix ?? "", /FABRICA_MODEL/);
  assert.ok((status.fix ?? "").includes(join(dir, "brain.env")));
});

test("live probe: a real call that reports its cost is alive, and one that reports none is a failure", async () => {
  const dir = home();
  const alive = await probeWorkerToken({ ...DIRECT, OPENROUTER_API_KEY: "fake-secret-7" }, dir, neverCalled, async (target) => {
    assert.equal(target.model, "some/open-weight-model");
    assert.equal(target.apiKey, "fake-secret-7");
    assert.equal(target.endpoint, "https://openrouter.ai/api/v1");
    return { choices: [{ message: { content: "OK" } }], usage: { cost: 0.000012 } };
  });
  assert.equal(alive.ok, true);
  assert.match(alive.detail, /alive/);
  assert.ok(!JSON.stringify(alive).includes("fake-secret-7"));

  const unmeasured = await probeWorkerToken(DIRECT, dir, neverCalled, async () => ({
    choices: [{ message: { content: "OK" } }],
    usage: { prompt_tokens: 3 },
  }));
  assert.equal(unmeasured.ok, false, "a target that reports no cost would make every receipt unmeasured");
  assert.match(unmeasured.fix ?? "", /FABRICA_MODEL_COST=free/);

  // Unless the Client has said that target genuinely bills nothing.
  const free = await probeWorkerToken({ ...DIRECT, FABRICA_MODEL_COST: "free" }, dir, neverCalled, async () => ({
    choices: [{ message: { content: "OK" } }],
  }));
  assert.equal(free.ok, true);
  assert.match(free.detail, /bills nothing/);
});

test("live probe: a refused call is dead, with what to check", async () => {
  const status = await probeWorkerToken(DIRECT, home(), neverCalled, async () => {
    throw new Error("the model API answered 401: No auth credentials found");
  });
  assert.equal(status.ok, false);
  assert.match(status.detail, /dead - .*401/);
  assert.match(status.fix ?? "", /FABRICA_MODEL/);
});

test("worker CLI: the version installed in the image matching the Dockerfile's pin is current", () => {
  const status = workerCliVersionStatus(
    () => "2.1.222",
    () => "2.1.222"
  );
  assert.equal(status.ok, true);
  assert.match(status.detail, /2\.1\.222/);
});

test("worker CLI: an installed version that differs from the pin fails, with the rebuild command", () => {
  const status = workerCliVersionStatus(
    () => "2.0.0",
    () => "2.1.222"
  );
  assert.equal(status.ok, false);
  assert.match(status.detail, /2\.0\.0/);
  assert.match(status.detail, /2\.1\.222/);
  assert.match(status.fix ?? "", /docker build/);
  // The same command as the worker-image fix, so it carries the same
  // "runs from any folder" note (issue #130).
  assert.match(status.fix ?? "", /^run from any folder: cd /);
});

test("worker CLI: with no pin to differ from, the installed version is information, never a failure", () => {
  const status = workerCliVersionStatus(
    () => "2.1.222",
    () => null
  );
  assert.equal(status.ok, true);
  assert.match(status.detail, /pins no version/);
});

test("worker CLI: an image that cannot be asked is reported, but the worker image line owns that failure", () => {
  const unreadable = workerCliVersionStatus(
    () => null,
    () => "2.1.222"
  );
  assert.equal(unreadable.ok, true, "doctor must not report the same missing image as two separate failures");
  assert.match(unreadable.detail, /could not be read/);
  assert.match(unreadable.detail, /2\.1\.222/);
});

test("worker CLI: the pin is read from the Dockerfile's own install line", () => {
  assert.equal(pinnedCliVersion(() => "RUN npm install -g @anthropic-ai/claude-code@9.9.9\n"), "9.9.9");
  assert.equal(pinnedCliVersion(() => "RUN npm install -g @anthropic-ai/claude-code@latest\n"), null);
  assert.equal(pinnedCliVersion(() => "RUN apk add --no-cache git bash\n"), null);
  // The real Dockerfile pins one today; if that ever stops being true,
  // this check becomes information-only rather than silently wrong.
  const real = pinnedCliVersion();
  assert.ok(real === null || /^\d+\.\d+\.\d+/.test(real), `unexpected pinned version: ${real}`);
});
