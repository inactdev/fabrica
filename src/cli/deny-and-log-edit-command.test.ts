import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvents } from "../record/index.ts";
import { runDenyAndLogEditCommand } from "./deny-and-log-edit-command.ts";

function tempRecordHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-deny-log-cmd-"));
}

function stdinOf(payload: unknown): Readable {
  return Readable.from([Buffer.from(JSON.stringify(payload))]);
}

test("runDenyAndLogEditCommand: emits a PreToolUse deny decision on stdout", async () => {
  const recordHome = tempRecordHome();
  const out: string[] = [];
  const code = await runDenyAndLogEditCommand({
    recordHome,
    stdin: stdinOf({ tool_name: "Edit", tool_input: { file_path: "/x/app.txt" }, cwd: "/x" }),
    stdout: (line) => out.push(line),
  });

  assert.equal(code, 0);
  const decision = JSON.parse(out.join(""));
  assert.equal(decision.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /fabrica do/i);
});

test("runDenyAndLogEditCommand: records the attempt as edit-attempt-blocked", async () => {
  const recordHome = tempRecordHome();
  await runDenyAndLogEditCommand({
    recordHome,
    stdin: stdinOf({ tool_name: "Write", tool_input: { file_path: "/x/new.txt" }, cwd: "/x" }),
    stdout: () => {},
  });

  const events = readEvents(recordHome);
  assert.equal(events.length, 1);
  assert.equal(events[0].name, "edit-attempt-blocked");
  const details = events[0].details as { tool: string; target: string };
  assert.equal(details.tool, "Write");
  assert.equal(details.target, "/x/new.txt");
});

test("runDenyAndLogEditCommand: a malformed stdin payload still denies, never throws, and says so", async () => {
  const recordHome = tempRecordHome();
  const out: string[] = [];
  const err: string[] = [];
  const code = await runDenyAndLogEditCommand({
    recordHome,
    stdin: Readable.from([Buffer.from("not json")]),
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  });

  assert.equal(code, 0);
  const decision = JSON.parse(out.join(""));
  assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
  assert.match(err.join("\n"), /not valid JSON/i);
});

test("runDenyAndLogEditCommand: valid JSON that isn't an object still denies and logs", async () => {
  const recordHome = tempRecordHome();
  const out: string[] = [];
  const err: string[] = [];
  const code = await runDenyAndLogEditCommand({
    recordHome,
    stdin: Readable.from([Buffer.from("null")]),
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  });

  assert.equal(code, 0);
  assert.equal(JSON.parse(out.join("")).hookSpecificOutput.permissionDecision, "deny");
  assert.match(err.join("\n"), /not valid JSON/i);

  const events = readEvents(recordHome);
  assert.equal(events.length, 1);
  assert.equal((events[0].details as { tool: string }).tool, "unknown");
});

test("runDenyAndLogEditCommand: stdin that never closes still denies and still logs", async () => {
  const recordHome = tempRecordHome();
  const out: string[] = [];
  const err: string[] = [];
  const neverEnds = new Readable({ read() {} });

  const code = await runDenyAndLogEditCommand({
    recordHome,
    stdin: neverEnds,
    stdinTimeoutMs: 25,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  });

  assert.equal(code, 0);
  assert.equal(JSON.parse(out.join("")).hookSpecificOutput.permissionDecision, "deny");
  assert.match(err.join("\n"), /no hook payload arrived/i);

  const events = readEvents(recordHome);
  assert.equal(events.length, 1);
  assert.equal((events[0].details as { tool: string }).tool, "unknown");
});

test("runDenyAndLogEditCommand: a payload that arrived before the deadline is kept, not discarded", async (t) => {
  // Deterministic on purpose: a real setTimeout raced against stream
  // consumption would only pass when the event loop drains the pushed
  // chunk inside the deadline, which is a clock race that flakes under
  // load. Mocking only setTimeout (never setImmediate/microtasks) lets
  // this wait for the chunk to actually be consumed, then fire the
  // "deadline" itself on command - no wall-clock window to miss.
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const recordHome = tempRecordHome();
  const out: string[] = [];
  const held = new Readable({ read() {} });
  held.push(
    Buffer.from(JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "/x/app.txt" }, cwd: "/x" }))
  );

  const resultPromise = runDenyAndLogEditCommand({
    recordHome,
    stdin: held,
    stdinTimeoutMs: 25,
    stdout: (line) => out.push(line),
    stderr: () => {},
  });

  // Real setImmediate (unmocked): flushes the stream's own microtask/
  // nextTick-driven read of the already-pushed chunk before the mocked
  // deadline is allowed to fire.
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(25);

  const code = await resultPromise;

  assert.equal(code, 0);
  assert.equal(JSON.parse(out.join("")).hookSpecificOutput.permissionDecision, "deny");

  const events = readEvents(recordHome);
  assert.equal(events.length, 1);
  const details = events[0].details as { tool: string; target: string };
  assert.equal(details.tool, "Edit");
  assert.equal(details.target, "/x/app.txt");
});

test("runDenyAndLogEditCommand: falls back to Bash's command field when no file path is given", async () => {
  const recordHome = tempRecordHome();
  await runDenyAndLogEditCommand({
    recordHome,
    stdin: stdinOf({ tool_name: "Bash", tool_input: { command: "echo hi > f.txt" }, cwd: "/x" }),
    stdout: () => {},
  });

  const events = readEvents(recordHome);
  assert.equal((events[0].details as { target: string }).target, "echo hi > f.txt");
});
