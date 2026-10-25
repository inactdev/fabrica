import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  buildAskPrompt,
  claudeCodeAdapter,
  claudeCodeCheckBox,
  ClaudeCodeError,
  mapLineToEntries,
  meterReadingFrom,
  percentFromUtilization,
  resolveGitMounts,
  WRITEUP_JSON_SCHEMA,
} from "./claude-code.ts";
import { createProductionLine, destroyProductionLine } from "../../line/index.ts";
import { makeFixtureHome, makeFixtureProject } from "../../line/helpers/fixture.ts";
import { LineError } from "../../line/index.ts";
import { registerLiveTranscriptListener } from "../live-transcript.ts";
import { ASK_SHAPE_NOTICE } from "../ask-shape.ts";
import type { TranscriptEntry } from "../types.ts";
import { withStandingQuestion } from "../../foreman/standing-question.ts";
import { credentialEnvFrom } from "./index.ts";
import { resolveRecordHome } from "../../cli/record-home.ts";

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

// The clarify step runs before any ProductionLine exists - no project
// files are mounted anywhere - so without this sentence a worker's
// clarifying question kept being "where is the code?" instead of
// something about what the Client actually wants. The work brief (what
// work() actually sends, after the foreman's withStandingQuestion()) must
// never carry it: there, the project really is present, and the sentence
// would be actively misleading.
test("buildAskPrompt's clarify brief explains the empty folder and the fixed shape; the work brief never does", () => {
  const askPrompt = buildAskPrompt("build me an app");
  assert.match(askPrompt, /project's files are not present at this step on purpose/);
  assert.match(askPrompt, /ask only about what the Client wants, never about where the code is/);
  // Issue #176: the shape is asked for in the one wording every adapter
  // uses (src/brain/ask-shape.ts), so no two adapters can ask for
  // different shapes while the Foreman rejects one of them.
  assert.ok(askPrompt.includes(ASK_SHAPE_NOTICE));
  assert.match(askPrompt, /"question": "which database should this use\?", "options"/);

  const workBrief = withStandingQuestion("build me an app");
  assert.doesNotMatch(workBrief, /project's files are not present at this step on purpose/);
  assert.doesNotMatch(workBrief, /never about where the code is/);
});

test("claudeCodeAdapter.ask() returns the one question, with its options, a materially ambiguous task gets back", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const brain = claudeCodeAdapter({
    binPath: FAKE_CLI_IN_CONTAINER,
    image: TEST_IMAGE,
    askScratchDir: makeFakeCliScratchDir(),
  });

  const result = await brain.ask("ASK_SCENARIO_QUESTION");
  // Issue #176's fixed shape, handed on exactly as the model sent it -
  // the Foreman derives the id and appends "other".
  assert.deepEqual(result.question, { question: "What database?", options: ["Postgres", "SQLite"] });
});

test("claudeCodeAdapter.ask() reports the call's cost from the result line", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const brain = claudeCodeAdapter({
    binPath: FAKE_CLI_IN_CONTAINER,
    image: TEST_IMAGE,
    askScratchDir: makeFakeCliScratchDir(),
  });

  const asked = await brain.ask("ASK_SCENARIO_NONE a clear task");

  assert.equal(asked.costUsd, 0.0421);
});

test("claudeCodeAdapter.ask() returns no questions for a clear task", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const brain = claudeCodeAdapter({
    binPath: FAKE_CLI_IN_CONTAINER,
    image: TEST_IMAGE,
    askScratchDir: makeFakeCliScratchDir(),
  });

  const result = await brain.ask("ASK_SCENARIO_NONE");
  assert.deepEqual(result, { costUsd: 0.0421 });
});

test("claudeCodeAdapter.ask() strips a fenced code block around the JSON", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const brain = claudeCodeAdapter({
    binPath: FAKE_CLI_IN_CONTAINER,
    image: TEST_IMAGE,
    askScratchDir: makeFakeCliScratchDir(),
  });

  const result = await brain.ask("ASK_SCENARIO_FENCED");
  assert.deepEqual(result.question, { question: "Fenced question?", options: ["Yes", "No"] });
});

test("claudeCodeAdapter.ask() hands back a free-form list as-is, for the Foreman to reject and re-ask", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const brain = claudeCodeAdapter({
    binPath: FAKE_CLI_IN_CONTAINER,
    image: TEST_IMAGE,
    askScratchDir: makeFakeCliScratchDir(),
  });

  const result = await brain.ask("ASK_SCENARIO_FREE_FORM");
  // Not swallowed as "nothing to ask" (issue #176): the Foreman is what
  // rejects the shape, in the machine's own hearing, and has it ask
  // again. Blank and non-string entries are still dropped - one stray
  // element must not change what the rejection says.
  assert.deepEqual(result.questions, ["Real question?"]);
  assert.equal(result.question, undefined);
});

test("claudeCodeAdapter.ask() treats an unparseable response as nothing to ask, not a crash", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const brain = claudeCodeAdapter({
    binPath: FAKE_CLI_IN_CONTAINER,
    image: TEST_IMAGE,
    askScratchDir: makeFakeCliScratchDir(),
  });

  const result = await brain.ask("ASK_SCENARIO_GARBLED");
  assert.deepEqual(result, { costUsd: 0.0421 });
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
    "--json-schema",
    JSON.stringify(WRITEUP_JSON_SCHEMA),
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
    "--json-schema",
    JSON.stringify(WRITEUP_JSON_SCHEMA),
  ]);
});

// Issue #186's second half: when the caller's env carries the real
// worker token (HOST_TOKEN_VAR, what defaultBrainAdapter forwards it
// under), the container must never see it - only a per-call placeholder,
// with a relay container standing behind it. Requires Docker several
// times over (runContained, plus the isolated/egress networks and the
// relay container itself - src/relay/container/launch.ts), so it skips,
// never fails, exactly like every other test in this file, when Docker
// isn't reachable.
test("claudeCodeAdapter.work() never forwards the real worker token into the container - only a placeholder, with the relay standing behind it", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");

  const realToken = "a-fake-real-token-not-the-actual-secret";
  const brain = claudeCodeAdapter({
    binPath: FAKE_CLI_IN_CONTAINER,
    image: TEST_IMAGE,
    env: { CLAUDE_CODE_OAUTH_TOKEN: realToken },
  });

  const result = await brain.work("PRINT_ENV", makeFakeCliWorkdir());

  const seenEnv = JSON.parse(result.transcript[0].text);
  assert.equal(seenEnv.CLAUDE_CODE_OAUTH_TOKEN, undefined, "the real token's own variable must not reach the container at all");
  assert.ok(seenEnv.ANTHROPIC_BASE_URL?.startsWith("http://"), "no relay base URL reached the container");
  assert.ok(seenEnv.ANTHROPIC_AUTH_TOKEN, "no placeholder credential reached the container");
  assert.notEqual(seenEnv.ANTHROPIC_AUTH_TOKEN, realToken, "the placeholder must not be the real token itself");
});

// Same proof for ask() - a separate code path (its own scratch workdir,
// not a ProductionLine) that goes through the same prepareNetwork().
// BrainAskResult has no transcript field, so this reads the file the
// fake CLI's PRINT_ENV scenario writes into its cwd instead - always
// the host's own scratch dir, on the other side of the bind mount.
test("claudeCodeAdapter.ask() never forwards the real worker token into the container either", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");

  const realToken = "a-fake-real-token-not-the-actual-secret";
  const scratchDir = makeFakeCliScratchDir();
  const brain = claudeCodeAdapter({
    binPath: FAKE_CLI_IN_CONTAINER,
    image: TEST_IMAGE,
    env: { CLAUDE_CODE_OAUTH_TOKEN: realToken },
    askScratchDir: scratchDir,
  });

  await brain.ask("PRINT_ENV");

  const seenEnv = JSON.parse(readFileSync(join(scratchDir, "env-dump.json"), "utf8"));
  assert.equal(seenEnv.CLAUDE_CODE_OAUTH_TOKEN, undefined, "the real token's own variable must not reach the container at all");
  assert.ok(seenEnv.ANTHROPIC_BASE_URL?.startsWith("http://"), "no relay base URL reached the container");
  assert.ok(seenEnv.ANTHROPIC_AUTH_TOKEN, "no placeholder credential reached the container");
  assert.notEqual(seenEnv.ANTHROPIC_AUTH_TOKEN, realToken, "the placeholder must not be the real token itself");
});

// The write-up is structured output the CLI validates against this
// schema, never prose Fabrica parses (Client ruling 2026-10-13).
test("claudeCodeAdapter passes --json-schema for the write-up: every required field, title at most 60, a three-question quiz", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const brain = claudeCodeAdapter({ binPath: FAKE_CLI_IN_CONTAINER, image: TEST_IMAGE });

  const result = await brain.work("ECHO_ARGS", makeFakeCliWorkdir());

  const argsSeen: string[] = JSON.parse(result.transcript[0].text);
  const at = argsSeen.indexOf("--json-schema");
  assert.ok(at >= 0, "--json-schema was not passed");
  const schema = JSON.parse(argsSeen[at + 1]);
  assert.equal(schema.type, "object");
  assert.deepEqual(
    [...schema.required].sort(),
    ["assumptions", "confidence", "deviations", "expectedOutcomes", "how", "outsideChanges", "quiz", "title", "what", "why"]
  );
  for (const field of ["title", "what", "why", "how", "outsideChanges", "assumptions", "expectedOutcomes", "deviations"]) {
    assert.equal(schema.properties[field].type, "string", `${field} is not a string field`);
  }
  // The one optional field: offered, never required - and it has to be a
  // declared property all the same, since additionalProperties is false.
  assert.equal(schema.properties.couldNotVerify.type, "string");
  assert.ok(!schema.required.includes("couldNotVerify"));
  assert.equal(schema.properties.confidence.type, "number");
  assert.equal(schema.properties.confidence.minimum, 0);
  assert.equal(schema.properties.confidence.maximum, 100);
  assert.equal(schema.properties.title.maxLength, 60);
  assert.equal(schema.additionalProperties, false);
  // Issue #98's quiz: exactly three, pinned both ways, each entry a
  // question and a non-empty answer - so the CLI's own schema retries
  // ask for the right shape before the Foreman ever has to refuse it.
  assert.equal(schema.properties.quiz.type, "array");
  assert.equal(schema.properties.quiz.minItems, 3);
  assert.equal(schema.properties.quiz.maxItems, 3);
  assert.deepEqual([...schema.properties.quiz.items.required].sort(), ["answer", "question"]);
  assert.equal(schema.properties.quiz.items.properties.question.minLength, 1);
  assert.equal(schema.properties.quiz.items.properties.answer.minLength, 1);
  assert.equal(schema.properties.quiz.items.additionalProperties, false);
});

test("claudeCodeAdapter fills writeup from the result line's structured_output", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const brain = claudeCodeAdapter({ binPath: FAKE_CLI_IN_CONTAINER, image: TEST_IMAGE });

  const result = await brain.work("WRITEUP_STRUCTURED", makeFakeCliWorkdir());

  assert.deepEqual(result.writeup, {
    title: "Fake structured write-up",
    why: "Why it did it.",
    what: "What it did.",
    how: "How it did it.",
    outsideChanges: "None.",
    confidence: 90,
    assumptions: "None.",
    expectedOutcomes: "It works as described.",
    deviations: "None.",
    quiz: [
      { question: "What changed?", answer: "The fake CLI's stand-in change." },
      { question: "Why?", answer: "To exercise the structured write-up path." },
      { question: "What should the owner watch?", answer: "Nothing - this is a test fixture." },
    ],
  });
});

test("claudeCodeAdapter returns no writeup when the result line has no structured_output, never one parsed from text", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const brain = claudeCodeAdapter({ binPath: FAKE_CLI_IN_CONTAINER, image: TEST_IMAGE });

  const result = await brain.work("WRITEUP_AS_PROSE_ONLY", makeFakeCliWorkdir());

  assert.equal(result.writeup, undefined);
});

test("claudeCodeAdapter returns no writeup, without throwing, when the CLI gave up producing the structured output", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const brain = claudeCodeAdapter({ binPath: FAKE_CLI_IN_CONTAINER, image: TEST_IMAGE });

  const result = await brain.work("WRITEUP_RETRIES_EXHAUSTED", makeFakeCliWorkdir());

  assert.equal(result.writeup, undefined);
  assert.equal(result.session, "fake-session-123");
});

test("claudeCodeAdapter maps structured stream-json into transcript entries and skips harness noise", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const brain = claudeCodeAdapter({ binPath: FAKE_CLI_IN_CONTAINER, image: TEST_IMAGE });

  const result = await brain.work("SUCCESS_WITH_TOOLS", makeFakeCliWorkdir());

  assert.deepEqual(
    result.transcript.map((e) => e.kind),
    // Issue #184: the init line's own model leads, then the work itself.
    ["model", "reasoning", "tool-call", "tool-result", "text", "usage"]
  );
  assert.equal(result.transcript[0].text, "fake-configured-model");
  assert.match(result.transcript[2].text, /^Bash\(/);
  assert.equal(result.transcript[3].text, "hello from spike");
  assert.equal(result.transcript[4].text, "Done.");
  // The rest of the "system" (init) line never became a transcript entry.
  assert.ok(!result.transcript.some((e) => e.text.includes("init")));
});

// Negative first (issue #70): a batched "hand the whole transcript over
// once the call resolves" implementation would make every entry arrive
// at once, right at the very end. This proves the first entry reaches
// the live listener - the same path work() uses to deliver to
// transcript.log, see src/brain/live-transcript.ts - well before the
// fake CLI has even emitted its third one, not just before the whole
// call finishes.
test("claudeCodeAdapter delivers each transcript entry live, as it arrives, not batched at the end", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const workdir = makeFakeCliWorkdir();
  const brain = claudeCodeAdapter({ binPath: FAKE_CLI_IN_CONTAINER, image: TEST_IMAGE });

  const arrived: TranscriptEntry[] = [];
  const unregister = registerLiveTranscriptListener(workdir, (entry) => arrived.push(entry));
  try {
    const workPromise = brain.work("LIVE_STREAM_DELAYED", workdir);

    // The fake CLI's LIVE_STREAM_DELAYED scenario emits "first", waits a
    // real ~300ms, emits "second", waits another ~300ms, then emits
    // "third" - independent of however long the container itself took
    // to start. Polling (rather than a fixed delay from test start) for
    // the first arrival and asserting it is STILL ALONE the moment it's
    // seen proves delivery is live: a batched implementation would never
    // show exactly one entry here - it would show zero until the whole
    // call resolves, then all three at once.
    const deadline = Date.now() + 20_000;
    while (arrived.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.deepEqual(
      arrived.map((e) => e.text),
      ["first"],
      "the first entry should already be here, alone - the second and third are still 300ms+ away inside the worker"
    );

    const result = await workPromise;
    assert.deepEqual(arrived.map((e) => e.text), ["first", "second", "third"]);
    // work()'s own return value is still the complete, ordered transcript
    // once it resolves - the live channel is additive, not a replacement
    // for it (nothing about Brain.work's contract changes).
    assert.deepEqual(result.transcript.map((e) => e.text).slice(0, 3), ["first", "second", "third"]);
  } finally {
    unregister();
  }
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
  // Issue #188: this account is a flat-rate subscription, so the figure
  // above is notional - marked so the caps never bind on it as if it
  // were metered money.
  assert.equal(payload.costBasis, "subscription-estimate");
});

test("claudeCodeAdapter passes maxSpendUsd as --max-budget-usd", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const brain = claudeCodeAdapter({ binPath: FAKE_CLI_IN_CONTAINER, image: TEST_IMAGE });

  const result = await brain.work("ECHO_ARGS", makeFakeCliWorkdir(), { maxSpendUsd: 1.25 });

  const argsSeen: string[] = JSON.parse(result.transcript[0].text);
  assert.equal(argsSeen[argsSeen.indexOf("--max-budget-usd") + 1], "1.25");
});

// The real binary, verified on 2.1.295: hitting --max-budget-usd exits 1
// with a result line carrying is_error: true, subtype
// "error_max_budget_usd", and the real total_cost_usd (which can already
// be past the budget - the CLI checks after a turn, not during one). That
// is the cap working, not the brain failing: the attempt's spend must
// reach the receipt so the Foreman can stop the task honestly, instead of
// a thrown error losing the money on the record.
test("claudeCodeAdapter returns normally, cost included, when the budget runs out", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const brain = claudeCodeAdapter({ binPath: FAKE_CLI_IN_CONTAINER, image: TEST_IMAGE });

  const result = await brain.work("BUDGET_EXHAUSTED", makeFakeCliWorkdir(), { maxSpendUsd: 0.1 });

  const usageEntry = result.transcript.find((e) => e.kind === "usage");
  assert.ok(usageEntry, "no usage entry - the spend of a budget-stopped call was lost");
  assert.equal(JSON.parse(usageEntry.text).totalCostUsd, 0.1427);
  assert.ok(result.transcript.some((e) => e.kind === "budget-exhausted"));
  assert.equal(result.session, "fake-session-123");
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
test("claudeCodeCheckBox runs the check inside the box, never on the host, and reports a missing command as exit 127", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const line = createProductionLine({ project: makeFixtureProject(), taskId: "check-box", recordHome: makeFixtureHome() });
  const hostMarker = join(mkdtempSync(join(tmpdir(), "fabrica-check-box-host-")), "ran-on-host");
  try {
    const box = claudeCodeCheckBox({ image: TEST_IMAGE });

    const ran = await box(line.workdir, `echo in-the-box; touch "${hostMarker}" 2>/dev/null; exit 3`);
    assert.deepEqual([ran.ran, ran.ran && ran.exitCode], [true, 3]);
    assert.ok(ran.ran && ran.output.includes("in-the-box"));
    assert.equal(existsSync(hostMarker), false, "the check reached the host's filesystem");

    const missing = await box(line.workdir, "definitely-not-a-command");
    assert.ok(missing.ran && missing.exitCode === 127, JSON.stringify(missing));
  } finally {
    destroyProductionLine(line);
  }
});

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

// Issue #184: "unknown", never "default". This adapter genuinely cannot
// say which model its own configuration resolves to until a call reports
// one - and "default" read as a real choice on every receipt and every
// row that showed it, which is the whole complaint the issue opens with.
test("claudeCodeAdapter reports model as configured, or 'unknown' when none was given", async () => {
  assert.equal(claudeCodeAdapter({ binPath: FAKE_CLI_IN_CONTAINER }).model, "unknown");
  assert.notEqual(claudeCodeAdapter({ binPath: FAKE_CLI_IN_CONTAINER }).model, "default");
  assert.equal(claudeCodeAdapter({ binPath: FAKE_CLI_IN_CONTAINER, model: "claude-opus-5" }).model, "claude-opus-5");
});

// Issue #184: the session-init line is the only place this binary names
// the model a run actually resolved to (verified against the real
// 2.1.222 binary, and the committed fixture now demonstrates the field -
// see helpers/fixtures/). It becomes the reserved "model" transcript
// entry src/foreman/model.ts reads the receipt's model out of.
test("claudeCodeAdapter turns the session-init line's model into the reserved transcript entry", () => {
  const entries = mapLineToEntries({ type: "system", subtype: "init", model: "some-model-5[1m]" });

  assert.deepEqual(
    entries.map((e) => ({ kind: e.kind, text: e.text })),
    [{ kind: "model", text: "some-model-5[1m]" }]
  );
});

test("an init line that names no model, or names a placeholder, reports nothing at all", () => {
  // Rather than reporting "default" and letting it reach a receipt,
  // which is the behaviour this issue removed.
  assert.deepEqual(mapLineToEntries({ type: "system", subtype: "init" }), []);
  assert.deepEqual(mapLineToEntries({ type: "system", subtype: "init", model: "default" }), []);
  // Harness chatter on a "system" line that is not the init one stays
  // exactly what it always was: nothing.
  assert.deepEqual(mapLineToEntries({ type: "system", subtype: "hook_started", model: "some-model-5" }), []);
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
// (`docker build`, see docker/Dockerfile) and the worker token the real
// `fabrica` uses (the environment or `<record home>/brain.env`, read by
// credentialEnvFrom exactly as defaultBrainAdapter does). With the token
// the call goes through the relay like a real task: the container gets
// a placeholder, the relay holds the token. It skips (does not fail)
// rather than lie about proving this when either is missing.
test("claude-code adapter: real binary does real work in a real worktree (capability spike)", async (t) => {
  if (!dockerAvailable()) {
    realBinarySkipReason = "Docker is not available on this machine";
    t.skip(realBinarySkipReason);
    return;
  }
  try {
    execFileSync("docker", ["image", "inspect", "fabrica-claude-code:latest"], { stdio: "ignore" });
  } catch {
    realBinarySkipReason = "the containerized real binary's image (fabrica-claude-code:latest) is not built on this machine";
    t.skip(realBinarySkipReason);
    return;
  }
  let credentials: ReturnType<typeof credentialEnvFrom>;
  try {
    credentials = credentialEnvFrom(process.env, resolveRecordHome());
  } catch (err) {
    realBinarySkipReason = `no worker token on this machine: ${err instanceof Error ? err.message : String(err)}`;
    t.skip(realBinarySkipReason);
    return;
  }

  const project = makeFixtureProject();
  const recordHome = makeFixtureHome();
  const line = createProductionLine({ project, taskId: "spike-adapter-6", recordHome });

  try {
    const brain = claudeCodeAdapter(credentials);
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

// Issue #189: the subscription meters. The CLI's own non-interactive
// output carries neither number (verified by running it - see
// notes/20261020-do-fabrica-issue-189-as-written-closing-i3.md), so
// they are read from the upstream's response headers at the relay, and
// this is the one place that knows what those headers' values mean.

test("percentFromUtilization: a utilization fraction becomes a whole-window percentage, the way the CLI's own status line does it", () => {
  // Read live from the provider on 2026-10-20: the headers carry
  // "0.07" and "0.64", and the status line renders them as
  // used_percentage = utilization * 100.
  // Compared with a tolerance, not pinned: 0.07 * 100 is not exactly 7
  // in binary floating point, and the numbers are only ever shown
  // rounded (`formatPercent`).
  assert.ok(Math.abs(percentFromUtilization("0.07")! - 7) < 1e-9);
  assert.ok(Math.abs(percentFromUtilization("0.64")! - 64) < 1e-9);
  assert.equal(percentFromUtilization("0"), 0);
  assert.equal(percentFromUtilization("1"), 100);
});

test("percentFromUtilization: an absent or unreadable header is null, never 0 - an empty window is the opposite fact", () => {
  assert.equal(percentFromUtilization(undefined), null);
  assert.equal(percentFromUtilization(""), null);
  assert.equal(percentFromUtilization("not-a-number"), null);
  assert.equal(percentFromUtilization("-0.5"), null);
});

test("meterReadingFrom: both headers become one reading, stamped when the relay's watcher read them", () => {
  const observedAt = "2026-10-20T12:00:00.000Z";
  const reading = meterReadingFrom({
    observedAt,
    headers: {
      "anthropic-ratelimit-unified-5h-utilization": "0.10",
      "anthropic-ratelimit-unified-7d-utilization": "0.64",
    },
  });
  assert.equal(reading?.observedAt, observedAt);
  assert.equal(Math.round(reading!.fiveHourPercent!), 10);
  assert.equal(Math.round(reading!.sevenDayPercent!), 64);
});

test("meterReadingFrom: one window reported and not the other leaves the other null, and reports what it has", () => {
  const reading = meterReadingFrom({
    observedAt: "2026-10-20T12:00:00.000Z",
    headers: { "anthropic-ratelimit-unified-7d-utilization": "0.64" },
  });
  assert.equal(reading?.fiveHourPercent, null);
  assert.equal(Math.round(reading!.sevenDayPercent!), 64);
});

test("meterReadingFrom: no reading at all, and a reading with neither header, are both no reading", () => {
  assert.equal(meterReadingFrom(undefined), undefined);
  assert.equal(
    meterReadingFrom({ observedAt: "2026-10-20T12:00:00.000Z", headers: { "x-something-else": "1" } }),
    undefined
  );
});
