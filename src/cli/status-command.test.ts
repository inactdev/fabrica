import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "../index.ts";
import { appendEvent, recordPath } from "../record/index.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { runDoCommand } from "./do-command.ts";
import { runStatusCommand } from "./status-command.ts";
import { CHECKING_QUIET_CEILING_MS, PRE_WORK_QUIET_CEILING_MS } from "./render.ts";

// A real, separate detached process (see do-command.test.ts): runCheck is
// synchronous execSync, so a slow check blocks that process's own event
// loop start to finish - polling `fabrica status` from THIS test process
// concurrently, while it's mid-check, needs a genuinely different OS
// process, not just an unawaited in-process promise.
const FAKE_ENTRY = fileURLToPath(new URL("./helpers/fake-run-task-entry.ts", import.meta.url));

function tempRecordHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-cli-status-command-"));
}

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) };
}

test("runStatusCommand: no tasks at all says so plainly", async () => {
  const io = captureIo();
  const code = await runStatusCommand([], { recordHome: tempRecordHome(), ...io });
  assert.equal(code, 0);
  assert.deepEqual(io.out, ["No open tasks."]);
});

test("runStatusCommand: a delivered task is flagged as awaiting the Client's verdict", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  const task = await createForeman({ recordHome }).do("small change", { project, brain: fakeBrain() });
  const io = captureIo();

  const code = await runStatusCommand([], { recordHome, ...io });

  assert.equal(code, 0);
  assert.equal(io.out.length, 1);
  assert.match(io.out[0], new RegExp(`^${task.id}\\s`));
  assert.match(io.out[0], /delivered/);
  assert.match(io.out[0], /AWAITING YOUR VERDICT/);
  assert.match(io.out[0], new RegExp(project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("runStatusCommand: a closed task (verdict recorded) drops off the list", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  const task = await createForeman({ recordHome }).do("small change", { project, brain: fakeBrain() });
  await createForeman({ recordHome }).verdict(task.id, "accept", "good");
  const io = captureIo();

  const code = await runStatusCommand([], { recordHome, ...io });

  assert.equal(code, 0);
  assert.deepEqual(io.out, ["No open tasks."]);
});

test("runStatusCommand: an unknown flag is refused with exact instructions, not ignored", async () => {
  const io = captureIo();
  const code = await runStatusCommand(["--json"], { recordHome: tempRecordHome(), ...io });

  assert.equal(code, 1);
  assert.deepEqual(io.out, []);
  assert.match(io.err[0], /unknown flag "--json"/);
  assert.match(io.err[0], /Usage: fabrica status/);
});

test("runStatusCommand: a stray positional is refused and points at `fabrica log`", async () => {
  const io = captureIo();
  const code = await runStatusCommand(["some-task-id"], { recordHome: tempRecordHome(), ...io });

  assert.equal(code, 1);
  assert.deepEqual(io.out, []);
  assert.match(io.err[0], /unexpected argument "some-task-id"/);
  assert.match(io.err[0], /fabrica log <taskId>/);
});

// Runs `fabrica status` until one of its lines matches, and returns that
// very output - how long the detached process takes to boot tsx, register
// and reach its check is not something a fixed wait can predict.
async function statusUntil(recordHome: string, wanted: RegExp, timeoutMs = 20_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let last: string[] = [];
  while (Date.now() < deadline) {
    const io = captureIo();
    const code = await runStatusCommand([], { recordHome, ...io });
    assert.equal(code, 0);
    if (io.out.some((line) => wanted.test(line))) return io.out;
    last = io.out;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${wanted} in \`fabrica status\`; last output: ${JSON.stringify(last)}`);
}

test("runStatusCommand: a task mid-check says so plainly, with real elapsed time, never quiet", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("sleep 2 && exit 0");

  const doIo = { out: [] as string[], err: [] as string[], stdout: (l: string) => doIo.out.push(l), stderr: () => {} };
  await runDoCommand(["small change", "--project", project], { recordHome, entryScript: FAKE_ENTRY, ...doIo });
  const taskId = doIo.out[0];

  const out = await statusUntil(recordHome, /checking/);

  assert.equal(out.length, 1);
  assert.match(out[0], new RegExp(`^${taskId}\\s`));
  assert.match(out[0], /checking, \d+s so far/);
  assert.doesNotMatch(out[0], /quiet/);
});

// Client ruling, issue #12 review finding: past CHECKING_QUIET_CEILING_MS
// (4h), a check no longer gets the benefit of the doubt - the only way to
// catch a worker killed mid-check (reboot, OOM) or a check that hung,
// where the record's last event stays a "check-run started" forever.
test("runStatusCommand: a check stuck past its own long ceiling is flagged quiet, not shown as honest progress", async () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });
  appendEvent(recordHome, { taskId: "t1", name: "work-started", details: { project: "/some/project" } });
  // appendEvent always stamps the real current time (rule 5: a caller can
  // never smuggle its own occurredAt), so a genuinely old "check-run
  // started" event - the only way to exercise a ceiling this long without
  // an actual multi-hour wait - has to be written to the record file
  // directly, bypassing that stamping.
  const start = Date.now() - CHECKING_QUIET_CEILING_MS - 1;
  const startEvent = {
    occurredAt: new Date(start).toISOString(),
    taskId: "t1",
    name: "check-run",
    details: { attempt: 1, phase: "started" },
  };
  appendFileSync(recordPath(recordHome), `${JSON.stringify(startEvent)}\n`);

  const io = captureIo();
  const code = await runStatusCommand([], { recordHome, ...io });

  assert.equal(code, 0);
  assert.match(io.out[0], /checking/, "state itself is still checking");
  assert.match(io.out[0], /and still not finished/, "but past the ceiling it names the stuck check, not honest progress");
  assert.doesNotMatch(io.out[0], /heartbeat/, "no heartbeat is ever emitted during a check");
  assert.doesNotMatch(io.out[0], /checking, .* so far/, "the plain elapsed line steps aside for the alarm");
});

test("runStatusCommand: a red delivery shows failed, not delivered, and carries no verdict flag", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 1");
  const task = await createForeman({ recordHome }).do("small change", { project, brain: fakeBrain() });
  const io = captureIo();

  const code = await runStatusCommand([], { recordHome, ...io });

  assert.equal(code, 0);
  assert.match(io.out[0], new RegExp(`^${task.id}\\s`));
  assert.match(io.out[0], /failed/);
  assert.doesNotMatch(io.out[0], /AWAITING YOUR VERDICT/);
});

// Client ruling, issue #12 review finding (status-lists-ask-failed-tasks-
// forever): a task whose brain.ask() itself threw has no fix path back
// and never will again - it must stay in the listing (never hidden), but
// marked as the dead end it is, not left looking like ordinary open work.
test("runStatusCommand: an ask-failed task stays listed, marked unresolvable, not blended in with open work", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  await assert.rejects(
    createForeman({ recordHome }).do("small change", {
      project,
      brain: fakeBrain({ askError: new Error("the brain is unreachable") }),
    })
  );
  const io = captureIo();

  const code = await runStatusCommand([], { recordHome, ...io });

  assert.equal(code, 0);
  assert.equal(io.out.length, 1);
  assert.match(io.out[0], /failed/);
  assert.match(io.out[0], /FAILED, UNRESOLVABLE/);
});

// Same ruling, its sibling: a live task still worth the Client's
// attention must sort ahead of a dead-end one, so scanning top-down
// finds the real open work first.
test("runStatusCommand: an ask-failed task sorts after a task that's still genuinely open", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  await assert.rejects(
    createForeman({ recordHome }).do("dead end", {
      project,
      brain: fakeBrain({ askError: new Error("the brain is unreachable") }),
    })
  );
  const openTask = await createForeman({ recordHome }).do("still open", {
    project,
    brain: fakeBrain({ askQuestions: ["what should this do?"] }),
  });
  const io = captureIo();

  const code = await runStatusCommand([], { recordHome, ...io });

  assert.equal(code, 0);
  assert.equal(io.out.length, 2);
  assert.match(io.out[0], new RegExp(`^${openTask.id}\\s`));
  assert.match(io.out[1], /FAILED, UNRESOLVABLE/);
});

// The pre-work window's own ceiling (PRE_WORK_QUIET_CEILING_MS): a task
// stuck between task-received and work-started past its own long window
// is flagged quiet too, catching a reboot or OOM during brain.ask() that
// would otherwise freeze the record here with the alarm never firing.
test("runStatusCommand: a task stuck before work-started past its own ceiling is flagged quiet, wording names no heartbeat", async () => {
  const recordHome = tempRecordHome();
  const start = Date.now() - PRE_WORK_QUIET_CEILING_MS - 1;
  const receivedEvent = {
    occurredAt: new Date(start).toISOString(),
    taskId: "t1",
    name: "task-received",
    details: { brief: "small change" },
  };
  appendFileSync(recordPath(recordHome), `${JSON.stringify(receivedEvent)}\n`);

  const io = captureIo();
  const code = await runStatusCommand([], { recordHome, ...io });

  assert.equal(code, 0);
  assert.equal(io.out.length, 1);
  assert.match(io.out[0], /working/, "state itself is still working - only ask() is unaccounted for");
  assert.match(io.out[0], /no signal recorded yet/, "no heartbeat was ever emitted for this window");
  assert.doesNotMatch(io.out[0], /heartbeat/, "attempts.ts's heartbeat interval never wraps brain.ask()");
});
