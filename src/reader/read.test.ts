// Every test here replaces the transport wholesale - the HTTP one with a
// fake `post`, the command one with a stand-in script - so nothing in
// the default `npm test` run opens a socket, needs a credential, runs a
// real command, or waits on a retry delay.
//
// No vendor is named by hand anywhere in this file: the one vendor
// reached by a command comes from the adapter that owns the name
// (CONTRACT rule 8's scan covers test files too).

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_READER_VENDOR } from "../brain/index.ts";
import { askReader } from "./call.ts";
import type { PostJson } from "./call.ts";
import { MAX_DIFF_BYTES, parseFindings, readDiff, readerLabel } from "./read.ts";
import type { ApiReader, CommandReader } from "./types.ts";

const READER: ApiReader = {
  via: "api",
  vendor: "close-reader",
  model: "reader-1",
  apiKeyVar: "CLOSE_READER_API_KEY",
  apiKey: "the-key",
  baseUrlVar: "CLOSE_READER_BASE_URL",
  baseUrl: "https://example.invalid/v1",
};

/** A transport that answers one fixed body and records what it was
 * asked, so the request's own shape is asserted on and not assumed. */
function answering(body: unknown, status = 200) {
  const seen: { url?: string; headers?: Record<string, string>; body?: string } = {};
  const post: PostJson = async (url, headers, requestBody) => {
    seen.url = url;
    seen.headers = headers;
    seen.body = requestBody;
    return { status, body: typeof body === "string" ? body : JSON.stringify(body) };
  };
  return { post, seen };
}

function content(text: string): unknown {
  return { choices: [{ message: { content: text } }] };
}

const NO_WAIT = { sleepFn: async () => undefined };

test("the request is a chat-completions POST carrying the model and a Bearer token", async () => {
  const { post, seen } = answering(content("hi"));

  const answer = await askReader(READER, [{ role: "user", content: "read this" }], { post, ...NO_WAIT });

  assert.equal(answer, "hi");
  assert.equal(seen.url, "https://example.invalid/v1/chat/completions");
  assert.equal(seen.headers?.authorization, "Bearer the-key");
  assert.equal(seen.headers?.["content-type"], "application/json");
  const sent = JSON.parse(seen.body!);
  assert.equal(sent.model, "reader-1");
  assert.deepEqual(sent.messages, [{ role: "user", content: "read this" }]);
});

test("a trailing slash on the base URL does not double up the path", async () => {
  const { post, seen } = answering(content("hi"));
  await askReader({ ...READER, baseUrl: "https://example.invalid/v1/" }, [{ role: "user", content: "x" }], {
    post,
    ...NO_WAIT,
  });
  assert.equal(seen.url, "https://example.invalid/v1/chat/completions");
});

test("a 401 is a real answer and is reported, never retried", async () => {
  let calls = 0;
  const post: PostJson = async () => {
    calls++;
    return { status: 401, body: '{"error":"bad key"}' };
  };

  await assert.rejects(() => askReader(READER, [{ role: "user", content: "x" }], { post, ...NO_WAIT }), /answered 401/);
  assert.equal(calls, 1, "a 401 was retried");
});

test("a 429 is retried, and a later success is the answer", async () => {
  let calls = 0;
  const post: PostJson = async () => {
    calls++;
    if (calls === 1) return { status: 429, body: "slow down" };
    return { status: 200, body: JSON.stringify(content("second time")) };
  };

  assert.equal(await askReader(READER, [{ role: "user", content: "x" }], { post, ...NO_WAIT }), "second time");
  assert.equal(calls, 2);
});

test("no credential is ever repeated in a failure message", async () => {
  const post: PostJson = async () => {
    throw new Error("socket hang up");
  };

  await assert.rejects(
    () => askReader(READER, [{ role: "user", content: "x" }], { post, ...NO_WAIT }),
    (err: Error) => {
      assert.ok(!err.message.includes("the-key"), `the key leaked into: ${err.message}`);
      assert.match(err.message, /could not reach the reader's model/);
      return true;
    }
  );
});

test("a 200 carrying an error object instead of choices is reported", async () => {
  const { post } = answering({ error: { message: "no such model" } });
  await assert.rejects(
    () => askReader(READER, [{ role: "user", content: "x" }], { post, ...NO_WAIT }),
    /answered no choices/
  );
});

test("findings come back as the reader named them", async () => {
  const { post } = answering(
    content('{"findings":[{"file":"src/a.ts","finding":"the error is swallowed"}]}')
  );

  const report = await readDiff(READER, "diff --git a/src/a.ts b/src/a.ts\n+x\n", { post, ...NO_WAIT });

  assert.equal(report.model, "close-reader/reader-1");
  assert.deepEqual(report.findings, [{ file: "src/a.ts", finding: "the error is swallowed" }]);
  assert.equal(report.diffBytes, Buffer.byteLength("diff --git a/src/a.ts b/src/a.ts\n+x\n", "utf8"));
});

test("an empty findings list is a clean read, not a failure", async () => {
  const { post } = answering(content('{"findings": []}'));
  const report = await readDiff(READER, "a diff", { post, ...NO_WAIT });
  assert.deepEqual(report.findings, []);
});

test("an empty diff is a clean read and never calls the model", async () => {
  let calls = 0;
  const post: PostJson = async () => {
    calls++;
    return { status: 200, body: "{}" };
  };

  const report = await readDiff(READER, "", { post, ...NO_WAIT });
  assert.deepEqual(report.findings, []);
  assert.equal(report.diffBytes, 0);
  assert.equal(calls, 0, "the model was called about an empty diff");
});

test("a diff past the ceiling is refused naming both numbers, and nothing is read", async () => {
  let calls = 0;
  const post: PostJson = async () => {
    calls++;
    return { status: 200, body: "{}" };
  };
  const huge = "x".repeat(MAX_DIFF_BYTES + 1);

  await assert.rejects(() => readDiff(READER, huge, { post, ...NO_WAIT }), (err: Error) => {
    assert.match(err.message, new RegExp(String(MAX_DIFF_BYTES)));
    assert.match(err.message, new RegExp(String(MAX_DIFF_BYTES + 1)));
    assert.match(err.message, /rather than trimmed/);
    return true;
  });
  assert.equal(calls, 0);
});

test("readerLabel names the vendor and the model in the Client's own spelling", () => {
  assert.equal(readerLabel(READER), "close-reader/reader-1");
});

// Issue #315: the other way a reader can be reached. A stand-in script
// stands where the real command would, so these prove the dispatch and
// the report without running anything real - the command's own argument
// building and answer reading are proven where they live
// (src/brain/adapters/cli-reader.test.ts).
const COMMAND_READER: CommandReader = {
  via: "command",
  vendor: CLI_READER_VENDOR,
  model: "reader-1",
  command: "the-command",
};

/** A script that records the prompt it was handed and answers with one
 * result object, the shape the command this vendor uses prints. */
function standInCommand(structured: unknown): { command: string; prompt: () => string } {
  const dir = mkdtempSync(join(tmpdir(), "fabrica-reader-command-"));
  const promptFile = join(dir, "prompt.txt");
  const command = join(dir, "stand-in.sh");
  writeFileSync(
    command,
    `#!/bin/sh\ncat > ${promptFile}\nprintf '%s\\n' '${JSON.stringify({
      type: "result",
      is_error: false,
      result: JSON.stringify(structured),
      structured_output: structured,
    })}'\n`
  );
  chmodSync(command, 0o755);
  return { command, prompt: () => readFileSync(promptFile, "utf8") };
}

test("a reader reached by a command produces the same report, with no endpoint and no key in sight", async () => {
  const { command, prompt } = standInCommand({ findings: [{ file: "src/a.ts", finding: "the retry never ends" }] });
  // A transport that would fail the test if the command path reached for
  // it: this read must make no HTTP call at all.
  const post: PostJson = async () => {
    throw new Error("the command reader made an HTTP call");
  };
  const diff = "diff --git a/src/a.ts b/src/a.ts\n+x\n";

  const report = await readDiff(COMMAND_READER, diff, { command, post, ...NO_WAIT });

  assert.equal(report.model, `${CLI_READER_VENDOR}/reader-1`);
  assert.deepEqual(report.findings, [{ file: "src/a.ts", finding: "the retry never ends" }]);
  assert.equal(report.diffBytes, Buffer.byteLength(diff, "utf8"));
  // The same instruction and the same diff an API-keyed vendor is sent.
  assert.match(prompt(), /You are a code reader/);
  assert.ok(prompt().includes(diff), "the whole diff never reached the command");
});

test("an empty diff never runs the command either", async () => {
  const { command } = standInCommand({ findings: [{ file: "a.ts", finding: "never asked" }] });

  const report = await readDiff(COMMAND_READER, "", { command, ...NO_WAIT });

  assert.deepEqual(report.findings, [], "a command was asked about an empty diff");
  assert.equal(report.diffBytes, 0);
});

test("fenced JSON with prose in front of it still parses", () => {
  const answer = [
    "Sure - here is what I found.",
    "```json",
    '{"findings": [{"file": "a.ts", "finding": "off by one"}]}',
    "```",
  ].join("\n");

  assert.deepEqual(parseFindings(answer), [{ file: "a.ts", finding: "off by one" }]);
});

test("a brace inside a finding's own text does not end the object early", () => {
  const answer = '{"findings":[{"file":"a.ts","finding":"the `{ ok: true }` branch is unreachable"}]}';
  assert.deepEqual(parseFindings(answer), [
    { file: "a.ts", finding: "the `{ ok: true }` branch is unreachable" },
  ]);
});

test("an answer with no findings array is a failure, never a clean read", () => {
  assert.throws(() => parseFindings("I had a look and it all seems fine to me."), /no JSON object/);
  assert.throws(() => parseFindings('{"verdict": "looks good"}'), /no "findings" array/);
});

test("a half-finding is refused rather than handed to a worker to guess at", () => {
  assert.throws(() => parseFindings('{"findings":[{"file":"a.ts"}]}'), /missing a file or a finding/);
  assert.throws(() => parseFindings('{"findings":[{"finding":"something"}]}'), /missing a file or a finding/);
});
