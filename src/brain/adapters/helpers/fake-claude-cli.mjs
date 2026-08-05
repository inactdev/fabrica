#!/usr/bin/env node
// A stand-in for the real `claude` binary, used only by
// claude-code.test.ts's fast unit tests. It does not talk to any model -
// it prints back canned `--output-format stream-json` lines chosen by
// the scenario name in `brief` (the string right after `-p`), so those
// tests can prove the adapter's argument-building, transcript-mapping,
// and error-mapping logic deterministically, without the cost or
// flakiness of a real call. The real binary is proven separately in
// claude-code.test.ts's real-binary test - this file is not that proof.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const brief = args[args[0] === "-p" ? 1 : args.indexOf("-p") + 1];

function line(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

const resultLine = (overrides) => ({
  type: "result",
  is_error: false,
  session_id: "fake-session-123",
  total_cost_usd: 0.0421,
  duration_ms: 1234,
  usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 },
  result: "done",
  ...overrides,
});

switch (brief) {
  case "ECHO_ARGS": {
    line({ type: "assistant", message: { content: [{ type: "text", text: JSON.stringify(args) }] } });
    line(resultLine({}));
    break;
  }
  case "SUCCESS_WITH_TOOLS": {
    line({ type: "system", subtype: "init" }); // noise the adapter must skip
    line({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "checking the file first" },
          { type: "tool_use", name: "Bash", input: { command: "cat hello.txt" } },
        ],
      },
    });
    line({
      type: "user",
      message: { content: [{ type: "tool_result", content: "hello from spike", is_error: false }] },
    });
    line({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } });
    line(resultLine({}));
    break;
  }
  case "FAIL_EXIT_NONZERO_NO_JSON": {
    process.stderr.write("No conversation found with session ID: bogus\n");
    process.exitCode = 1;
    break;
  }
  case "FAIL_EXIT_NONZERO_WITH_JSON": {
    line(resultLine({ is_error: true, api_error_status: 404, result: "model not found", total_cost_usd: 0 }));
    process.exitCode = 1;
    break;
  }
  case "SUCCESS_NO_RESULT_LINE": {
    line({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } });
    break;
  }
  case "TRY_READ_DECOY": {
    // Attempts to read a path named by an env var, so
    // claude-code.test.ts's containment-wiring test can prove that
    // `contained: true` really is confining THIS process end to end,
    // not just the standalone runContained() primitive.
    let text;
    try {
      text = readFileSync(process.env.FABRICA_TEST_DECOY_PATH, "utf8");
    } catch {
      text = null;
    }
    line({
      type: "assistant",
      message: { content: [{ type: "text", text: text === null ? "READ_BLOCKED" : `READ_SUCCEEDED:${text}` }] },
    });
    line(resultLine({}));
    break;
  }
  case "SESSION_MARKER": {
    // Reports whatever a previous call already left under $HOME, then
    // adds its own mark - so claude-code.test.ts's session-persistence
    // test can prove a second work() call for the same task sees the
    // first call's state, even though each call is its own fresh
    // container with nothing else surviving between them.
    const markerPath = join(process.env.HOME ?? "/", "marker.txt");
    let seenBefore = "";
    try {
      seenBefore = readFileSync(markerPath, "utf8");
    } catch {
      // No prior marker - this is the first call for this $HOME.
    }
    writeFileSync(markerPath, `${seenBefore}call;`);
    // Prefixed so this is never an empty string - toTranscript() drops
    // an assistant "text" block whose text is falsy, which would
    // otherwise make the very case with nothing to report disappear
    // from the transcript entirely instead of asserting on it.
    line({ type: "assistant", message: { content: [{ type: "text", text: `SEEN:${seenBefore}` }] } });
    line(resultLine({}));
    break;
  }
  default: {
    line(resultLine({}));
  }
}
