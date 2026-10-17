// The host half of the direct-API adapter: the refusal issue #200 is
// named after, how a target's base URL is split between the relay and
// the in-box client, and how the agent's own lines become the transcript
// and the receipt's dollars.
//
// The agent loop itself is proven in openai-agent/ (no Docker needed
// there - it is plain JavaScript). What needs a real box, and what needs
// a real provider, is gated below and says loudly when it did not run,
// the way this directory's README requires.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOSTED_BASE_URL,
  HOSTED_CREDENTIAL_VAR,
  LOCAL_BASE_URL,
  lineFeeder,
  mapAgentLine,
  openAiCompatibleAdapter,
  OpenAiCompatibleError,
  stageAgent,
  splitBaseUrl,
  writeupToolSchema,
} from "./openai-compatible.ts";
import { WRITEUP_FIELDS, WRITEUP_STRING_FIELDS, WRITEUP_TITLE_MAX_LENGTH } from "../writeup.ts";
import { costFromTranscript } from "../../foreman/spend.ts";
import { registerLiveTranscriptListener } from "../live-transcript.ts";
import { chatCompletion } from "./openai-agent/client.mjs";
import type { AgentJob, AgentLine } from "./openai-agent/types.ts";
import type { TranscriptEntry } from "../types.ts";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// The two things this file cannot prove on its own: that the real worker
// image runs this agent, and that a real provider answers in the shape
// the cost ledger depends on. Each records why it skipped, so the
// after() hook can make it impossible to read a wall of green dots as
// "verified against reality" (../README.md's "A loud skip, not a silent
// one" - the same hook claude-code.test.ts carries).
let boxCheckRan = false;
let boxSkipReason: string | null = null;
let realApiCheckRan = false;
let realApiSkipReason: string | null = null;

after(() => {
  const missing = [
    boxCheckRan ? null : `!! IN-BOX CHECK DID NOT RUN (${boxSkipReason ?? "unknown"})`,
    realApiCheckRan ? null : `!! REAL-PROVIDER CHECK DID NOT RUN (${realApiSkipReason ?? "unknown"})`,
  ].filter((line): line is string => line !== null);
  if (missing.length === 0) return;
  console.error(
    [
      "",
      "!".repeat(78),
      "!! DIRECT-API ADAPTER: NOT EVERYTHING WAS VERIFIED AGAINST REALITY",
      ...missing,
      "!! A green run here does NOT mean this adapter has run in a real box,",
      "!! or that a real provider answered with the usage.cost figure its",
      '!! receipts are built from - see openai-compatible.md, "What is not',
      '!! verified from here".',
      "!".repeat(78),
      "",
    ].join("\n")
  );
});

const anyWorkdir = "/nowhere-this-refusal-happens-first";

test("work() refuses before anything else when there is no spending cap, naming the setting to add", async () => {
  const brain = openAiCompatibleAdapter({ model: "some/open-weight-model", capSetting: "/home/me/.fabrica/projects.toml" });

  await assert.rejects(
    () => brain.work("a brief", anyWorkdir, {}),
    (err: Error) => {
      assert.ok(err instanceof OpenAiCompatibleError);
      assert.equal(err.code, "no-cap");
      // "refused with the exact setting to add" (issue #200).
      assert.match(err.message, /perTaskUsd/);
      assert.match(err.message, /\[caps\]/);
      assert.match(err.message, /\/home\/me\/\.fabrica\/projects\.toml/);
      return true;
    }
  );
  // Also with no options object at all, which is what a caller with no
  // cap and no session passes.
  await assert.rejects(() => brain.work("a brief", anyWorkdir), /perTaskUsd/);
});

test("the refusal happens with no container, no relay and no credential involved", async () => {
  // The workdir does not exist and no Docker is needed: if anything were
  // started before the cap was checked, this would fail differently.
  const brain = openAiCompatibleAdapter({ model: "m", apiKey: "a-fake-key-not-a-real-one" });
  const err = await brain.work("b", anyWorkdir, { session: "s" }).catch((e: unknown) => e);
  assert.ok(err instanceof OpenAiCompatibleError && err.code === "no-cap");
  assert.ok(!err.message.includes("a-fake-key-not-a-real-one"), "a refusal must never print the credential");
});

test("a cap with nothing left in it stops for $0, without paying for a container to say so", async () => {
  const brain = openAiCompatibleAdapter({ model: "m" });
  const live: TranscriptEntry[] = [];
  const unregister = registerLiveTranscriptListener(anyWorkdir, (entry) => live.push(entry));

  const result = await brain.work("b", anyWorkdir, { maxSpendUsd: 0 });
  unregister();

  assert.equal(result.writeup, undefined, "nothing was done, so there is no write-up");
  assert.deepEqual(
    result.transcript.map((entry) => entry.kind),
    ["usage", "budget-exhausted"]
  );
  // Rule 10 reads $0.00 of real, metered spend - not an unknown.
  assert.deepEqual(costFromTranscript(result.transcript), { costUsd: 0, costBasis: "metered" });
  assert.deepEqual(live, result.transcript, "the stop was not reported live");
});

test("name and model: the adapter is named, the model is whatever it was pointed at", () => {
  const brain = openAiCompatibleAdapter({ model: "an/open-weight-model" });
  assert.equal(brain.name, "openai-compatible");
  assert.equal(brain.model, "an/open-weight-model");
});

test("a target's base URL splits into what the relay needs and the path the in-box client keeps", () => {
  // The default hosted target: https, default port left off so the relay
  // sends a plain Host header upstream, and the vendor's own path prefix
  // preserved so the call lands on /api/v1/chat/completions.
  assert.deepEqual(splitBaseUrl(HOSTED_BASE_URL), {
    gateway: { host: "openrouter.ai", tls: true },
    pathPrefix: "/api/v1",
  });
  // A local server: plain http, whose port must be stated explicitly -
  // the relay's own default is 443 whatever the scheme says.
  assert.deepEqual(splitBaseUrl(LOCAL_BASE_URL), {
    gateway: { host: "host.docker.internal", tls: false, port: 11434 },
    pathPrefix: "/v1",
  });
  assert.deepEqual(splitBaseUrl("http://127.0.0.1/v1/"), {
    gateway: { host: "127.0.0.1", tls: false, port: 80 },
    pathPrefix: "/v1",
  });
  assert.deepEqual(splitBaseUrl("https://example.test:8443/openai/v1"), {
    gateway: { host: "example.test", tls: true, port: 8443 },
    pathPrefix: "/openai/v1",
  });
  for (const bad of ["not a url", "ftp://example.test/v1", ""]) {
    assert.throws(
      () => splitBaseUrl(bad),
      (err: Error) => err instanceof OpenAiCompatibleError && err.code === "invalid-base-url"
    );
  }
});

test("the write-up tool asks for exactly the ratified fields, with rule 9's declaration alongside them", () => {
  const schema = writeupToolSchema();
  const properties = Object.keys(schema.properties as Record<string, unknown>);

  assert.deepEqual(schema.required, [...WRITEUP_STRING_FIELDS, "confidence"]);
  assert.deepEqual([...WRITEUP_FIELDS].sort(), properties.filter((name) => name !== "gateChanges").sort());
  // gateChanges is offered but never required: leaving the gate alone is
  // the normal case, and it is not part of the write-up itself.
  assert.ok(properties.includes("gateChanges"));
  assert.ok(!(schema.required as string[]).includes("gateChanges"));
  const title = (schema.properties as Record<string, { maxLength?: number }>).title;
  assert.equal(title.maxLength, WRITEUP_TITLE_MAX_LENGTH);
  const confidence = (schema.properties as Record<string, { minimum?: number; maximum?: number }>).confidence;
  assert.deepEqual([confidence.minimum, confidence.maximum], [0, 100]);
});

test("the agent's lines become the transcript a person watching the worker reads", () => {
  const kinds = (line: AgentLine) => mapAgentLine(line).map((entry) => entry.kind);
  assert.deepEqual(kinds({ t: "text", text: "thinking out loud" }), ["text"]);
  assert.deepEqual(kinds({ t: "tool-call", name: "bash", args: { command: "ls" } }), ["tool-call"]);
  assert.deepEqual(kinds({ t: "tool-result", name: "bash", text: "ok", isError: false }), ["tool-result"]);
  assert.deepEqual(kinds({ t: "tool-result", name: "bash", text: "boom", isError: true }), ["tool-error"]);
  assert.deepEqual(kinds({ t: "note", text: "stopped on the cap" }), ["note"]);
  // The result line is the host's own bookkeeping - everything a reader
  // needs from it is already an entry of its own.
  assert.deepEqual(
    kinds({ t: "result", result: { ok: true, stopReason: "submitted", turnsCompleted: 1, totalCostUsd: 1, session: "s" } }),
    []
  );

  const call = mapAgentLine({ t: "tool-call", name: "read_file", args: { path: "a.ts" } })[0];
  assert.equal(call.text, 'read_file({"path":"a.ts"})');
});

test("every API call lands on the record as its own metered usage entry, summed into the attempt's cost", () => {
  const usage = (costUsd: number | null, turn: number): AgentLine => ({
    t: "usage",
    turn,
    usage: { costUsd, promptTokens: 10, completionTokens: 2 },
    costSource: "reported",
  });

  const transcript = [...mapAgentLine(usage(0.01, 1)), ...mapAgentLine(usage(0.02, 2))];
  assert.deepEqual(costFromTranscript(transcript), { costUsd: 0.03, costBasis: "metered" });
  assert.equal(JSON.parse(transcript[0].text).costBasis, "metered");

  // An unknown cost is never summed as zero (rule 10).
  const withUnknown = [...transcript, ...mapAgentLine(usage(null, 3))];
  assert.deepEqual(costFromTranscript(withUnknown), { costUsd: null, costBasis: "metered" });
});

test("stdout is read line by line, however the chunks arrive", () => {
  const lines: string[] = [];
  const feed = lineFeeder((line) => lines.push(line));
  feed('{"t":"text","te');
  assert.deepEqual(lines, [], "half a line must be held until the rest of it lands");
  feed('xt":"a"}\n{"t":"note","text":"b"}\n{"t":"par');
  assert.deepEqual(lines, ['{"t":"text","text":"a"}', '{"t":"note","text":"b"}']);
  feed('tial":1}\n');
  assert.equal(lines.length, 3);
});

test("the staged agent is only ever the .mjs files, plus this call's job", (t) => {
  const job = { mode: "work", brief: "b", sessionId: "s" } as unknown as AgentJob;
  const staged = stageAgent(job);
  t.after(() => rmSync(staged.dir, { recursive: true, force: true }));

  const files = readdirSync(staged.dir);
  assert.ok(files.includes("bootstrap.mjs"));
  assert.ok(files.includes("job.json"));
  assert.deepEqual(
    files.filter((name) => !name.endsWith(".mjs") && name !== "job.json"),
    [],
    "only plain JavaScript and the job reach the box - it runs a stock node"
  );
});

// The in-box check: the real worker image, the real read-only agent
// mount, the real `node` in there - driven with a job that has no cap,
// so it needs no credential and no network to prove the whole path
// works (the agent refuses before its first call, and says so in the
// protocol the host reads).
test("the real worker image runs the staged agent and answers in the protocol", async (t) => {
  if (!dockerAvailable()) {
    boxSkipReason = "Docker is not available on this machine";
    return t.skip(boxSkipReason);
  }
  const { runContained } = await import("../../containment/index.ts");
  const workdir = mkdtempSync(join(tmpdir(), "fabrica-box-agent-"));
  t.after(() => rmSync(workdir, { recursive: true, force: true }));
  const staged = stageAgent({
    mode: "work",
    brief: "this job has no cap on purpose",
    model: "a-model",
    endpoint: "http://127.0.0.1:1/v1",
    apiKey: null,
    maxSpendUsd: null,
    costSource: "reported",
    maxTurns: 1,
    sessionId: "box-check",
    writeupSchema: writeupToolSchema(),
    writeupStringFields: [...WRITEUP_STRING_FIELDS],
    writeupTitleMaxLength: WRITEUP_TITLE_MAX_LENGTH,
    maxToolOutputChars: 1_000,
    bashTimeoutMs: 1_000,
  });
  t.after(() => rmSync(staged.dir, { recursive: true, force: true }));

  const { stdout, stderr, exitCode } = await runContained(
    "node",
    ["/fabrica-agent/bootstrap.mjs", "/fabrica-agent/job.json"],
    {
      workdir,
      network: "denied",
      image: process.env.FABRICA_TEST_IMAGE ?? "fabrica-claude-code:latest",
      readOnlyMounts: [{ source: staged.dir, target: "/fabrica-agent" }],
    }
  );

  if (exitCode === 125 || /Unable to find image|No such image/.test(stderr)) {
    boxSkipReason = `the worker image is not built on this machine: ${stderr.trim().slice(0, 200)}`;
    return t.skip(boxSkipReason);
  }

  const last = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as AgentLine;
  assert.ok(last.t === "result", `the agent printed no result line (exit ${exitCode}): ${stderr}`);
  assert.equal(last.result.stopReason, "no-cap");
  boxCheckRan = true;
});

// The real-provider check: one small, real call, to confirm the single
// documented fact every receipt from this adapter depends on - that the
// provider puts the charge for the call on `usage.cost`. Opt-in, like
// src/cli/skill-settings-live.test.ts and claude-code.test.ts's own
// real-binary test, because it costs real money and needs a credential
// this repo must never hold.
test("a real provider reports the call's cost on its own usage object", async (t) => {
  const apiKey = process.env[HOSTED_CREDENTIAL_VAR];
  const model = process.env.FABRICA_MODEL;
  if (process.env.FABRICA_TEST_REAL_MODEL_API !== "1") {
    realApiSkipReason = "FABRICA_TEST_REAL_MODEL_API is not 1 (it spends real money)";
    return t.skip(realApiSkipReason);
  }
  if (apiKey === undefined || model === undefined) {
    realApiSkipReason = `${HOSTED_CREDENTIAL_VAR} or FABRICA_MODEL is not set`;
    return t.skip(realApiSkipReason);
  }

  const job = {
    mode: "ask",
    brief: "Reply with the single word: ok",
    model,
    endpoint: HOSTED_BASE_URL,
    apiKey,
    maxSpendUsd: null,
    costSource: "reported",
    maxTurns: 1,
    sessionId: "real-check",
    writeupSchema: writeupToolSchema(),
    writeupStringFields: [...WRITEUP_STRING_FIELDS],
    writeupTitleMaxLength: WRITEUP_TITLE_MAX_LENGTH,
    maxToolOutputChars: 1_000,
    bashTimeoutMs: 1_000,
    askMaxTokens: 16,
  } satisfies AgentJob;

  const response = await chatCompletion(job, { messages: [{ role: "user", content: job.brief }], max_tokens: 16 });
  const usage = (response as { usage?: { cost?: unknown } }).usage;
  assert.equal(typeof usage?.cost, "number", `the provider reported no numeric usage.cost: ${JSON.stringify(usage)}`);
  realApiCheckRan = true;
});
