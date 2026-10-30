#!/usr/bin/env node
// A stand-in for the real `claude` binary as the code reader drives it
// (cli-reader.ts), used only by cli-reader.test.ts's fast tests. It talks
// to no model: it prints back a canned `--output-format json` result
// object chosen by a marker in the prompt it is handed on stdin, so those
// tests can prove the argument-building and answer-reading logic
// deterministically, with no credential, no network and no spend.
//
// The real binary's own answer shape is what this imitates, recorded from
// a live run (2.1.222, 2026-10-30) in ../claude-code.md's "Reading a diff
// through the host's own CLI". This file is not that proof - the opt-in
// real-binary test in cli-reader.test.ts is, and it says loudly when it
// did not run.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);

let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;

// Where the test reads back what this process was actually given - the
// argument list, the prompt, and the working directory it was started
// in - rather than trusting what the adapter says it passed.
const log = process.env.FAKE_CLI_READER_LOG;
if (log) {
  mkdirSync(log, { recursive: true });
  writeFileSync(join(log, "args.json"), JSON.stringify(args));
  writeFileSync(join(log, "prompt.txt"), prompt);
  writeFileSync(join(log, "cwd.txt"), process.cwd());
}

const result = (overrides) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: "fake-reader-session",
  total_cost_usd: 0.0123,
  duration_ms: 42,
  result: "",
  api_error_status: null,
  ...overrides,
});

const print = (object) => process.stdout.write(`${JSON.stringify(object)}\n`);

if (prompt.includes("SCENARIO_HANG")) {
  // Long enough that any test waiting on it has a timeout far shorter.
  setTimeout(() => {}, 600_000);
} else if (prompt.includes("SCENARIO_SILENT")) {
  process.stderr.write("the fake printed nothing on purpose\n");
  process.exit(1);
} else if (prompt.includes("SCENARIO_GARBAGE")) {
  process.stdout.write("this is not a result object\n");
} else if (prompt.includes("SCENARIO_ERROR_WITH_ANSWER")) {
  // A failure that carries something answer-shaped anyway: the failure
  // is what counts, which is the ordering cli-reader.ts pins.
  print(
    result({
      is_error: true,
      subtype: "error_during_execution",
      api_error_status: 401,
      result: "Invalid API key",
      structured_output: { findings: [] },
    })
  );
  process.exit(1);
} else if (prompt.includes("SCENARIO_ERROR")) {
  print(result({ is_error: true, subtype: "error_during_execution", result: "Credit balance is too low" }));
  process.exit(1);
} else if (prompt.includes("SCENARIO_NO_STRUCTURED")) {
  // The command giving up on the schema: no structured_output, but the
  // model's own text is there. Deliberately the pessimistic shape - a
  // non-zero exit and is_error set - since that is the combination
  // cli-reader.ts has to carve out, and a fake that only tried the kind
  // one would prove nothing.
  print({
    ...result({ subtype: "error_max_structured_output_retries", result: '```json\n{"findings": []}\n```' }),
    is_error: true,
  });
  process.exit(1);
} else if (prompt.includes("SCENARIO_FINDINGS")) {
  const findings = { findings: [{ file: "src/thing.ts", finding: "the error is swallowed" }] };
  print(result({ result: JSON.stringify(findings), structured_output: findings }));
} else {
  print(result({ result: '{"findings":[]}', structured_output: { findings: [] } }));
}
