// The box runs this agent with a stock `node` and a read-only copy of
// these files - no tsx, nothing from node_modules, no TypeScript
// anywhere near it (../openai-compatible.ts copies only the .mjs files
// in). This proves that the same way src/relay/container/
// runtime-imports.test.ts proves it for the relay: copy only the .mjs
// files into an empty directory and run the real entry point there,
// against a real local server standing in for the provider.
//
// It is also the one test that drives the whole agent end to end -
// process, protocol, HTTP call, tools, session file - without Docker.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WRITEUP_OPTIONAL_STRING_FIELDS, WRITEUP_QUIZ_LENGTH, WRITEUP_STRING_FIELDS, WRITEUP_TITLE_MAX_LENGTH } from "../../writeup.ts";
import { writeupToolSchema } from "../openai-compatible.ts";
import type { AgentJob, AgentLine } from "./types.ts";

const AGENT_DIR = dirname(fileURLToPath(import.meta.url));

const writeup = {
  title: "Add the file the brief asked for",
  why: "why",
  what: "what",
  how: "how",
  outsideChanges: "None.",
  confidence: 70,
  assumptions: "none",
  expectedOutcomes: "the file exists",
  deviations: "None.",
  quiz: [
    { question: "What changed?", answer: "The thing this test is about." },
    { question: "Why?", answer: "So the write-up is valid." },
    { question: "What should the owner watch?", answer: "Nothing - this is a test." },
  ],
};

/** Answers in order, then fails loudly rather than looping forever. */
async function fakeProvider(answers: unknown[]): Promise<{ port: number; calls: number; close: () => Promise<void> }> {
  let calls = 0;
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      calls++;
      const next = answers.shift();
      res.writeHead(next === undefined ? 500 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(next ?? { error: "the fake provider ran out of answers" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the fake provider reported no port");
  return {
    port: address.port,
    get calls() {
      return calls;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function toolCall(name: string, args: unknown, cost: number) {
  return {
    choices: [{ message: { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }] } }],
    usage: { cost, prompt_tokens: 100, completion_tokens: 20 },
  };
}

test("bootstrap.mjs runs the whole agent with plain node and only this directory's .mjs files present", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "fabrica-agent-plain-js-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const agentCopy = join(root, "agent");
  cpSync(AGENT_DIR, agentCopy, { recursive: true, filter: (src) => !src.endsWith(".ts") });
  const copied = readdirSync(agentCopy, { recursive: true }).map(String);
  assert.ok(copied.every((p) => !p.endsWith(".ts")), `a TypeScript file was copied: ${copied.join(", ")}`);
  assert.ok(copied.includes("bootstrap.mjs"));

  // Stands in for what the box gives the agent: the project copy as its
  // working directory, and a mounted $HOME to persist the session in.
  const workdir = join(root, "workdir");
  const home = join(root, "home");
  mkdirSync(workdir);
  mkdirSync(home);

  const provider = await fakeProvider([
    toolCall("write_file", { path: "made-by-the-worker.txt", content: "done" }, 0.01),
    toolCall("bash", { command: "cat made-by-the-worker.txt" }, 0.02),
    toolCall("submit_writeup", writeup, 0.03),
  ]);
  t.after(() => provider.close());

  const job: AgentJob = {
    mode: "work",
    brief: "create made-by-the-worker.txt",
    model: "a-model",
    endpoint: `http://127.0.0.1:${provider.port}/api/v1`,
    apiKey: "fabrica-placeholder-test",
    maxSpendUsd: 1,
    costSource: "reported",
    maxTurns: 6,
    sessionId: "round-1",
    writeupSchema: writeupToolSchema(),
    writeupStringFields: [...WRITEUP_STRING_FIELDS],
    writeupOptionalStringFields: [...WRITEUP_OPTIONAL_STRING_FIELDS],
    writeupTitleMaxLength: WRITEUP_TITLE_MAX_LENGTH,
    writeupQuizLength: WRITEUP_QUIZ_LENGTH,
    maxToolOutputChars: 4_000,
    bashTimeoutMs: 10_000,
  };
  const jobPath = join(agentCopy, "job.json");
  writeFileSync(jobPath, JSON.stringify(job));

  const child = spawn(process.execPath, [join(agentCopy, "bootstrap.mjs"), jobPath], {
    cwd: workdir,
    // Deliberately bare: no node_modules on any path, no NODE_PATH, no
    // tsx, nothing of this repo's own environment.
    env: { PATH: process.env.PATH ?? "", HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  const exitCode = await new Promise<number | null>((resolve) => child.once("close", resolve));

  assert.equal(exitCode, 0, `the agent exited ${exitCode}: ${stderr}`);
  // Stdout is a protocol, not a log: every line is one JSON object.
  const lines = stdout.trim().split("\n").map((line) => JSON.parse(line) as AgentLine);
  assert.deepEqual(
    lines.map((line) => line.t),
    ["usage", "tool-call", "tool-result", "usage", "tool-call", "tool-result", "usage", "tool-call", "tool-result", "result"]
  );

  const last = lines.at(-1);
  assert.ok(last !== undefined && last.t === "result");
  assert.equal(last.result.ok, true);
  assert.equal(last.result.stopReason, "submitted");
  assert.equal(last.result.turnsCompleted, 3);
  assert.ok(Math.abs((last.result.totalCostUsd ?? 0) - 0.06) < 1e-9, `total was ${last.result.totalCostUsd}`);
  assert.deepEqual(last.result.writeup, writeup);

  // It really did the work, in the working directory it was given.
  assert.equal(readFileSync(join(workdir, "made-by-the-worker.txt"), "utf8"), "done");
  // And its session is on disk under the box's own $HOME, which is what
  // makes a later fix round a warm one.
  assert.ok(existsSync(join(home, ".fabrica-sessions", "round-1.json")));
});

test("a work job with no cap makes no API call at all, whatever started it", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "fabrica-agent-no-cap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentCopy = join(root, "agent");
  cpSync(AGENT_DIR, agentCopy, { recursive: true, filter: (src) => !src.endsWith(".ts") });

  const provider = await fakeProvider([toolCall("submit_writeup", writeup, 0.01)]);
  t.after(() => provider.close());

  const jobPath = join(agentCopy, "job.json");
  writeFileSync(
    jobPath,
    JSON.stringify({
      mode: "work",
      brief: "do something expensive",
      model: "a-model",
      endpoint: `http://127.0.0.1:${provider.port}/api/v1`,
      apiKey: "fabrica-placeholder-test",
      maxSpendUsd: null,
      costSource: "reported",
      maxTurns: 6,
      sessionId: "round-1",
      writeupSchema: writeupToolSchema(),
      writeupStringFields: [...WRITEUP_STRING_FIELDS],
      writeupOptionalStringFields: [...WRITEUP_OPTIONAL_STRING_FIELDS],
      writeupTitleMaxLength: WRITEUP_TITLE_MAX_LENGTH,
      writeupQuizLength: WRITEUP_QUIZ_LENGTH,
      maxToolOutputChars: 4_000,
      bashTimeoutMs: 10_000,
    })
  );

  const child = spawn(process.execPath, [join(agentCopy, "bootstrap.mjs"), jobPath], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  const exitCode = await new Promise<number | null>((resolve) => child.once("close", resolve));

  assert.equal(exitCode, 1);
  assert.equal(provider.calls, 0, "a job with no cap reached the provider anyway");
  const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as AgentLine;
  assert.ok(result.t === "result");
  assert.equal(result.result.stopReason, "no-cap");
  assert.equal(result.result.totalCostUsd, 0);
});
