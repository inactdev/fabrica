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
// It refuses to write anything if that run didn't actually exercise
// every shape the allowlist covers (stream-json-shape.ts's
// coverageGaps) - a thinner fixture checks less while the parity test
// stays green, which is the exact failure issue #46 is about.
//
// After running, read the diff before committing: `git diff` on the
// fixture should show only fields the adapter's own claude-code.ts/.md
// document reading, not a wholesale reshuffle - a fixture that changes in
// ways nothing here reads is a sign this script over-recorded, not that
// the real CLI actually changed.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Same trick as src/cli/bin.mjs: teach this process to load a .ts file
// with a real `import "tsx/esm"` resolved against this file's own
// location. The coverage rule has to come from stream-json-shape.ts
// itself - a second copy of the allowlist here would be one more thing
// that can drift.
await import("tsx/esm");
const { extractShape, coverageGaps } = await import(new URL("./stream-json-shape.ts", import.meta.url).href);

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
  // just noise that would make every re-recording a spurious diff. Both
  // the path as handed to the CLI and its realpath: on macOS os.tmpdir()
  // resolves through a /var -> /private/var symlink, and the tool that
  // reports back a path reports the resolved one. Longest first, or
  // replacing the short form leaves "/private" stranded in front of the
  // placeholder.
  const tempPaths = [...new Set([workdir, realpathSync(workdir)])].sort((a, b) => b.length - a.length);
  const stdout = tempPaths.reduce((text, path) => text.split(path).join("/workdir"), rawStdout);

  const sanitized = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map(sanitizeLine)
    .filter(Boolean);

  // A recording that didn't exercise every shape the allowlist covers is
  // a weaker guard than the one already committed, and nothing
  // downstream would say so: the parity test compares only what its
  // reference demonstrates, so it would stay green while checking less.
  //
  // Gated on the serialized payload, then written verbatim, so what's
  // checked is byte-for-byte what lands on disk - sanitizeLine() names
  // every result key unconditionally, so a key the real CLI stopped
  // emitting survives as `undefined` in memory and disappears only at
  // JSON.stringify.
  const payload = sanitized.map((l) => JSON.stringify(l)).join("\n") + "\n";
  const written = payload
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  const gaps = coverageGaps(extractShape(written));
  if (gaps.length > 0) {
    console.error(
      `Refusing to overwrite ${FIXTURE_PATH}: this recording never demonstrated\n` +
        `${gaps.map((gap) => `  - ${gap}`).join("\n")}\n` +
        "so committing it would silently narrow what the shape-parity test checks.\n" +
        "Usually the model just answered without making the tool call - re-run this script.\n" +
        "If the real CLI genuinely stopped emitting one of these, change the allowlist in\n" +
        "stream-json-shape.ts deliberately (and say why), rather than accepting a thinner fixture."
    );
    process.exitCode = 1;
  } else {
    writeFileSync(FIXTURE_PATH, payload);
    console.log(`Wrote ${written.length} sanitized lines to ${FIXTURE_PATH}`);
    console.log("Review the diff before committing - see this script's own header comment.");
  }
} finally {
  rmSync(workdir, { recursive: true, force: true });
}
