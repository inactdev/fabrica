// Fast, Docker-free tests of worker-loop.mjs's own logic: run it as a
// plain child process (no containment involved - this file has no
// project imports itself, so a bare `node` is the real, honest way to
// exercise it) against startFakeChatServer, never a real provider.
// Docker-dependent proof that it also runs correctly *inside*
// containment lives in index.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeChatServer } from "./helpers/fake-chat-server.ts";
import type { ScriptedResponse } from "./helpers/fake-chat-server.ts";

const SCRIPT_PATH = fileURLToPath(new URL("./worker-loop.mjs", import.meta.url));

interface RunResult {
  exitCode: number | null;
  stderr: string;
  lines: Array<Record<string, unknown>>;
  cwd: string;
  home: string;
}

function runScript(
  input: Record<string, unknown>,
  opts: { apiKey?: string; cwd?: string; home?: string } = {}
): Promise<RunResult> {
  const cwd = opts.cwd ?? mkdtempSync(join(tmpdir(), "fabrica-direct-api-cwd-"));
  const home = opts.home ?? mkdtempSync(join(tmpdir(), "fabrica-direct-api-home-"));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT_PATH], {
      cwd,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        DIRECT_API_INPUT: JSON.stringify(input),
        ...(opts.apiKey ? { DIRECT_API_KEY: opts.apiKey } : {}),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      const lines = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      resolve({ exitCode, stderr, lines, cwd, home });
    });
  });
}

test("worker-loop: calls write_file then submit_writeup, writes the file, reports the write-up", async () => {
  const responses: ScriptedResponse[] = [
    { toolCalls: [{ name: "write_file", arguments: { path: "out.txt", content: "hello" } }] },
    {
      toolCalls: [
        {
          name: "submit_writeup",
          arguments: { title: "Add out.txt", what: "w", why: "y", how: "h", deviations: "None." },
        },
      ],
    },
  ];
  const server = await startFakeChatServer(responses);
  try {
    const result = await runScript({
      mode: "work",
      brief: "write a file",
      model: "m",
      baseUrl: server.url,
      backendName: "openrouter",
      maxSpendUsd: null,
      hasSession: false,
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(readFileSync(join(result.cwd, "out.txt"), "utf8"), "hello");

    const resultLine = result.lines.at(-1) as { type: string; writeup: Record<string, string>; session: string };
    assert.equal(resultLine.type, "result");
    assert.deepEqual(resultLine.writeup, { title: "Add out.txt", what: "w", why: "y", how: "h", deviations: "None." });
    assert.equal(resultLine.session, "direct-api");
    assert.equal(server.requests.length, 2);

    rmSync(result.cwd, { recursive: true, force: true });
    rmSync(result.home, { recursive: true, force: true });
  } finally {
    await server.close();
  }
});

test("worker-loop: run_command executes a real shell command in the project root", async () => {
  const responses: ScriptedResponse[] = [
    { toolCalls: [{ name: "run_command", arguments: { command: "echo hi-from-command" } }] },
    { toolCalls: [{ name: "submit_writeup", arguments: { title: "t", what: "w", why: "y", how: "h", deviations: "None." } }] },
  ];
  const server = await startFakeChatServer(responses);
  try {
    const result = await runScript({
      mode: "work",
      brief: "run a command",
      model: "m",
      baseUrl: server.url,
      backendName: "openrouter",
      maxSpendUsd: null,
      hasSession: false,
    });

    assert.equal(result.exitCode, 0, result.stderr);
    const toolResultEntry = result.lines.find(
      (line) => line.type === "entry" && (line.entry as { kind?: string })?.kind === "tool-result"
    ) as { entry: { text: string } } | undefined;
    assert.ok(toolResultEntry, "expected a tool-result transcript entry");
    assert.ok(toolResultEntry!.entry.text.includes("hi-from-command"));
  } finally {
    await server.close();
  }
});

test("worker-loop: ask mode reports the model's questions, and offers no tools", async () => {
  const server = await startFakeChatServer([{ content: '{"questions": ["What format?", "Which users?"]}' }]);
  try {
    const result = await runScript({
      mode: "ask",
      brief: "do something vague",
      model: "m",
      baseUrl: server.url,
      backendName: "openrouter",
    });

    assert.equal(result.exitCode, 0, result.stderr);
    const resultLine = result.lines.at(-1) as { type: string; mode: string; questions: string[]; costUsd: number | null };
    assert.equal(resultLine.type, "result");
    assert.equal(resultLine.mode, "ask");
    assert.deepEqual(resultLine.questions, ["What format?", "Which users?"]);
    assert.equal(resultLine.costUsd, null);
    assert.equal(server.requests.length, 1);
    assert.equal((server.requests[0] as { tools?: unknown }).tools, undefined);
  } finally {
    await server.close();
  }
});

test("worker-loop: a response with no usage.cost reports cost as unknown (null), never zero", async () => {
  const server = await startFakeChatServer([
    { toolCalls: [{ name: "submit_writeup", arguments: { title: "t", what: "w", why: "y", how: "h", deviations: "None." } }] },
  ]);
  try {
    const result = await runScript({
      mode: "work",
      brief: "b",
      model: "m",
      baseUrl: server.url,
      backendName: "openrouter",
      maxSpendUsd: null,
      hasSession: false,
    });

    const usageEntry = result.lines.find(
      (line) => line.type === "entry" && (line.entry as { kind?: string })?.kind === "usage"
    ) as { entry: { text: string } };
    assert.deepEqual(JSON.parse(usageEntry.entry.text), { totalCostUsd: null, costBasis: "metered" });
  } finally {
    await server.close();
  }
});

test("worker-loop: the ollama backend always reports a real, known zero cost, never unknown", async () => {
  const server = await startFakeChatServer([
    { toolCalls: [{ name: "submit_writeup", arguments: { title: "t", what: "w", why: "y", how: "h", deviations: "None." } }] },
  ]);
  try {
    const result = await runScript({
      mode: "work",
      brief: "b",
      model: "m",
      baseUrl: server.url,
      backendName: "ollama",
      maxSpendUsd: null,
      hasSession: false,
    });

    const usageEntry = result.lines.find(
      (line) => line.type === "entry" && (line.entry as { kind?: string })?.kind === "usage"
    ) as { entry: { text: string } };
    assert.deepEqual(JSON.parse(usageEntry.entry.text), { totalCostUsd: 0, costBasis: "metered" });
  } finally {
    await server.close();
  }
});

test("worker-loop: stops once maxSpendUsd is reached, never reaching submit_writeup", async () => {
  const responses: ScriptedResponse[] = [
    { toolCalls: [{ name: "run_command", arguments: { command: "true" } }], costUsd: 1 },
    { toolCalls: [{ name: "submit_writeup", arguments: { title: "t", what: "w", why: "y", how: "h", deviations: "None." } }] },
  ];
  const server = await startFakeChatServer(responses);
  try {
    const result = await runScript({
      mode: "work",
      brief: "b",
      model: "m",
      baseUrl: server.url,
      backendName: "openrouter",
      maxSpendUsd: 0.5,
      hasSession: false,
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(server.requests.length, 1, "must stop before a second call once the budget is already spent");
    const resultLine = result.lines.at(-1) as { type: string; writeup: unknown };
    assert.equal(resultLine.writeup, null);
  } finally {
    await server.close();
  }
});

test("worker-loop: a turn with no tool calls gets one nudge, then the loop stops without a write-up", async () => {
  const server = await startFakeChatServer([{ content: "I'm thinking about it." }]);
  try {
    const result = await runScript({
      mode: "work",
      brief: "b",
      model: "m",
      baseUrl: server.url,
      backendName: "openrouter",
      maxSpendUsd: null,
      hasSession: false,
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(server.requests.length, 2, "one nudge, then one more try, then stop");
    const resultLine = result.lines.at(-1) as { type: string; writeup: unknown };
    assert.equal(resultLine.writeup, null);
  } finally {
    await server.close();
  }
});

test("worker-loop: a cold start (hasSession: false) never carries over a prior call's history, even sharing the same HOME", async () => {
  const server = await startFakeChatServer([
    { toolCalls: [{ name: "submit_writeup", arguments: { title: "t", what: "w", why: "y", how: "h", deviations: "None." } }] },
  ]);
  try {
    const home = mkdtempSync(join(tmpdir(), "fabrica-direct-api-home-"));
    const first = await runScript(
      { mode: "work", brief: "first brief", model: "m", baseUrl: server.url, backendName: "openrouter", maxSpendUsd: null, hasSession: false },
      { home }
    );
    assert.equal(first.exitCode, 0, first.stderr);

    const second = await runScript(
      { mode: "work", brief: "second brief", model: "m", baseUrl: server.url, backendName: "openrouter", maxSpendUsd: null, hasSession: false },
      { home }
    );
    assert.equal(second.exitCode, 0, second.stderr);

    const secondRequestMessages = (server.requests[1] as { messages: Array<{ role: string; content: string }> }).messages;
    assert.equal(secondRequestMessages.length, 2, "system + this call's own brief, nothing from the first call");
    assert.equal(secondRequestMessages[1].content, "second brief");
  } finally {
    await server.close();
  }
});

test("worker-loop: a resumed session (hasSession: true) continues the same conversation instead of starting cold", async () => {
  const responses: ScriptedResponse[] = [
    { toolCalls: [{ name: "write_file", arguments: { path: "a.txt", content: "a" } }] },
    { toolCalls: [{ name: "submit_writeup", arguments: { title: "t1", what: "w", why: "y", how: "h", deviations: "None." } }] },
    { toolCalls: [{ name: "submit_writeup", arguments: { title: "t2", what: "w", why: "y", how: "h", deviations: "None." } }] },
  ];
  const server = await startFakeChatServer(responses);
  try {
    const home = mkdtempSync(join(tmpdir(), "fabrica-direct-api-home-"));
    const first = await runScript(
      { mode: "work", brief: "first brief", model: "m", baseUrl: server.url, backendName: "openrouter", maxSpendUsd: null, hasSession: false },
      { home }
    );
    assert.equal(first.exitCode, 0, first.stderr);
    assert.equal(server.requests.length, 2);

    const second = await runScript(
      { mode: "work", brief: "a correction", model: "m", baseUrl: server.url, backendName: "openrouter", maxSpendUsd: null, hasSession: true },
      { home, cwd: first.cwd }
    );
    assert.equal(second.exitCode, 0, second.stderr);
    assert.equal(server.requests.length, 3);

    // The resumed call's own request carries the first call's entire
    // history (system + first brief + the assistant's write_file turn +
    // its tool result + the first write-up's tool turn and reply) plus
    // this call's new brief appended - never a conversation starting over.
    const thirdRequestMessages = (server.requests[2] as { messages: Array<{ role: string; content: string }> }).messages;
    assert.ok(thirdRequestMessages.length > 2, "a resumed call's history must be longer than a cold start's");
    assert.equal(thirdRequestMessages.at(-1)!.content, "a correction");
    assert.ok(thirdRequestMessages.some((m) => m.content === "first brief"));
  } finally {
    await server.close();
  }
});
