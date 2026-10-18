// The one HTTP call this adapter makes, against a real local server
// standing in for the provider (the same approach src/relay's own tests
// take with helpers/fake-provider.ts): what goes on the wire, what comes
// back, and what is retried.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { chatCompletion, usageFrom } from "./client.mjs";
import { writeupToolSchema } from "../openai-compatible.ts";
import { WRITEUP_OPTIONAL_STRING_FIELDS, WRITEUP_STRING_FIELDS, WRITEUP_TITLE_MAX_LENGTH } from "../../writeup.ts";
import type { AgentJob } from "./types.ts";

interface Seen {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  body: string;
}

async function fakeProvider(
  answers: { status: number; body: string }[]
): Promise<{ port: number; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const next = answers.shift() ?? { status: 200, body: JSON.stringify({ choices: [{ message: { content: "ok" } }] }) };
      res.writeHead(next.status, { "content-type": "application/json" });
      res.end(next.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the fake provider reported no port");
  return { port: address.port, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function job(port: number, overrides: Partial<AgentJob> = {}): AgentJob {
  return {
    mode: "work",
    brief: "b",
    model: "a-model",
    // A path prefix on the base URL, exactly as the default hosted
    // target has one ("/api/v1"), so this proves the call lands under it.
    endpoint: `http://127.0.0.1:${port}/api/v1`,
    apiKey: "fabrica-placeholder-abc",
    maxSpendUsd: 1,
    costSource: "reported",
    maxTurns: 4,
    sessionId: "s",
    writeupSchema: writeupToolSchema(),
    writeupStringFields: [...WRITEUP_STRING_FIELDS],
    writeupOptionalStringFields: [...WRITEUP_OPTIONAL_STRING_FIELDS],
    writeupTitleMaxLength: WRITEUP_TITLE_MAX_LENGTH,
    maxToolOutputChars: 100,
    bashTimeoutMs: 1_000,
    ...overrides,
  };
}

const answered = JSON.stringify({ choices: [{ message: { content: "hello" } }], usage: { cost: 0.5 } });

test("the call is a POST to <base>/chat/completions carrying the model, with the placeholder as a Bearer token", async (t) => {
  const provider = await fakeProvider([{ status: 200, body: answered }]);
  t.after(() => provider.close());

  const response = await chatCompletion(job(provider.port), { messages: [{ role: "user", content: "hi" }] });

  assert.deepEqual(response.usage, { cost: 0.5 });
  assert.equal(provider.seen.length, 1);
  assert.equal(provider.seen[0].method, "POST");
  assert.equal(provider.seen[0].url, "/api/v1/chat/completions");
  assert.equal(provider.seen[0].authorization, "Bearer fabrica-placeholder-abc");
  assert.deepEqual(JSON.parse(provider.seen[0].body), { model: "a-model", messages: [{ role: "user", content: "hi" }] });
});

test("a target that needs no credential is sent no Authorization header at all", async (t) => {
  const provider = await fakeProvider([{ status: 200, body: answered }]);
  t.after(() => provider.close());

  await chatCompletion(job(provider.port, { apiKey: null }), { messages: [] });

  assert.equal(provider.seen[0].authorization, undefined);
});

test('a "not now" answer is retried; a real refusal is reported as it stands', async (t) => {
  const provider = await fakeProvider([
    { status: 429, body: '{"error":"slow down"}' },
    { status: 200, body: answered },
  ]);
  t.after(() => provider.close());

  const slept: number[] = [];
  const response = await chatCompletion(job(provider.port), { messages: [] }, {
    sleepFn: async (ms: number) => void slept.push(ms),
  });

  assert.equal(provider.seen.length, 2);
  assert.equal(slept.length, 1, "the retry did not wait before trying again");
  assert.ok(Array.isArray(response.choices));
});

test("a refusal that is not worth retrying throws once, carrying the provider's own words", async (t) => {
  const provider = await fakeProvider([{ status: 401, body: '{"error":{"message":"No auth credentials found"}}' }]);
  t.after(() => provider.close());

  await assert.rejects(
    () => chatCompletion(job(provider.port), { messages: [] }),
    (err: Error) => err.message.includes("401") && err.message.includes("No auth credentials found")
  );
  assert.equal(provider.seen.length, 1, "a 401 must not be retried - the credential will not fix itself");
});

test("a 200 that carries no choices is reported, not handed on as an answer", async (t) => {
  const provider = await fakeProvider([{ status: 200, body: '{"error":{"message":"that model does not exist"}}' }]);
  t.after(() => provider.close());

  await assert.rejects(
    () => chatCompletion(job(provider.port), { messages: [] }),
    /no choices in the response/
  );
});

test("usage becomes a dollar figure only when the provider reported one, or the target bills nothing", () => {
  // The shape OpenRouter's usage-accounting doc documents (read 2026-10-17).
  const real = { cost: 0.0123, prompt_tokens: 194, completion_tokens: 2, total_tokens: 196 };
  assert.deepEqual(usageFrom(real, "reported"), { costUsd: 0.0123, promptTokens: 194, completionTokens: 2 });
  assert.deepEqual(usageFrom({ prompt_tokens: 1, completion_tokens: 2 }, "reported"), {
    costUsd: null,
    promptTokens: 1,
    completionTokens: 2,
  });
  assert.equal(usageFrom({ prompt_tokens: 1 }, "free").costUsd, 0);
  assert.equal(usageFrom(undefined, "reported").costUsd, null);
  assert.equal(usageFrom({ cost: "0.5" }, "reported").costUsd, null, "a cost that is not a number is unknown, not parsed");
  assert.equal(usageFrom({ cost: -1 }, "reported").costUsd, null);
});
