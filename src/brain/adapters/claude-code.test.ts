import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { claudeCodeAdapter, ClaudeCodeError } from "./claude-code.ts";
import { createProductionLine, destroyProductionLine } from "../../line/index.ts";
import { makeFixtureHome, makeFixtureProject } from "../../line/helpers/fixture.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "helpers", "fake-claude-cli.mjs");

test("claudeCodeAdapter always passes bypassPermissions and forwards --resume, --model, --effort", async () => {
  const brain = claudeCodeAdapter({ binPath: FAKE_CLI, model: "claude-fable-5" });

  const result = await brain.work("ECHO_ARGS", process.cwd(), {
    session: "prior-session-id",
    reasoningEffort: "high",
  });

  const argsSeen = JSON.parse(result.transcript[0].text);
  assert.deepEqual(argsSeen, [
    "-p",
    "ECHO_ARGS",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
    "--resume",
    "prior-session-id",
    "--model",
    "claude-fable-5",
    "--effort",
    "high",
  ]);
});

test("claudeCodeAdapter omits --resume, --model, --effort when not given", async () => {
  const brain = claudeCodeAdapter({ binPath: FAKE_CLI });

  const result = await brain.work("ECHO_ARGS", process.cwd());

  const argsSeen = JSON.parse(result.transcript[0].text);
  assert.deepEqual(argsSeen, [
    "-p",
    "ECHO_ARGS",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
  ]);
});

test("claudeCodeAdapter maps structured stream-json into transcript entries and skips harness noise", async () => {
  const brain = claudeCodeAdapter({ binPath: FAKE_CLI });

  const result = await brain.work("SUCCESS_WITH_TOOLS", process.cwd());

  assert.deepEqual(
    result.transcript.map((e) => e.kind),
    ["reasoning", "tool-call", "tool-result", "text", "usage"]
  );
  assert.match(result.transcript[1].text, /^Bash\(/);
  assert.equal(result.transcript[2].text, "hello from spike");
  assert.equal(result.transcript[3].text, "Done.");
  // "system" (init) never became a transcript entry.
  assert.ok(!result.transcript.some((e) => e.text.includes("init")));
});

test("claudeCodeAdapter records session id from the terminal result line", async () => {
  const brain = claudeCodeAdapter({ binPath: FAKE_CLI });

  const result = await brain.work("SUCCESS_WITH_TOOLS", process.cwd());

  assert.equal(result.session, "fake-session-123");
});

test("claudeCodeAdapter carries cost, duration, and token usage on a 'usage' transcript entry", async () => {
  const brain = claudeCodeAdapter({ binPath: FAKE_CLI });

  const result = await brain.work("SUCCESS_WITH_TOOLS", process.cwd());

  const usageEntry = result.transcript.at(-1)!;
  assert.equal(usageEntry.kind, "usage");
  const payload = JSON.parse(usageEntry.text);
  assert.equal(payload.totalCostUsd, 0.0421);
  assert.equal(payload.durationMs, 1234);
  assert.deepEqual(payload.usage, {
    input_tokens: 10,
    output_tokens: 20,
    cache_read_input_tokens: 5,
    cache_creation_input_tokens: 1,
  });
});

test("claudeCodeAdapter throws ClaudeCodeError('cli-error') on a non-zero exit with no JSON on stdout", async () => {
  const brain = claudeCodeAdapter({ binPath: FAKE_CLI });

  await assert.rejects(
    () => brain.work("FAIL_EXIT_NONZERO_NO_JSON", process.cwd()),
    (err: unknown) =>
      err instanceof ClaudeCodeError &&
      err.code === "cli-error" &&
      /No conversation found/.test(err.message)
  );
});

test("claudeCodeAdapter throws ClaudeCodeError('cli-error') using the tool's own message when stdout is JSON with is_error", async () => {
  const brain = claudeCodeAdapter({ binPath: FAKE_CLI });

  await assert.rejects(
    () => brain.work("FAIL_EXIT_NONZERO_WITH_JSON", process.cwd()),
    (err: unknown) =>
      err instanceof ClaudeCodeError &&
      err.code === "cli-error" &&
      /model not found/.test(err.message) &&
      /404/.test(err.message)
  );
});

test("claudeCodeAdapter throws ClaudeCodeError('unparseable-output') on exit 0 with no result line", async () => {
  const brain = claudeCodeAdapter({ binPath: FAKE_CLI });

  await assert.rejects(
    () => brain.work("SUCCESS_NO_RESULT_LINE", process.cwd()),
    (err: unknown) => err instanceof ClaudeCodeError && err.code === "unparseable-output"
  );
});

test("claudeCodeAdapter throws ClaudeCodeError('spawn-failed') when the binary can't be run", async () => {
  const brain = claudeCodeAdapter({ binPath: join(tmpdir(), "definitely-not-a-real-binary-xyz") });

  await assert.rejects(
    () => brain.work("hi", process.cwd()),
    (err: unknown) => err instanceof ClaudeCodeError && err.code === "spawn-failed"
  );
});

test("claudeCodeAdapter reports model as configured, or 'default' when none was given", async () => {
  assert.equal(claudeCodeAdapter({ binPath: FAKE_CLI }).model, "default");
  assert.equal(claudeCodeAdapter({ binPath: FAKE_CLI, model: "claude-opus-5" }).model, "claude-opus-5");
});

function sandboxAvailable(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    execFileSync("sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Proves the wiring (issue #44), not just the standalone primitive:
// src/containment/run.test.ts already proves runContained() itself works;
// this proves that passing `contained: true` to the actual adapter really
// does route the actual binary through it, end to end - a decoy file
// that sits outside workdir but under the adapter's own homeDir must stay
// unreadable to the process claudeCodeAdapter spawns.
test("claudeCodeAdapter({ contained: true }) confines the spawned process to workdir", async (t) => {
  if (!sandboxAvailable()) return t.skip("sandbox-exec is not available on this machine");

  const homeDir = mkdtempSync(join(tmpdir(), "fabrica-claude-code-home-"));
  const workdir = join(homeDir, "tasks", "t1", "worktree");
  mkdirSync(workdir, { recursive: true });
  const decoyPath = join(homeDir, "decoy.txt");
  writeFileSync(decoyPath, "should never be readable from workdir");

  const brain = claudeCodeAdapter({
    binPath: FAKE_CLI,
    contained: true,
    homeDir,
    env: { FABRICA_TEST_DECOY_PATH: decoyPath },
  });
  const result = await brain.work("TRY_READ_DECOY", workdir);
  assert.equal(result.transcript[0].text, "READ_BLOCKED");
});

// Capability spike (issue #6): the tests above prove the adapter's own
// logic against a controllable fake; this test proves the real thing.
// It drives the actual installed `claude` binary against a real
// ProductionLine worktree and asserts the file it was asked to create
// really exists - not a simulated result. It requires the real binary
// to be installed and authenticated; it skips (does not fail) rather
// than lie about proving this when that's not true on the machine
// running it.
test("claude-code adapter: real binary does real work in a real worktree (capability spike)", async (t) => {
  try {
    execFileSync("claude", ["--version"], { stdio: "ignore" });
  } catch {
    t.skip("the real `claude` binary is not installed on this machine");
    return;
  }
  try {
    const status = JSON.parse(execFileSync("claude", ["auth", "status"], { encoding: "utf8" }));
    if (status.loggedIn !== true) {
      t.skip("the real `claude` binary is installed but not authenticated on this machine");
      return;
    }
  } catch {
    t.skip("could not confirm the real `claude` binary is authenticated on this machine");
    return;
  }

  const project = makeFixtureProject();
  const recordHome = makeFixtureHome();
  const line = createProductionLine({ project, taskId: "spike-adapter-6", recordHome });

  try {
    const brain = claudeCodeAdapter();
    const result = await brain.work(
      "Create a file named spike-proof.txt in the current directory containing exactly the text: adapter spike proof",
      line.workdir
    );

    assert.ok(result.session, "real binary did not report a session id");
    assert.ok(result.transcript.length > 0, "real binary produced no transcript entries");
    const usageEntry = result.transcript.find((e) => e.kind === "usage");
    assert.ok(usageEntry, "real binary's cost/usage data did not reach the transcript");

    const proofPath = join(line.workdir, "spike-proof.txt");
    assert.ok(existsSync(proofPath), "the real binary did not actually create the requested file");

    // Warm session: resuming must continue the SAME session id, not start
    // a new one (verified live against the real binary - see README).
    const resumed = await brain.work(
      "Also create second-proof.txt containing exactly: warm session proof",
      line.workdir,
      { session: result.session }
    );
    assert.equal(resumed.session, result.session, "resuming did not keep the same session id");
    assert.ok(
      existsSync(join(line.workdir, "second-proof.txt")),
      "the resumed session did not actually do the follow-up work"
    );
  } finally {
    destroyProductionLine(line);
  }
});
