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

test("runDenyAndLogEditCommand: a malformed stdin payload still denies, never throws", async () => {
  const recordHome = tempRecordHome();
  const out: string[] = [];
  const code = await runDenyAndLogEditCommand({
    recordHome,
    stdin: Readable.from([Buffer.from("not json")]),
    stdout: (line) => out.push(line),
  });

  assert.equal(code, 0);
  const decision = JSON.parse(out.join(""));
  assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
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
