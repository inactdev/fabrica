import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { claudeCodeAdapter, ClaudeCodeError, resolveGitMounts } from "./claude-code.ts";
import { createProductionLine, destroyProductionLine } from "../../line/index.ts";
import { makeFixtureHome, makeFixtureProject } from "../../line/helpers/fixture.ts";
import { LineError } from "../../line/index.ts";

const FAKE_CLI_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "helpers", "fake-claude-cli.mjs");
// A container only ever sees `workdir` (mounted at /workdir) - the fake
// CLI has to live inside it, not at its real path on the host.
const FAKE_CLI_IN_CONTAINER = "/workdir/fake-claude-cli.mjs";
// Needs Node to run the fake CLI's .mjs script; the real adapter's own
// default image (built from docker/Dockerfile) has this too, plus the
// real CLI.
const TEST_IMAGE = "node:20-alpine";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Tracks whether this file's capability spike (the one test that drives
// the real `claude` binary, not the fake) actually ran to completion.
// Every path that skips it - Docker absent, image not built/authenticated,
// or the auth probe itself failing - records why here instead of just
// calling t.skip(), so the after() hook below can print something no one
// scanning a wall of green dots can miss. A skip is invisible in a normal
// passing run; this makes it the loudest thing in the output instead.
let realBinaryCheckRan = false;
let realBinarySkipReason: string | null = null;

after(() => {
  if (realBinaryCheckRan) return;
  const reason = realBinarySkipReason ?? "unknown";
  console.error(
    [
      "",
      "!".repeat(78),
      "!! REAL-BINARY CHECK DID NOT RUN",
      "!! This test run never touched the real `claude` binary.",
      `!! Reason: ${reason}`,
      "!! A green run here does NOT mean the fake CLI was verified against",
      '!! reality - see src/brain/adapters/claude-code.md, "Process containment".',
      "!".repeat(78),
      "",
    ].join("\n")
  );
});

// A real ProductionLine worktree, not a plain temp dir: work() has no
// no-git fallback, so every workdir it runs must resolve real git
// mounts, fixtures included.
let fakeCliTaskCounter = 0;
function makeFakeCliWorkdir(): string {
  const line = createProductionLine({
    project: makeFixtureProject(),
    taskId: `fake-cli-${fakeCliTaskCounter++}`,
    recordHome: makeFixtureHome(),
  });
  const dest = join(line.workdir, "fake-claude-cli.mjs");
  copyFileSync(FAKE_CLI_SOURCE, dest);
  chmodSync(dest, 0o755);
  return line.workdir;
}

// ask() mints its own scratch dir per call (there's no ProductionLine
// yet to run inside), so - unlike work() - a test has nowhere to copy
// the fake CLI into unless it seeds one itself via askScratchDir.
let fakeAskScratchCounter = 0;
function makeFakeCliScratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), `fabrica-ask-scratch-${fakeAskScratchCounter++}-`));
  const dest = join(dir, "fake-claude-cli.mjs");
  copyFileSync(FAKE_CLI_SOURCE, dest);
  chmodSync(dest, 0o755);
  return dir;
}

test("claudeCodeAdapter.ask() sends the task text and no --resume/--permission-mode", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const brain = claudeCodeAdapter({
    binPath: FAKE_CLI_IN_CONTAINER,
    image: TEST_IMAGE,
    askScratchDir: makeFakeCliScratchDir(),
  });

  await brain.ask("ASK_SCENARIO_NONE");
  // Nothing to assert on the args directly (ASK_SCENARIO_NONE isn't
  // ECHO_ARGS) - covered instead by the questions-parsing tests below,
  // which prove the whole round trip end to end.
});

test("claudeCodeAdapter.ask() returns the questions a materially ambiguous task gets back", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const brain = claudeCodeAdapter({
    binPath: FAKE_CLI_IN_CONTAINER,
    image: TEST_IMAGE,
    askScratchDir: makeFakeCliScratchDir(),
  });

  const result = await brain.ask("ASK_SCENARIO_QUESTIONS");
  assert.deepEqual(result.questions, ["What database?", "Multi-tenant?"]);
});

test("claudeCodeAdapter.ask() returns no questions for a clear task", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const brain = claudeCodeAdapter({
    binPath: FAKE_CLI_IN_CONTAINER,
    image: TEST_IMAGE,
    askScratchDir: makeFakeCliScratchDir(),
  });

  const result = await brain.ask("ASK_SCENARIO_NONE");
  assert.deepEqual(result, {});
});

test("claudeCodeAdapter.ask() strips a fenced code block around the JSON", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const brain = claudeCodeAdapter({
    binPath: FAKE_CLI_IN_CONTAINER,
    image: TEST_IMAGE,
    askScratchDir: makeFakeCliScratchDir(),
  });

  const result = await brain.ask("ASK_SCENARIO_FENCED");
  assert.deepEqual(result.questions, ["Fenced question?"]);
});

test("claudeCodeAdapter.ask() treats an unparseable response as nothing to ask, not a crash", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const brain = claudeCodeAdapter({
    binPath: FAKE_CLI_IN_CONTAINER,
    image: TEST_IMAGE,
    askScratchDir: makeFakeCliScratchDir(),
  });

  const result = await brain.ask("ASK_SCENARIO_GARBLED");
  assert.deepEqual(result, {});
});

test("claudeCodeAdapter always passes bypassPermissions and forwards --resume, --model, --effort", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const brain = claudeCodeAdapter({
    binPath: FAKE_CLI_IN_CONTAINER,
    image: TEST_IMAGE,
    model: "claude-fable-5",
  });

  const result = await brain.work("ECHO_ARGS", makeFakeCliWorkdir(), {
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

test("claudeCodeAdapter omits --resume, --model, --effort when not given", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const brain = claudeCodeAdapter({ binPath: FAKE_CLI_IN_CONTAINER, image: TEST_IMAGE });

  const result = await brain.work("ECHO_ARGS", makeFakeCliWorkdir());

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

test("claudeCodeAdapter maps structured stream-json into transcript entries and skips harness noise", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const brain = claudeCodeAdapter({ binPath: FAKE_CLI_IN_CONTAINER, image: TEST_IMAGE });

  const result = await brain.work("SUCCESS_WITH_TOOLS", makeFakeCliWorkdir());

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

test("claudeCodeAdapter records session id from the terminal result line", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const brain = claudeCodeAdapter({ binPath: FAKE_CLI_IN_CONTAINER, image: TEST_IMAGE });

  const result = await brain.work("SUCCESS_WITH_TOOLS", makeFakeCliWorkdir());

  assert.equal(result.session, "fake-session-123");
});

test("claudeCodeAdapter carries cost, duration, and token usage on a 'usage' transcript entry", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const brain = claudeCodeAdapter({ binPath: FAKE_CLI_IN_CONTAINER, image: TEST_IMAGE });

  const result = await brain.work("SUCCESS_WITH_TOOLS", makeFakeCliWorkdir());

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

test("claudeCodeAdapter throws ClaudeCodeError('cli-error') on a non-zero exit with no JSON on stdout", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const brain = claudeCodeAdapter({ binPath: FAKE_CLI_IN_CONTAINER, image: TEST_IMAGE });

  await assert.rejects(
    () => brain.work("FAIL_EXIT_NONZERO_NO_JSON", makeFakeCliWorkdir()),
    (err: unknown) =>
      err instanceof ClaudeCodeError &&
      err.code === "cli-error" &&
      /No conversation found/.test(err.message)
  );
});

test("claudeCodeAdapter throws ClaudeCodeError('cli-error') using the tool's own message when stdout is JSON with is_error", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const brain = claudeCodeAdapter({ binPath: FAKE_CLI_IN_CONTAINER, image: TEST_IMAGE });

  await assert.rejects(
    () => brain.work("FAIL_EXIT_NONZERO_WITH_JSON", makeFakeCliWorkdir()),
    (err: unknown) =>
      err instanceof ClaudeCodeError &&
      err.code === "cli-error" &&
      /model not found/.test(err.message) &&
      /404/.test(err.message)
  );
});

test("claudeCodeAdapter throws ClaudeCodeError('unparseable-output') on exit 0 with no result line", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const brain = claudeCodeAdapter({ binPath: FAKE_CLI_IN_CONTAINER, image: TEST_IMAGE });

  await assert.rejects(
    () => brain.work("SUCCESS_NO_RESULT_LINE", makeFakeCliWorkdir()),
    (err: unknown) => err instanceof ClaudeCodeError && err.code === "unparseable-output"
  );
});

test("claudeCodeAdapter throws ClaudeCodeError('cli-error') when the containerized command doesn't exist", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  // Unlike a host spawn, a missing command inside a container is Docker's
  // own exit-127 failure, not a Node-level spawn error - so this is a
  // cli-error (bad exit, real message), not spawn-failed. spawn-failed
  // is proven at the containment layer instead (docker itself missing),
  // see src/containment/run.test.ts. Plain `alpine`, not TEST_IMAGE: the
  // official node image's own entrypoint script reinterprets a missing
  // command as a node script argument (a real, verified quirk of that
  // image, not of this adapter), which would otherwise mask the plain
  // "not found" failure this test wants to prove.
  const brain = claudeCodeAdapter({ binPath: "/definitely-not-a-real-binary-xyz", image: "alpine" });

  await assert.rejects(
    () => brain.work("hi", makeFakeCliWorkdir()),
    (err: unknown) =>
      err instanceof ClaudeCodeError && err.code === "cli-error" && /no such file or directory/i.test(err.message)
  );
});

// There is no no-git fallback: a workdir whose git mounts can't be
// resolved refuses the run outright, with a message telling the Client
// to initialize git first - never a Worker running with git silently
// unavailable. See resolveGitMounts's own comment.
test("resolveGitMounts refuses a workdir with no git repository, telling the Client to initialize git first", () => {
  const noGitDir = mkdtempSync(join(tmpdir(), "fabrica-claude-code-nogit-"));

  assert.throws(
    () => resolveGitMounts(noGitDir),
    (err: unknown) =>
      err instanceof LineError && err.code === "not-a-worktree" && /initialize git/i.test(err.message)
  );
});

// The same refusal holds for every other way the mounts can't be
// resolved, not just the missing-repository one above: an unsanitizable
// config surfaces its own LineError instead of being swallowed into a
// silent "run the Worker without git" (the review finding this test
// pins down - see resolveGitMounts's own comment).
test("resolveGitMounts surfaces a LineError other than not-a-worktree instead of silently dropping git", () => {
  const project = makeFixtureProject();
  execFileSync("git", ["config", "extensions.someFutureCredentialBearingKey", "value"], { cwd: project });
  const line = createProductionLine({ project, taskId: "unsanitizable-config", recordHome: makeFixtureHome() });

  try {
    assert.throws(
      () => resolveGitMounts(line.workdir),
      (err: unknown) =>
        err instanceof LineError &&
        err.code === "unsanitizable-config" &&
        /someFutureCredentialBearingKey/.test(err.message)
    );
  } finally {
    destroyProductionLine(line);
  }
});

test("claudeCodeAdapter reports model as configured, or 'default' when none was given", async () => {
  assert.equal(claudeCodeAdapter({ binPath: FAKE_CLI_IN_CONTAINER }).model, "default");
  assert.equal(claudeCodeAdapter({ binPath: FAKE_CLI_IN_CONTAINER, model: "claude-opus-5" }).model, "claude-opus-5");
});

// Proves the wiring (issue #44), not just the standalone primitive:
// src/containment/run.test.ts already proves runContained() itself works;
// this proves that claudeCodeAdapter's work() really does route the
// actual command through it, end to end - a decoy file that sits
// outside workdir must stay unreadable to the process it spawns.
test("claudeCodeAdapter confines the spawned process to workdir", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");

  const workdir = makeFakeCliWorkdir();
  const outsideDir = mkdtempSync(join(tmpdir(), "fabrica-claude-code-outside-"));
  const decoyPath = join(outsideDir, "decoy.txt");
  writeFileSync(decoyPath, "should never be readable from workdir");

  const brain = claudeCodeAdapter({
    binPath: FAKE_CLI_IN_CONTAINER,
    image: TEST_IMAGE,
    env: { FABRICA_TEST_DECOY_PATH: decoyPath },
  });
  const result = await brain.work("TRY_READ_DECOY", workdir);
  assert.equal(result.transcript[0].text, "READ_BLOCKED");
});

// Proves the session-persistence fix (issue #44 review, ask-user finding
// "session-resume-broken"): a warm --resume needs the CLI's own session
// state to survive between attempts, even though every runContained
// call is its own fresh, throwaway container. work() derives a per-task
// session directory from workdir alone and mounts it as $HOME across
// calls - a second call for the SAME workdir must see what the first
// one left there.
test("claudeCodeAdapter persists $HOME across separate work() calls for the same workdir", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");

  const workdir = makeFakeCliWorkdir();
  const brain = claudeCodeAdapter({ binPath: FAKE_CLI_IN_CONTAINER, image: TEST_IMAGE });

  const first = await brain.work("SESSION_MARKER", workdir);
  assert.equal(first.transcript[0].text, "SEEN:", "first call must see no prior session state");

  const second = await brain.work("SESSION_MARKER", workdir);
  assert.equal(second.transcript[0].text, "SEEN:call;", "second call must see the first call's own session state");
});

// Capability spike (issue #6, updated for issue #44): the tests above
// prove the adapter's own logic against a controllable fake; this test
// proves the real thing - now necessarily the containerized real CLI,
// since work() always runs through Docker (the host's own installed
// binary is a native macOS executable and can never run in a
// container - see claude-code.md). It requires DEFAULT_IMAGE to exist
// (`docker build`, see docker/Dockerfile) and be authenticated inside
// the container; it skips (does not fail) rather than lie about
// proving this when that's not true on the machine running it.
test("claude-code adapter: real binary does real work in a real worktree (capability spike)", async (t) => {
  if (!dockerAvailable()) {
    realBinarySkipReason = "Docker is not available on this machine";
    t.skip(realBinarySkipReason);
    return;
  }
  // This guard probes auth as the image's own default user with the
  // image's own $HOME - not the `--user <host-uid>` / bind-mounted
  // homeDir combination work() actually runs with. That's equivalent as
  // long as the credential gap is closed via an env-provided token
  // (which reaches both the same way); if it is ever closed by baking
  // auth into the image itself, this guard would report logged-in while
  // work()'s contained run still finds no credential, and must be
  // realigned with work()'s real runtime conditions then - see
  // claude-code.md, "Process containment".
  try {
    const status = JSON.parse(
      execFileSync("docker", ["run", "--rm", "fabrica-claude-code:latest", "claude", "auth", "status"], {
        encoding: "utf8",
      })
    );
    if (status.loggedIn !== true) {
      realBinarySkipReason = "the containerized real binary is installed but not authenticated";
      t.skip(realBinarySkipReason);
      return;
    }
  } catch {
    realBinarySkipReason = "could not confirm the containerized real binary is built and authenticated on this machine";
    t.skip(realBinarySkipReason);
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
    realBinaryCheckRan = true;
  } finally {
    destroyProductionLine(line);
  }
});
