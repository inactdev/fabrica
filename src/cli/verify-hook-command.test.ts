import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent } from "../record/index.ts";
import { runVerifyHookCommand } from "./verify-hook-command.ts";

function tempRecordHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-verify-hook-cmd-home-"));
}

function tempCwd(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-verify-hook-cmd-cwd-"));
}

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) };
}

test("runVerifyHookCommand: reports failure when the harness itself can't be reached", async () => {
  const io = captureIo();
  const code = await runVerifyHookCommand({
    cwd: tempCwd(),
    recordHome: tempRecordHome(),
    harness: {
      harnessAvailable: () => false,
      attemptRealEdit: () => {
        throw new Error("must not be called when the harness is unavailable");
      },
    },
    ...io,
  });

  assert.equal(code, 1);
  assert.match(io.err.join("\n"), /could not find or run your chat agent/i);
});

test("runVerifyHookCommand: a properly denied and logged attempt passes", async () => {
  const recordHome = tempRecordHome();
  const cwd = tempCwd();
  const io = captureIo();

  const code = await runVerifyHookCommand({
    cwd,
    recordHome,
    harness: {
      harnessAvailable: () => true,
      // Simulates a working hook: nothing written to disk, but it logs the
      // attempt, exactly like the real hook does in the same invocation.
      attemptRealEdit: (attemptCwd, targetFileName) => {
        appendEvent(recordHome, {
          taskId: "project:unregistered",
          name: "edit-attempt-blocked",
          details: { target: join(attemptCwd, targetFileName) },
        });
      },
    },
    ...io,
  });

  assert.equal(code, 0);
  assert.match(io.out.join("\n"), /edit denied:\s+yes/);
  assert.match(io.out.join("\n"), /attempt logged:\s+yes/);
  assert.match(io.out.join("\n"), /working correctly/i);
});

test("runVerifyHookCommand: a silently allowed edit fails, and the throwaway file is cleaned up", async () => {
  const recordHome = tempRecordHome();
  const cwd = tempCwd();
  const io = captureIo();
  let seenFileName = "";

  const code = await runVerifyHookCommand({
    cwd,
    recordHome,
    harness: {
      harnessAvailable: () => true,
      // Simulates a broken/misconfigured hook: the edit actually happens.
      attemptRealEdit: (attemptCwd, targetFileName) => {
        seenFileName = targetFileName;
        writeFileSync(join(attemptCwd, targetFileName), "verify\n");
      },
    },
    ...io,
  });

  assert.equal(code, 1);
  assert.match(io.out.join("\n"), /edit denied:\s+no/);
  assert.equal(existsSync(join(cwd, seenFileName)), false, "the throwaway file must be cleaned up either way");
});

test("runVerifyHookCommand: denied but never logged (the fail-open case) still fails", async () => {
  const recordHome = tempRecordHome();
  const cwd = tempCwd();
  const io = captureIo();

  const code = await runVerifyHookCommand({
    cwd,
    recordHome,
    harness: {
      harnessAvailable: () => true,
      // Simulates the hook command failing to launch at all: nothing
      // written, but nothing logged either.
      attemptRealEdit: () => {},
    },
    ...io,
  });

  assert.equal(code, 1);
  assert.match(io.out.join("\n"), /edit denied:\s+yes/);
  assert.match(io.out.join("\n"), /attempt logged:\s+no/);
  assert.match(io.out.join("\n"), /not fully working/i);
});

test("runVerifyHookCommand: another session's blocked edit doesn't count as this attempt's", async () => {
  const recordHome = tempRecordHome();
  const cwd = tempCwd();
  const io = captureIo();

  const code = await runVerifyHookCommand({
    cwd,
    recordHome,
    harness: {
      harnessAvailable: () => true,
      // The session under test never gets as far as attempting the edit
      // (unauthenticated, rate-limited, timed out); meanwhile an unrelated
      // session elsewhere blocks an edit of its own and appends it to the
      // same shared record. That must not read as a pass here.
      attemptRealEdit: () => {
        appendEvent(recordHome, {
          taskId: "project:somewhere-else",
          name: "edit-attempt-blocked",
          details: { target: "/some/other/project/src/unrelated.ts" },
        });
      },
    },
    ...io,
  });

  assert.equal(code, 1);
  assert.match(io.out.join("\n"), /attempt logged:\s+no/);
});
