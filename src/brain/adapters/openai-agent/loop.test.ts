// The agent loop, driven against a fake provider function instead of a
// real API: this is where the behaviour issue #200 actually specified
// gets proven - metered dollars per call, a stop at the first call that
// crosses the cap, partial results rather than a thrown error, and a
// write-up that only counts when it is usable.
//
// No Docker and no network: the loop is plain JavaScript, so it runs
// here directly. What that cannot prove - that a real provider answers
// in this shape - is covered by ../openai-compatible.test.ts's
// real-endpoint test, which says loudly when it did not run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAsk, runWork, writeupProblem, questionsFrom, IDLE_NUDGE, WORK_SYSTEM_PROMPT } from "./loop.mjs";
import { WRITEUP_TOOL_NAME } from "./tools.mjs";
import { writeupToolSchema } from "../openai-compatible.ts";
import { WRITEUP_OPTIONAL_STRING_FIELDS, WRITEUP_STRING_FIELDS, WRITEUP_TITLE_MAX_LENGTH } from "../../writeup.ts";
import type { AgentJob, AgentLine, ChatTarget } from "./types.ts";

function makeJob(overrides: Partial<AgentJob> = {}): AgentJob {
  return {
    mode: "work",
    brief: "do the thing",
    model: "a-model",
    endpoint: "http://relay.invalid/v1",
    apiKey: "placeholder",
    maxSpendUsd: 1,
    costSource: "reported",
    maxTurns: 10,
    sessionId: "session-1",
    writeupSchema: writeupToolSchema(),
    writeupStringFields: [...WRITEUP_STRING_FIELDS],
    writeupOptionalStringFields: [...WRITEUP_OPTIONAL_STRING_FIELDS],
    writeupTitleMaxLength: WRITEUP_TITLE_MAX_LENGTH,
    maxToolOutputChars: 2_000,
    bashTimeoutMs: 10_000,
    ...overrides,
  };
}

const goodWriteup = {
  title: "A short title",
  why: "why",
  what: "what",
  how: "how",
  outsideChanges: "None.",
  confidence: 80,
  assumptions: "assumptions",
  expectedOutcomes: "outcomes",
  deviations: "None.",
};

/** One provider answer, in the shape OpenRouter's own tool-calling doc
 * shows (assistant message, optional tool_calls whose `arguments` is a
 * JSON string) plus the `usage` object its usage-accounting doc
 * documents as always present. */
function answer(opts: { content?: string; toolCalls?: { name: string; args: unknown }[]; cost?: number | null }) {
  const toolCalls = (opts.toolCalls ?? []).map((call, index) => ({
    id: `call_${index}`,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.args) },
  }));
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: opts.content ?? null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      ...(opts.cost === null ? {} : { cost: opts.cost ?? 0.25 }),
    },
  };
}

/** A fake `chat` that answers from a script, recording what it was sent.
 * The message list is snapshotted, not kept by reference: the loop
 * appends to one array for the whole call (the real client serializes it
 * at the moment of each request, so nothing in production cares), and a
 * test that kept the reference would only ever see the final state. */
function scriptedChat(answers: Record<string, unknown>[]) {
  const sent: Record<string, unknown>[] = [];
  // Typed with ChatTarget, not AgentJob: under strictFunctionTypes a
  // stand-in for chatCompletion must accept anything it would accept.
  const chat = async (_job: ChatTarget, payload: Record<string, unknown>) => {
    sent.push({ ...payload, ...(Array.isArray(payload.messages) ? { messages: [...payload.messages] } : {}) });
    const next = answers.shift();
    if (next === undefined) throw new Error("the fake provider ran out of scripted answers");
    return next;
  };
  return { chat, sent };
}

function collect(): { emit: (line: AgentLine) => void; lines: AgentLine[] } {
  const lines: AgentLine[] = [];
  return { emit: (line) => lines.push(line), lines };
}

function scratch(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "fabrica-agent-loop-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the loop works with tools and finishes only on a submitted write-up", async (t) => {
  const root = scratch(t);
  writeFileSync(join(root, "check.sh"), "#!/bin/sh\nexit 0\n");
  const { chat, sent } = scriptedChat([
    answer({ content: "Reading first.", toolCalls: [{ name: "read_file", args: { path: "check.sh" } }] }),
    answer({ toolCalls: [{ name: "write_file", args: { path: "new.txt", content: "hello" } }] }),
    answer({ toolCalls: [{ name: WRITEUP_TOOL_NAME, args: goodWriteup }] }),
  ]);
  const { emit, lines } = collect();

  const result = await runWork(makeJob(), emit, { root, chat });

  assert.equal(result.stopReason, "submitted");
  assert.equal(result.ok, true);
  assert.equal(result.turnsCompleted, 3);
  assert.deepEqual(result.writeup, goodWriteup);
  assert.equal(readFileSync(join(root, "new.txt"), "utf8"), "hello");

  // The whole exchange is on the transcript, in order, as it happened.
  assert.deepEqual(
    lines.map((line) => line.t),
    ["usage", "text", "tool-call", "tool-result", "usage", "tool-call", "tool-result", "usage", "tool-call", "tool-result"]
  );
  const toolResult = lines.find((line) => line.t === "tool-result");
  assert.equal(toolResult?.t === "tool-result" && toolResult.text.includes("exit 0"), true);

  // The first request carries the brief and the system prompt; every
  // request carries the tools, the write-up tool included.
  const first = sent[0] as { messages: { role: string; content: string }[]; tools: { function: { name: string } }[] };
  assert.equal(first.messages[0].role, "system");
  assert.equal(first.messages[0].content, WORK_SYSTEM_PROMPT);
  assert.equal(first.messages[1].content, "do the thing");
  assert.ok(first.tools.some((tool) => tool.function.name === WRITEUP_TOOL_NAME));
  assert.ok(first.tools.some((tool) => tool.function.name === "bash"));
  // Each later request carries the whole exchange back, tool results and all.
  const third = sent[2] as { messages: { role: string }[] };
  assert.deepEqual(
    third.messages.map((message) => message.role),
    ["system", "user", "assistant", "tool", "assistant", "tool"]
  );
});

test("spend is metered per call, and the first call that crosses the cap is the last one", async (t) => {
  const root = scratch(t);
  // $0.40 a call against a $1.00 cap: three calls reach $1.20, which is
  // the documented overshoot of at most one call - and a fourth is never
  // made, even though the script would have answered it.
  const { chat, sent } = scriptedChat([
    answer({ cost: 0.4, toolCalls: [{ name: "list_dir", args: { path: "." } }] }),
    answer({ cost: 0.4, toolCalls: [{ name: "list_dir", args: { path: "." } }] }),
    answer({ cost: 0.4, toolCalls: [{ name: "list_dir", args: { path: "." } }] }),
    answer({ cost: 0.4, toolCalls: [{ name: WRITEUP_TOOL_NAME, args: goodWriteup }] }),
  ]);
  const { emit, lines } = collect();

  const result = await runWork(makeJob({ maxSpendUsd: 1 }), emit, { root, chat });

  assert.equal(sent.length, 3, "a call was made after the cap was already crossed");
  assert.equal(result.stopReason, "budget-exhausted");
  assert.equal(result.ok, false, "a round stopped by the cap never counts as finished");
  assert.equal(result.writeup, undefined);
  assert.equal(result.turnsCompleted, 3);
  assert.ok(Math.abs((result.totalCostUsd ?? 0) - 1.2) < 1e-9, `total was ${result.totalCostUsd}`);
  // What was done up to that point is returned, not thrown away, and the
  // stop is named on the transcript.
  assert.ok(lines.some((line) => line.t === "tool-result"));
  const note = lines.find((line) => line.t === "note");
  assert.match(note?.t === "note" ? note.text : "", /spending cap/);
});

test("a cost the provider did not report is unknown, never zero", async (t) => {
  const root = scratch(t);
  const { chat } = scriptedChat([
    answer({ cost: 0.1, toolCalls: [{ name: "list_dir", args: { path: "." } }] }),
    answer({ cost: null, toolCalls: [{ name: WRITEUP_TOOL_NAME, args: goodWriteup }] }),
  ]);
  const { emit, lines } = collect();

  const result = await runWork(makeJob(), emit, { root, chat });

  assert.equal(result.stopReason, "submitted");
  assert.equal(result.totalCostUsd, null, "an unreported cost must not be summed as $0");
  const usage = lines.filter((line) => line.t === "usage");
  assert.deepEqual(
    usage.map((line) => (line.t === "usage" ? line.usage.costUsd : undefined)),
    [0.1, null]
  );
});

test("a target that bills nothing reports a real $0.00, not an unknown", async (t) => {
  const root = scratch(t);
  const { chat } = scriptedChat([answer({ cost: null, toolCalls: [{ name: WRITEUP_TOOL_NAME, args: goodWriteup }] })]);
  const { emit } = collect();

  const result = await runWork(makeJob({ costSource: "free" }), emit, { root, chat });

  assert.equal(result.totalCostUsd, 0);
});

test("an unusable write-up is named back to the model, which can fix it in the same call", async (t) => {
  const root = scratch(t);
  const { chat } = scriptedChat([
    answer({ toolCalls: [{ name: WRITEUP_TOOL_NAME, args: { ...goodWriteup, title: "x".repeat(WRITEUP_TITLE_MAX_LENGTH + 1) } }] }),
    answer({ toolCalls: [{ name: WRITEUP_TOOL_NAME, args: { ...goodWriteup, why: "   " } }] }),
    answer({ toolCalls: [{ name: WRITEUP_TOOL_NAME, args: goodWriteup }] }),
  ]);
  const { emit, lines } = collect();

  const result = await runWork(makeJob(), emit, { root, chat });

  assert.equal(result.stopReason, "submitted");
  const errors = lines.filter((line) => line.t === "tool-result" && line.isError);
  assert.equal(errors.length, 2);
  assert.match(errors[0].t === "tool-result" ? errors[0].text : "", /title is 61 characters/);
  assert.match(errors[1].t === "tool-result" ? errors[1].text : "", /why is required/);
});

test("rule 9's declaration rides on the write-up call, and never inside the write-up itself", async (t) => {
  const root = scratch(t);
  const { chat } = scriptedChat([
    answer({ toolCalls: [{ name: WRITEUP_TOOL_NAME, args: { ...goodWriteup, gateChanges: "relaxed check.sh, the brief asked for it" } }] }),
  ]);
  const { emit } = collect();

  const result = await runWork(makeJob(), emit, { root, chat });

  assert.equal(result.gateChanges, "relaxed check.sh, the brief asked for it");
  assert.deepEqual(result.writeup, goodWriteup);
});

test("a model that stops calling tools is nudged, then the loop gives up rather than spinning", async (t) => {
  const root = scratch(t);
  const { chat, sent } = scriptedChat([
    answer({ content: "I think I am done." }),
    answer({ content: "Still just talking." }),
    answer({ content: "And again." }),
  ]);
  const { emit } = collect();

  const result = await runWork(makeJob(), emit, { root, chat });

  assert.equal(result.stopReason, "idle");
  assert.equal(sent.length, 3);
  const nudged = (sent[1] as { messages: { content: string }[] }).messages.filter((m) => m.content === IDLE_NUDGE);
  assert.equal(nudged.length, 1);
});

test("a provider that refuses the very first call stops with nothing done and nothing spent", async (t) => {
  const root = scratch(t);
  const chat = async () => {
    throw new Error("the model API answered 401: no credit on this key");
  };
  const { emit, lines } = collect();

  const result = await runWork(makeJob(), emit, { root, chat });

  assert.equal(result.ok, false);
  assert.equal(result.stopReason, "api-error");
  assert.equal(result.turnsCompleted, 0);
  assert.equal(result.totalCostUsd, 0);
  assert.match(result.error ?? "", /401/);
  assert.equal(lines.filter((line) => line.t === "usage").length, 0);
});

test("a tool that fails is a message back to the model, not the end of the task", async (t) => {
  const root = scratch(t);
  const { chat } = scriptedChat([
    answer({ toolCalls: [{ name: "read_file", args: { path: "../../etc/hosts" } }] }),
    answer({ toolCalls: [{ name: "no_such_tool", args: {} }] }),
    answer({ toolCalls: [{ name: WRITEUP_TOOL_NAME, args: goodWriteup }] }),
  ]);
  const { emit, lines } = collect();

  const result = await runWork(makeJob(), emit, { root, chat });

  assert.equal(result.stopReason, "submitted");
  const errors = lines.filter((line) => line.t === "tool-result" && line.isError);
  assert.equal(errors.length, 2);
  assert.match(errors[0].t === "tool-result" ? errors[0].text : "", /outside the project/);
  assert.match(errors[1].t === "tool-result" ? errors[1].text : "", /no tool called/);
});

test("a session is saved and a later call resumes it, treating its brief as a correction", async (t) => {
  const root = scratch(t);
  const home = scratch(t);
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  const first = scriptedChat([answer({ toolCalls: [{ name: WRITEUP_TOOL_NAME, args: goodWriteup }] })]);
  await runWork(makeJob({ sessionId: "round-1" }), collect().emit, { root, chat: first.chat });

  const second = scriptedChat([answer({ toolCalls: [{ name: WRITEUP_TOOL_NAME, args: goodWriteup }] })]);
  await runWork(
    makeJob({ sessionId: "round-2", resumeSessionId: "round-1", brief: "the check went red, fix it" }),
    collect().emit,
    { root, chat: second.chat }
  );

  const resumed = second.sent[0] as { messages: { role: string; content: string }[] };
  assert.ok(resumed.messages.length > 2, "a resumed round started cold instead of continuing");
  assert.equal(resumed.messages[0].role, "system");
  assert.equal(resumed.messages.at(-1)?.content, "the check went red, fix it");
});

test("with no persisted home there is nothing to resume, and that is not an error", async (t) => {
  const root = scratch(t);
  const previousHome = process.env.HOME;
  // What a container with no mounted homeDir actually has (verified in
  // src/containment: an unmatched uid resolves HOME to "/").
  process.env.HOME = "/";
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  const { chat } = scriptedChat([answer({ toolCalls: [{ name: WRITEUP_TOOL_NAME, args: goodWriteup }] })]);
  const result = await runWork(makeJob({ resumeSessionId: "nothing-was-saved" }), collect().emit, { root, chat });

  assert.equal(result.stopReason, "submitted");
});

test("the clarifying call is one tool-free call, and unreadable answers mean nothing to ask", async () => {
  const { chat, sent } = scriptedChat([answer({ content: '{"questions": ["which one?", "  ", 7]}' })]);
  const { emit, lines } = collect();

  const result = await runAsk(makeJob({ mode: "ask", brief: "is this clear?", askMaxTokens: 64 }), emit, { chat });

  assert.deepEqual(result.questions, ["which one?"]);
  assert.equal(result.stopReason, "answered");
  assert.equal(result.totalCostUsd, 0.25);
  assert.equal("tools" in sent[0], false, "the clarifying call must offer no tools");
  assert.equal(sent[0].max_tokens, 64);
  assert.ok(lines.some((line) => line.t === "usage"));

  assert.deepEqual(questionsFrom("not json at all"), []);
  assert.deepEqual(questionsFrom('```json\n{"questions": ["fenced anyway"]}\n```'), ["fenced anyway"]);
  assert.deepEqual(questionsFrom('{"questions": []}'), []);
});

test("writeupProblem names the one thing wrong, and accepts a usable write-up", () => {
  const job = makeJob();
  assert.equal(writeupProblem(job, goodWriteup), undefined);
  assert.match(writeupProblem(job, { ...goodWriteup, what: "" }) ?? "", /what is required/);
  assert.match(writeupProblem(job, { ...goodWriteup, confidence: 101 }) ?? "", /0 to 100/);
  assert.match(writeupProblem(job, { ...goodWriteup, confidence: "high" }) ?? "", /0 to 100/);
  assert.equal(writeupProblem(job, { ...goodWriteup, title: "x".repeat(WRITEUP_TITLE_MAX_LENGTH) }), undefined);
});
