// The code reader that goes through a command on this machine instead of
// an API key (issue #315).
//
// Everything below the real-binary test runs against a fake binary
// (helpers/fake-cli-reader.mjs) and so needs no credential, no network
// and no Docker - this call runs on the host by design. The one thing a
// fake cannot prove is that the real binary still answers in the shape
// this file reads, so that is its own test, opt-in because it spends
// real money, and this file says loudly when it did not run (see
// README.md's "A loud skip, not a silent one").

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCliReaderArgs,
  cliReaderFor,
  cliReaderPrompt,
  findCommandOnPath,
  CLI_READER_COMMAND,
  CLI_READER_VENDOR,
} from "./cli-reader.ts";
import { FINDINGS_JSON_SCHEMA, parseFindings } from "../../reader/read.ts";
// Test-only, and the whole point of the parity test below: the other
// module keeping the same ten-line PATH lookup for its own binary.
import { commandIsInstalled } from "../../inspector/index.ts";

const FAKE_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "helpers", "fake-cli-reader.mjs");

let realBinaryCheckRan = false;
let realBinarySkipReason: string | null = null;

after(() => {
  if (realBinaryCheckRan) return;
  console.error(
    [
      "",
      "!".repeat(78),
      "!! REAL-BINARY READ DID NOT RUN",
      "!! This run never asked the real reader command for a real read.",
      `!! Reason: ${realBinarySkipReason ?? "unknown"}`,
      "!! A green run here does NOT mean the fake still resembles reality -",
      '!! see src/brain/adapters/claude-code.md, "Reading a diff through the',
      '!! host\'s own CLI", for what was verified and when.',
      "!".repeat(78),
      "",
    ].join("\n")
  );
});

/** A copy of the fake, executable, plus the directory it records what it
 * was given into. */
function fakeCommand(): { command: string; log: string; read: (name: string) => string } {
  const dir = mkdtempSync(join(tmpdir(), "fabrica-fake-reader-"));
  const command = join(dir, "fake-cli-reader.mjs");
  copyFileSync(FAKE_SOURCE, command);
  chmodSync(command, 0o755);
  const log = join(dir, "log");
  return { command, log, read: (name) => readFileSync(join(log, name), "utf8") };
}

const MODEL = "some-reading-model";

function ask(prompt: string, log: string, command: string, timeoutMs?: number): Promise<string> {
  const vendor = cliReaderFor(CLI_READER_VENDOR);
  assert.ok(vendor, "the vendor this file is about is not served");
  return vendor.ask({
    model: MODEL,
    messages: [
      { role: "system", content: "You are a code reader." },
      { role: "user", content: prompt },
    ],
    schema: FINDINGS_JSON_SCHEMA,
    command,
    env: { ...process.env, FAKE_CLI_READER_LOG: log },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

test("only this vendor's own spelling is served, and the command it needs is named", () => {
  const vendor = cliReaderFor(CLI_READER_VENDOR);
  assert.ok(vendor);
  assert.equal(vendor.command, CLI_READER_COMMAND);
  assert.equal(vendor.vendor, CLI_READER_VENDOR);
  // The Client writes this by hand into projects.toml, so it is read the
  // way a person reads it.
  assert.ok(cliReaderFor(`  ${CLI_READER_VENDOR.toUpperCase()} `), "a hand-written spelling was not recognised");
  assert.equal(cliReaderFor("some-other-vendor"), undefined);
  assert.equal(cliReaderFor(""), undefined);
});

test("where the command is - or which way it is missing - is answered from PATH, without running anything", () => {
  const vendor = cliReaderFor(CLI_READER_VENDOR);
  assert.ok(vendor);
  const dir = mkdtempSync(join(tmpdir(), "fabrica-reader-path-"));
  const planted = join(dir, CLI_READER_COMMAND);
  // An executable that would fail loudly if it were ever run: the lookup
  // must not run it.
  writeFileSync(planted, "#!/bin/sh\nexit 73\n");
  chmodSync(planted, 0o755);

  assert.deepEqual(vendor.locate({ PATH: dir }), { found: true, path: planted });
  assert.deepEqual(vendor.locate({ PATH: join(dir, "nowhere") }), { found: false, why: "missing" });
  assert.deepEqual(vendor.locate({}), { found: false, why: "missing" }, "no PATH read as installed");

  // There, and not runnable: a different problem with a different fix,
  // so it is reported as itself and the file is named. A refusal saying
  // "not on PATH" about this would send the Client to install something
  // he already has.
  chmodSync(planted, 0o644);
  assert.deepEqual(vendor.locate({ PATH: dir }), { found: false, why: "not-executable", path: planted });

  // An earlier directory holding an unusable copy never hides a usable
  // one further along PATH.
  const second = mkdtempSync(join(tmpdir(), "fabrica-reader-path-"));
  const usable = join(second, CLI_READER_COMMAND);
  writeFileSync(usable, "#!/bin/sh\nexit 73\n");
  chmodSync(usable, 0o755);
  assert.deepEqual(vendor.locate({ PATH: `${dir}:${second}` }), { found: true, path: usable });
});

// The PATH lookup above is a second copy of the one Inspector's own
// module keeps for its own binary, kept deliberately (a brain adapter
// has no business depending on that module) - so what stops the two
// quietly disagreeing is this: the same questions, both answerers, one
// assertion. The import is test-only, the same arrangement
// src/line/helpers/fixture.ts has with contract/helpers.
test("the copied PATH lookup still answers exactly as the one Inspector's module keeps", () => {
  const dir = mkdtempSync(join(tmpdir(), "fabrica-reader-parity-"));
  const runnable = join(dir, "runnable");
  const plain = join(dir, "plain");
  writeFileSync(runnable, "#!/bin/sh\nexit 0\n");
  chmodSync(runnable, 0o755);
  writeFileSync(plain, "not executable\n");
  chmodSync(plain, 0o644);

  const cases: { command: string; env: NodeJS.ProcessEnv }[] = [
    { command: "runnable", env: { PATH: dir } },
    { command: "plain", env: { PATH: dir } },
    { command: "absent", env: { PATH: dir } },
    { command: "runnable", env: {} },
    { command: runnable, env: {} },
    { command: plain, env: {} },
    { command: join(dir, "absent"), env: { PATH: dir } },
    { command: "runnable", env: { PATH: `${join(dir, "nowhere")}:${dir}` } },
  ];

  for (const { command, env } of cases) {
    assert.equal(
      findCommandOnPath(command, env).found,
      commandIsInstalled(command, env),
      `the two lookups disagree about \`${command}\` with PATH=${env.PATH ?? ""}`
    );
  }
});

test("the command line is the verified flag set: one result object, the schema, no tools, the model", () => {
  const args = buildCliReaderArgs({ model: MODEL, messages: [], schema: FINDINGS_JSON_SCHEMA });

  assert.deepEqual(args, [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(FINDINGS_JSON_SCHEMA),
    "--tools",
    "",
    "--model",
    MODEL,
  ]);
  // A read edits nothing and continues nothing, so neither flag belongs
  // here - and a cap would turn a read into a trimmed one.
  assert.ok(!args.includes("--permission-mode"));
  assert.ok(!args.includes("--resume"));
  assert.ok(!args.includes("--max-budget-usd"));
});

test("the prompt goes on stdin, never in the argument list: a whole diff cannot fit there", async () => {
  const { command, log, read } = fakeCommand();
  // Comfortably past Linux's 128 KiB ceiling on one argv string, well
  // inside the 1 MB a read is allowed.
  const diff = `SCENARIO_CLEAN\n${"+ a line of diff\n".repeat(20_000)}`;

  await ask(diff, log, command);

  const args = JSON.parse(read("args.json")) as string[];
  assert.ok(
    args.every((arg) => !arg.includes("SCENARIO_CLEAN")),
    "the prompt was passed as an argument"
  );
  assert.ok(read("prompt.txt").includes(diff), "the prompt never reached stdin");
});

test("both messages reach the model, in order, as the one prompt this command takes", async () => {
  const { command, log, read } = fakeCommand();

  await ask("SCENARIO_CLEAN the diff itself", log, command);

  assert.equal(
    read("prompt.txt"),
    cliReaderPrompt([{ content: "You are a code reader." }, { content: "SCENARIO_CLEAN the diff itself" }])
  );
});

test("the call runs in a fresh empty directory, not wherever Fabrica is standing", async () => {
  const { command, log, read } = fakeCommand();

  await ask("SCENARIO_CLEAN", log, command);

  const cwd = read("cwd.txt");
  assert.notEqual(cwd, process.cwd());
  // Gone again afterwards, and nothing of this repository was visible
  // from it while it existed.
  assert.deepEqual(readdirSync(tmpdir()).filter((name) => name === cwd), []);
});

test("a structured answer comes back as the findings JSON the reader's own parser reads", async () => {
  const { command, log } = fakeCommand();

  const clean = await ask("SCENARIO_CLEAN", log, command);
  assert.deepEqual(parseFindings(clean), []);

  const flagged = await ask("SCENARIO_FINDINGS", log, command);
  assert.deepEqual(parseFindings(flagged), [{ file: "src/thing.ts", finding: "the error is swallowed" }]);
});

test("a command that gave up on the schema hands back its own text, for the reader to read or reject", async () => {
  const { command, log } = fakeCommand();

  // Non-zero exit and `is_error` set, which is the combination this
  // carve-out exists for: the model did the reading, only the shape went
  // wrong, and losing that answer would be losing real work.
  const answer = await ask("SCENARIO_NO_STRUCTURED", log, command);

  // Fenced, with no structured answer at all - exactly what the
  // reader's tolerant-wrapping parser exists for.
  assert.match(answer, /```json/);
  assert.deepEqual(parseFindings(answer), []);
});

test("a failed call is an error written for the Client, naming what the command said", async () => {
  const { command, log } = fakeCommand();

  await assert.rejects(
    () => ask("SCENARIO_ERROR", log, command),
    (err: Error) => {
      assert.match(err.message, /Credit balance is too low/);
      assert.match(err.message, /error_during_execution/);
      return true;
    }
  );
});

test("a failure that carries an answer anyway is still a failure, never a clean read", async () => {
  const { command, log } = fakeCommand();

  await assert.rejects(
    () => ask("SCENARIO_ERROR_WITH_ANSWER", log, command),
    (err: Error) => {
      assert.match(err.message, /Invalid API key/);
      assert.match(err.message, /api_error_status 401/);
      return true;
    }
  );
});

test("output that is not a result object, and no output at all, each fail the read saying so", async () => {
  const { command, log } = fakeCommand();

  await assert.rejects(
    () => ask("SCENARIO_GARBAGE", log, command),
    (err: Error) => {
      assert.match(err.message, /not a result object/);
      assert.match(err.message, /this is not a result object/);
      return true;
    }
  );
  await assert.rejects(
    () => ask("SCENARIO_SILENT", log, command),
    (err: Error) => {
      assert.match(err.message, /printed nothing/);
      assert.match(err.message, /the fake printed nothing on purpose/);
      return true;
    }
  );
});

test("a command that never answers is given up on, naming the wait", async () => {
  const { command, log } = fakeCommand();

  await assert.rejects(
    () => ask("SCENARIO_HANG", log, command, 300),
    (err: Error) => {
      assert.match(err.message, /gave no answer within 300ms/);
      return true;
    }
  );
});

test("a command that is not there is said plainly, not reported as the model's failure", async () => {
  const { command, log } = fakeCommand();
  rmSync(command);

  await assert.rejects(
    () => ask("SCENARIO_CLEAN", log, command),
    (err: Error) => {
      assert.match(err.message, /could not run the reader's command/);
      assert.match(err.message, /ENOENT/);
      // The code alone is not an explanation: this one means the machine
      // changed since the task was allowed to start, and it says so.
      assert.match(err.message, /PATH when the task started/);
      return true;
    }
  );
});

test("a command that is there but cannot be run says that, not that it is missing", async () => {
  const { command, log } = fakeCommand();
  chmodSync(command, 0o644);

  await assert.rejects(
    () => ask("SCENARIO_CLEAN", log, command),
    (err: Error) => {
      assert.match(err.message, /EACCES/);
      assert.match(err.message, /chmod \+x/);
      assert.ok(!/not there/.test(err.message), `a permissions problem reported as a missing command: ${err.message}`);
      return true;
    }
  );
});

// The one thing the fake above cannot prove: that the real command still
// answers a schema-shaped question in the shape this adapter reads
// (`structured_output` on a single `--output-format json` result object,
// with all tools off and the prompt on stdin). Opt-in, like
// openai-compatible.test.ts's real-provider check and
// claude-code.test.ts's real-binary test, because it spends real money
// and needs a signed-in install this repo must never hold.
test("the real command answers a real read in the shape this adapter reads", async (t) => {
  const vendor = cliReaderFor(CLI_READER_VENDOR);
  assert.ok(vendor);
  if (process.env.FABRICA_TEST_REAL_READER !== "1") {
    realBinarySkipReason = "FABRICA_TEST_REAL_READER is not 1 (a real read spends real money)";
    return t.skip(realBinarySkipReason);
  }
  if (!vendor.locate(process.env).found) {
    realBinarySkipReason = `${vendor.command} is not on PATH`;
    return t.skip(realBinarySkipReason);
  }

  const answer = await vendor.ask({
    model: process.env.FABRICA_TEST_REAL_READER_MODEL ?? "sonnet",
    messages: [
      { role: "system", content: "You are a code reader. Flag what a reviewer should look at, and nothing else." },
      {
        role: "user",
        content:
          "Here is the whole diff of the change.\n\n" +
          "--- a/pay.ts\n+++ b/pay.ts\n@@\n-  return total\n+  return total * rate\n",
      },
    ],
    schema: FINDINGS_JSON_SCHEMA,
  });

  // Not what it found - that is the model's business - only that the
  // answer is a findings list this repository can read.
  assert.ok(Array.isArray(parseFindings(answer)), `the real read was unreadable: ${answer}`);
  realBinaryCheckRan = true;
});
