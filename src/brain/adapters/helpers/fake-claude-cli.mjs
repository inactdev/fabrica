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

// The session-init line, as the real binary emits it: mostly chatter the
// adapter skips, except `model` - the model this run actually resolved
// to, which the adapter reports onto the receipt (issue #184). The
// value follows whatever `--model` asked for, the way the real binary's
// does, and falls back to a stand-in for "whatever this install's own
// configuration resolves to" when nothing asked.
const initLine = () => {
  const asked = args[args.indexOf("--model") + 1];
  return {
    type: "system",
    subtype: "init",
    session_id: "fake-session-123",
    model: args.includes("--model") && asked !== undefined ? asked : "fake-configured-model",
  };
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const resultLine = (overrides) => ({
  type: "result",
  is_error: false,
  session_id: "fake-session-123",
  total_cost_usd: 0.0421,
  duration_ms: 1234,
  usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 },
  result: "done",
  // The real binary always emits this key, null on a successful call -
  // see fake-claude-cli.test.ts's shape-parity test, which caught this
  // field's earlier absence here as drift from the real shape.
  api_error_status: null,
  ...overrides,
});

// ask()'s prompt wraps the caller's marker task text inside a longer,
// fixed template (buildAskPrompt in ../claude-code.ts) rather than
// passing it as `brief` directly, so these scenarios match by substring
// instead of the exact-equality switch below.
if (brief?.includes("PRINT_ENV")) {
  // Matched by substring, same as the ASK_SCENARIO_* cases below, so
  // ask() - whose brief is PRINT_ENV wrapped inside buildAskPrompt's
  // fixed template - reaches this exact same scenario as work() does.
  // work()'s own test reads the transcript entry below; ask() has no
  // transcript at all (BrainAskResult only ever reports questions/cost),
  // so its test instead reads the file this writes into cwd - /workdir
  // inside the container, which is always the caller's own workdir/
  // scratch dir on the host side of the bind mount.
  writeFileSync(join(process.cwd(), "env-dump.json"), JSON.stringify(process.env));
  line({ type: "assistant", message: { content: [{ type: "text", text: JSON.stringify(process.env) }] } });
  line(resultLine({}));
  // Issue #176's fixed shape: one question with two to four options,
  // which is what buildAskPrompt now asks a real model for.
} else if (brief?.includes("ASK_SCENARIO_QUESTION")) {
  line(resultLine({ result: JSON.stringify({ question: "What database?", options: ["Postgres", "SQLite"] }) }));
} else if (brief?.includes("ASK_SCENARIO_NONE")) {
  line(resultLine({ result: JSON.stringify({ question: null }) }));
} else if (brief?.includes("ASK_SCENARIO_FENCED")) {
  line(
    resultLine({
      result: "```json\n" + JSON.stringify({ question: "Fenced question?", options: ["Yes", "No"] }) + "\n```",
    })
  );
  // A machine still sending the old free-form list: handed back as-is so
  // the Foreman rejects it by name and has it ask again, rather than the
  // adapter quietly reading it as "nothing to ask".
} else if (brief?.includes("ASK_SCENARIO_FREE_FORM")) {
  line(resultLine({ result: JSON.stringify({ questions: ["Real question?", "  ", 7] }) }));
} else if (brief?.includes("ASK_SCENARIO_GARBLED")) {
  line(resultLine({ result: "sure, sounds good, proceeding now" }));
} else {
switch (brief) {
  case "ECHO_ARGS": {
    line({ type: "assistant", message: { content: [{ type: "text", text: JSON.stringify(args) }] } });
    line(resultLine({}));
    break;
  }
  case "SUCCESS_WITH_TOOLS": {
    line(initLine()); // chatter the adapter skips, except its `model`
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
  case "BUDGET_EXHAUSTED": {
    // The real binary's shape when --max-budget-usd runs out (verified
    // on 2.1.295): exit 1, is_error true, no "result" text, and the real
    // cost, already past the budget.
    line({ type: "assistant", message: { content: [{ type: "text", text: "Starting." }] } });
    const { result: _result, ...rest } = resultLine({
      is_error: true,
      subtype: "error_max_budget_usd",
      total_cost_usd: 0.1427,
      errors: ["Reached maximum budget ($0.1)"],
    });
    line(rest);
    process.exitCode = 1;
    break;
  }
  case "SUCCESS_NO_RESULT_LINE": {
    line({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } });
    break;
  }
  case "TRY_READ_DECOY": {
    // Attempts to read a path named by an env var, so
    // claude-code.test.ts's containment-wiring test can prove the
    // adapter really does confine THIS process end to end - containment
    // is unconditional, so the read must fail no matter how work() is
    // called, not just when the standalone runContained() primitive is
    // exercised on its own.
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
  case "WRITEUP_STRUCTURED": {
    // --json-schema's answer arrives as an object on the result line
    // (verified on 2.1.222: "structured_output", subtype "success"), with
    // the same object JSON-encoded in "result".
    const writeup = {
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
    };
    line({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } });
    line(resultLine({ result: JSON.stringify(writeup), structured_output: writeup }));
    break;
  }
  case "WRITEUP_AS_PROSE_ONLY": {
    // A write-up typed out as text, with no structured_output: nothing
    // may be parsed out of it.
    const prose =
      "Fake write-up\n\n## Context (Why)\n\nb\n\n## Description (What)\n\na\n\n" +
      "## Changes in the codebase (How)\n\nc\n\n## Changes outside the codebase\n\nNone.";
    line({ type: "assistant", message: { content: [{ type: "text", text: prose } ] } });
    line(resultLine({ result: prose }));
    break;
  }
  case "WRITEUP_RETRIES_EXHAUSTED": {
    // The CLI gave up making its answer match the schema.
    line({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } });
    process.exitCode = 1;
    line(resultLine({ is_error: true, subtype: "error_max_structured_output_retries", result: undefined }));
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
  case "LIVE_STREAM_DELAYED": {
    // Three entries with real pauses between them (issue #70), so a test
    // can prove a transcript entry reaches the live listener - and from
    // there, disk - while this call is still running, well before this
    // scenario's later entries are even emitted, rather than all landing
    // together only once the whole call finishes.
    line({ type: "assistant", message: { content: [{ type: "text", text: "first" }] } });
    await sleep(300);
    line({ type: "assistant", message: { content: [{ type: "text", text: "second" }] } });
    await sleep(300);
    line({ type: "assistant", message: { content: [{ type: "text", text: "third" }] } });
    line(resultLine({}));
    break;
  }
  default: {
    line(resultLine({}));
  }
}
}
