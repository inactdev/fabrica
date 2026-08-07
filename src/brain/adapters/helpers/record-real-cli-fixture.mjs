#!/usr/bin/env node
// Re-records fixtures/real-claude-cli-sample.jsonl from the real `claude`
// binary. Run this by hand, never in CI, whenever there's reason to think
// the real CLI's stream-json shape has legitimately changed (a version
// bump, a changelog entry, or fake-claude-cli.test.ts's shape-parity test
// failing against the current fixture with a diff that looks like a real
// rename/removal rather than a bug in this script).
//
// Requires an authenticated `claude` on this machine's PATH (`claude auth
// status` reporting loggedIn: true). Costs one real, small API call.
//
//   node src/brain/adapters/helpers/record-real-cli-fixture.mjs
//
// It drives the real binary once, in a disposable temp directory, on a
// fixed prompt chosen to exercise the same shapes the adapter reads: an
// assistant text turn, a tool_use turn, its tool_result, a final assistant
// text turn, and the terminal "result" line. It then strips every field
// that isn't either (a) structurally load-bearing for the shape-parity
// test or (b) needed to keep the file readable as an example - in
// particular anything that would leak this machine's paths, session ids,
// or account details (see sanitizeLine below for the exact list).
//
// After running, read the diff before committing: `git diff` on the
// fixture should show only fields the adapter's own claude-code.ts/.md
// document reading, not a wholesale reshuffle - a fixture that changes in
// ways nothing here reads is a sign this script over-recorded, not that
// the real CLI actually changed.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "real-claude-cli-sample.jsonl"
);

const PROMPT =
  "Read the file sample.txt in the current directory and then say back exactly what it contains, prefixed with GOT:";

function sanitizeLine(raw) {
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null; // never expected from real stream-json; drop defensively, same as the adapter does.
  }

  // Harness/session chatter (hook_started, hook_response, hook_progress,
  // rate_limit_event) is dropped by the adapter's own toTranscript() and
  // carries the most machine-specific content (this environment's own
  // hook output) - excluded entirely rather than sanitized field by
  // field.
  if (obj.type === "system" && obj.subtype !== "init") return null;
  if (obj.type === "rate_limit_event") return null;

  if (obj.type === "system" && obj.subtype === "init") {
    // Only the fact that a "system" line exists and gets dropped matters
    // to the adapter - keep a minimal, generic version instead of this
    // machine's real cwd, session id, installed skills/agents, and MCP
    // server list.
    return { type: "system", subtype: "init", cwd: "/workdir", session_id: "fixture-session" };
  }

  if (obj.type === "assistant" || obj.type === "user") {
    return {
      type: obj.type,
      message: { role: obj.message?.role ?? obj.type, content: sanitizeContent(obj.message?.content ?? []) },
      session_id: "fixture-session",
    };
  }

  if (obj.type === "result") {
    return {
      type: "result",
      is_error: obj.is_error,
      session_id: "fixture-session",
      total_cost_usd: obj.total_cost_usd,
      duration_ms: obj.duration_ms,
      usage: {
        input_tokens: obj.usage?.input_tokens,
        output_tokens: obj.usage?.output_tokens,
        cache_read_input_tokens: obj.usage?.cache_read_input_tokens,
        cache_creation_input_tokens: obj.usage?.cache_creation_input_tokens,
      },
      result: obj.result,
      api_error_status: obj.api_error_status ?? null,
    };
  }

  return null;
}

function sanitizeContent(blocks) {
  return blocks.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "thinking") return { type: "thinking", thinking: block.thinking };
    if (block.type === "tool_use") return { type: "tool_use", name: block.name, input: block.input };
    if (block.type === "tool_result") {
      const out = { type: "tool_result", content: block.content };
      if (block.is_error !== undefined) out.is_error = block.is_error;
      return out;
    }
    return block;
  });
}

const workdir = mkdtempSync(join(tmpdir(), "fabrica-record-fixture-"));
try {
  writeFileSync(join(workdir, "sample.txt"), "hello from the fixture recording\n");

  const rawStdout = execFileSync(
    "claude",
    ["-p", PROMPT, "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions"],
    { cwd: workdir, encoding: "utf8" }
  );
  // Blank out this machine's own throwaway temp path before it can reach
  // any tool_use "input" field (e.g. Read's file_path) - not sensitive,
  // just noise that would make every re-recording a spurious diff.
  const stdout = rawStdout.split(workdir).join("/workdir");

  const sanitized = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map(sanitizeLine)
    .filter(Boolean);

  writeFileSync(FIXTURE_PATH, sanitized.map((l) => JSON.stringify(l)).join("\n") + "\n");
  console.log(`Wrote ${sanitized.length} sanitized lines to ${FIXTURE_PATH}`);
  console.log("Review the diff before committing - see this script's own header comment.");
} finally {
  rmSync(workdir, { recursive: true, force: true });
}
