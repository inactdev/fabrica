import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman, daySpend, formatUsd, readEvents, recordBlockedEditAttempt } from "../index.ts";
import { appendEvent, recordPath, registerTask, writeTaskFile } from "../record/index.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { makeFixtureRepo, pushToOrigin } from "../../contract/helpers/fixture.ts";
import { runDoCommand } from "./do-command.ts";
import { runStatusCommand } from "./status-command.ts";
import { CHECKING_QUIET_CEILING_MS, PRE_WORK_QUIET_CEILING_MS } from "./render.ts";
import { fixtureInspector } from "../../contract/helpers/fake-inspector.ts";
import { fixtureCheckBox } from "../../contract/helpers/fake-check-box.ts";

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

// Issues #81/#110/#189: every successful run now opens with a "spent in
// the last 24 hours" line and a "subscription meters" one, and may close
// with a "blocked edit attempts on record" line - none of them is a task
// row. Tests written before those existed assert on task rows by
// position; this strips them all so those assertions don't have to be
// reindexed by hand, while the lines themselves get their own dedicated
// tests below.
function taskRows(out: string[]): string[] {
  return out.filter(
    (line) =>
      !line.startsWith("spent in the last 24 hours:") &&
      !line.startsWith("subscription meters:") &&
      !line.startsWith("blocked edit attempts on record:")
  );
}

test("runStatusCommand: no tasks at all says so plainly", async () => {
  const io = captureIo();
  const code = await runStatusCommand([], { recordHome: tempRecordHome(), ...io });
  assert.equal(code, 0);
  assert.deepEqual(taskRows(io.out), ["No open tasks."]);
});

// Issues #81/#110: recordBlockedEditAttempt keys an unattributed blocked
// edit to "project:unregistered" (src/offbooks/blocked-edit.ts) - never a
// real task, so a record holding only these must show no task rows at
// all, just the quiet count at the bottom. Negative first, before the
// positive "mixed with a real task" case below.
test("runStatusCommand: a record with only project:unregistered events shows no task rows, just the blocked-edit count", async () => {
  const recordHome = tempRecordHome();
  recordBlockedEditAttempt(recordHome, { tool: "Write", cwd: "/some/other/place" });
  recordBlockedEditAttempt(recordHome, { tool: "Edit", cwd: "/some/other/place" });
  const io = captureIo();

  const code = await runStatusCommand([], { recordHome, ...io });

  assert.equal(code, 0);
  assert.deepEqual(taskRows(io.out), ["No open tasks."]);
  assert.ok(io.out.includes("blocked edit attempts on record: 2"), `missing the blocked-edit count line: ${JSON.stringify(io.out)}`);
});

// Same filtering, this time with a registered project's bucket alongside
// a real open task - the phantom bucket must still never surface as a row.
test("runStatusCommand: a project:<name> blocked-edit bucket never shows as a task row, even alongside a real one", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  writeFileSync(join(recordHome, "projects.toml"), `[projects.spending-app]\npath = "${project}"\n`);
  recordBlockedEditAttempt(recordHome, { tool: "Edit", cwd: project });
  const openTask = await createForeman({ recordHome, inspector: fixtureInspector() }).do("still open", {
    project,
    brain: fakeBrain({ askQuestions: ["what should this do?"] }),
  });
  const io = captureIo();

  const code = await runStatusCommand([], { recordHome, ...io });

  assert.equal(code, 0);
  const rows = taskRows(io.out);
  assert.equal(rows.length, 1);
  assert.match(rows[0], new RegExp(`^${openTask.id}\\s`));
  assert.ok(io.out.includes("blocked edit attempts on record: 1"), `missing the blocked-edit count line: ${JSON.stringify(io.out)}`);
});

// A projects.toml that will not parse used to take the whole listing
// down: `loadConfigOrDefault` threw, the catch printed the message to
// stderr and the command exited 1 having listed nothing at all. Client
// ruling: print the error on the first line and still list the tasks -
// they come from the record, which needs no config.
test("runStatusCommand: an unparseable projects.toml is the first line, and the tasks are still listed", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  const openTask = await createForeman({ recordHome, inspector: fixtureInspector() }).do("still open", {
    project,
    brain: fakeBrain({ askQuestions: ["what should this do?"] }),
  });
  // Written after the task so registration itself isn't what breaks.
  writeFileSync(join(recordHome, "projects.toml"), `[caps]\nperDayUsd = 5\nthis is not [valid toml\n`);
  const io = captureIo();

  const code = await runStatusCommand([], { recordHome, ...io });

  // A report, not a check (the same reason a task whose worker is gone
  // leaves this at 0) - what matters is that it is said, not that the
  // shell notices.
  assert.equal(code, 0, io.err.join("\n"));
  const problemLine = io.out[0];
  assert.ok(problemLine.startsWith(join(recordHome, "projects.toml")), `the first line must name the file: ${problemLine}`);
  assert.match(problemLine, /:3:/, `the first line must name the line the parser stopped on: ${problemLine}`);
  assert.match(problemLine, /not valid TOML/);
  // And the listing ran anyway.
  const rows = taskRows(io.out.slice(1));
  assert.equal(rows.length, 1, `expected the task to still be listed: ${JSON.stringify(io.out)}`);
  assert.match(rows[0], new RegExp(`^${openTask.id}\\s`));
});

// The negative control for the line above: a file that reads fine must
// never produce it. Without this, a bug that printed the problem line
// unconditionally would pass the test above.
test("runStatusCommand: a projects.toml that reads fine prints no problem line at all", async () => {
  const recordHome = tempRecordHome();
  writeFileSync(join(recordHome, "projects.toml"), "[caps]\nperDayUsd = 5\n");
  const io = captureIo();

  const code = await runStatusCommand([], { recordHome, ...io });

  assert.equal(code, 0, io.err.join("\n"));
  assert.ok(io.out[0].startsWith("spent in the last 24 hours:"), `expected the spend line first: ${JSON.stringify(io.out)}`);
  assert.ok(!io.out.some((line) => line.includes("not valid TOML")), JSON.stringify(io.out));
});

test("runStatusCommand: a delivered task is flagged as awaiting the Client's verdict", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  const task = await createForeman({ recordHome, inspector: fixtureInspector() }).do("small change", { project, brain: fakeBrain() });
  const io = captureIo();

  const code = await runStatusCommand([], { recordHome, ...io });

  assert.equal(code, 0);
  const rows = taskRows(io.out);
  assert.equal(rows.length, 1);
  assert.match(rows[0], new RegExp(`^${task.id}\\s`));
  assert.match(rows[0], /delivered/);
  assert.match(rows[0], /AWAITING YOUR VERDICT/);
  assert.match(rows[0], new RegExp(project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

// Issue #184: "a task run with no setting shows the real model name on
// its row" - the real one the worker reported, never "default".
test("runStatusCommand: every row names the model that did the work", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  const task = await createForeman({ recordHome, inspector: fixtureInspector() }).do("small change", {
    project,
    brain: fakeBrain({ model: "default", reportedModel: "big-9-20260202" }),
  });
  const io = captureIo();

  const code = await runStatusCommand([], { recordHome, ...io });

  assert.equal(code, 0);
  const rows = taskRows(io.out);
  assert.match(rows[0], /model: big-9-20260202/);
  assert.ok(!rows[0].includes("default"), `no row may ever say "default" as a model: ${rows[0]}`);
});

test("runStatusCommand: a task that asked for a model shows the declaration beside what ran", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  // The model actually run differs from the declared one, which is the
  // case the two separate fields exist to make visible.
  await createForeman({ recordHome, inspector: fixtureInspector() }).do("small change", {
    project,
    brain: fakeBrain({ reportedModel: "big-9" }),
    model: "small-5",
  });
  const io = captureIo();

  await runStatusCommand([], { recordHome, ...io });

  assert.match(taskRows(io.out)[0], /model: big-9 \(declared small-5 via --model\)/);
});

// The one fact on a status line read from git rather than from the
// record: origin moves while a task works, and a `fix` rebases onto it
// before anything else happens (issue #235). Nothing is written to get
// this - see src/foreman/base-standing.test.ts for the byte-for-byte
// proof of that - and it is only as fresh as the last fetch, which is
// what the "origin last fetched" clause says.
test("runStatusCommand: a delivered task still containing origin's tip is marked with nothing", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  await createForeman({ recordHome, inspector: fixtureInspector() }).do("small change", { project, brain: fakeBrain() });
  const io = captureIo();

  assert.equal(await runStatusCommand([], { recordHome, ...io }), 0);
  const row = taskRows(io.out)[0];
  assert.match(row, /AWAITING YOUR VERDICT/);
  assert.doesNotMatch(row, /behind origin|base unknown/);
});

test("runStatusCommand: a delivered task whose branch no longer contains origin's tip says a fix will rebase", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  const task = await createForeman({ recordHome, inspector: fixtureInspector() }).do("small change", {
    project,
    brain: fakeBrain(),
  });

  // Somebody else's work lands on origin's default branch, and this
  // checkout fetches it - which is exactly what Fabrica itself does on
  // the next line it cuts or fix round it runs.
  writeFileSync(join(project, "someone-elses-merge.md"), "landed while the task worked\n");
  execFileSync("git", ["add", "-A"], { cwd: project });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "another merge"], { cwd: project });
  pushToOrigin(project);
  execFileSync("git", ["fetch", "-q", "origin"], { cwd: project });

  const io = captureIo();
  assert.equal(await runStatusCommand([], { recordHome, ...io }), 0);

  const row = taskRows(io.out).find((line) => line.startsWith(`${task.id}  `))!;
  assert.ok(row, `the delivered task should still be listed: ${JSON.stringify(io.out)}`);
  assert.match(row, /AWAITING YOUR VERDICT/);
  assert.match(row, /behind origin\/\S+, a fix will rebase \(origin last fetched \d+s ago\)/);
});

test("runStatusCommand: a delivered task whose project has been moved away says `base unknown`, not nothing", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  const task = await createForeman({ recordHome, inspector: fixtureInspector() }).do("small change", {
    project,
    brain: fakeBrain(),
  });
  rmSync(project, { recursive: true, force: true });

  const io = captureIo();
  assert.equal(await runStatusCommand([], { recordHome, ...io }), 0);

  const row = taskRows(io.out).find((line) => line.startsWith(`${task.id}  `))!;
  assert.match(row, /base unknown: the project folder .* is not there any more/);
  assert.match(row, /AWAITING YOUR VERDICT/, "an unreadable base never hides the verdict the task is waiting for");
});

// The change's own fingerprint, read off the record rather than from
// git - see src/foreman/fingerprint.test.ts for how it is taken, and
// src/foreman/fingerprint-round.test.ts for what a pass records.
test("runStatusCommand: a delivered task names the change's fingerprint on its own line", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  const task = await createForeman({ recordHome, inspector: fixtureInspector() }).do("small change", {
    project,
    brain: fakeBrain({ onWork: (_brief, workdir) => writeFileSync(join(workdir, "work.txt"), "v1\n") }),
  });
  const io = captureIo();

  assert.equal(await runStatusCommand([], { recordHome, ...io }), 0);
  const row = taskRows(io.out).find((line) => line.startsWith(`${task.id}  `))!;
  assert.match(row, /AWAITING YOUR VERDICT/);
  assert.match(row, /fingerprint [0-9a-f]{7}/);
  assert.doesNotMatch(row, /changed from pass|void/, "a first pass has nothing to have changed from");
});

test("runStatusCommand: a fix round that changed the work says so, and that earlier observations are void", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  let version = 0;
  const foreman = createForeman({ recordHome, inspector: fixtureInspector() });
  const task = await foreman.do("small change", {
    project,
    brain: fakeBrain({
      onWork: (_brief, workdir) => writeFileSync(join(workdir, "work.txt"), `v${++version}\n`),
    }),
  });
  await foreman.verdict(task.id, "fix", "do it differently");

  const io = captureIo();
  assert.equal(await runStatusCommand([], { recordHome, ...io }), 0);
  const row = taskRows(io.out).find((line) => line.startsWith(`${task.id}  `))!;
  assert.match(row, /fingerprint [0-9a-f]{7}, changed from pass 1 \([0-9a-f]{7}\)/);
  assert.match(row, /every earlier Inspector stamp, check result and CI conclusion on this task is void/);
});

test("runStatusCommand: a delivery from before fingerprints existed reads as unstamped, never as nothing", async () => {
  const recordHome = tempRecordHome();
  const task = registerTask(recordHome, "an older task");
  appendEvent(recordHome, { taskId: task.id, name: "work-started", details: { project: "/somewhere" } });
  appendEvent(recordHome, {
    taskId: task.id,
    name: "delivered",
    details: {
      outcome: "done",
      // Exactly the shape a pre-fingerprint record holds: no
      // `fingerprint` field at all, and nothing is computed for it now.
      delivery: {
        outcome: "done",
        confidence: 100,
        summary: "done",
        evidence: "",
        assumptions: "",
        gaps: "",
        branch: `fabrica/${task.id}`,
        files: [],
        gateChanges: "",
      },
      project: "/somewhere",
    },
  });
  const io = captureIo();

  assert.equal(await runStatusCommand([], { recordHome, ...io }), 0);
  const row = taskRows(io.out).find((line) => line.startsWith(`${task.id}  `))!;
  assert.match(row, /fingerprint unstamped: recorded before fingerprints existed/);
});

test("runStatusCommand: a working task is never marked with a base standing - only a delivery can be fixed", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  const task = registerTask(recordHome, "still working");
  appendEvent(recordHome, { taskId: task.id, name: "work-started", details: { project, attempt: 1 } });
  const io = captureIo();

  assert.equal(await runStatusCommand([], { recordHome, ...io }), 0);
  assert.doesNotMatch(taskRows(io.out)[0], /behind origin|base unknown/);
});

test("runStatusCommand: a closed task (verdict recorded) drops off the list", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  const task = await createForeman({ recordHome, inspector: fixtureInspector() }).do("small change", { project, brain: fakeBrain() });
  await createForeman({ recordHome, inspector: fixtureInspector() }).verdict(task.id, "accept", "good");
  const io = captureIo();

  const code = await runStatusCommand([], { recordHome, ...io });

  assert.equal(code, 0);
  assert.deepEqual(taskRows(io.out), ["No open tasks."]);
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
  // Self-tested: "checking" is the worker's box running the check, which
  // only happens for a project with no .inspector.json - and `fabrica do`
  // now refuses one of those up front, before registering anything. This
  // test is about what `fabrica status` shows a task that has started, so
  // it skips exactly that one gate (`setUpRefusal`) and nothing else; the
  // gate has its own tests in do-command.test.ts.
  const project = makeFixtureRepo("sleep 2 && exit 0", { inspector: false });

  const doIo = { out: [] as string[], err: [] as string[], stdout: (l: string) => doIo.out.push(l), stderr: () => {} };
  await runDoCommand(["small change", "--project", project], {
    recordHome,
    entryScript: FAKE_ENTRY,
    setUpRefusal: () => null,
    ...doIo,
  });
  const taskId = doIo.out[0];

  const out = taskRows(await statusUntil(recordHome, /checking/));

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
  const rows = taskRows(io.out);
  assert.match(rows[0], /checking/, "state itself is still checking");
  assert.match(rows[0], /and still not finished/, "but past the ceiling it names the stuck check, not honest progress");
  assert.doesNotMatch(rows[0], /heartbeat/, "no heartbeat is ever emitted during a check");
  assert.doesNotMatch(rows[0], /checking, .* so far/, "the plain elapsed line steps aside for the alarm");
});

// Review finding: the checking alarm's elapsed time must be anchored to
// when the CHECK started, not to the record's last event - a heartbeat
// landing after check-run "started" doesn't change stateOf's "checking"
// verdict (heartbeat is a no-op in that switch), so it's a real way for
// the two quantities to diverge, not just a hypothetical one. Before the
// fix this would have shown a near-zero elapsed time instead of the
// check's real, hours-long duration.
test("runStatusCommand: the checking alarm's elapsed time tracks the check's own start, not a later heartbeat", async () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });
  appendEvent(recordHome, { taskId: "t1", name: "work-started", details: { project: "/some/project" } });
  const start = Date.now() - CHECKING_QUIET_CEILING_MS - 1;
  const startEvent = {
    occurredAt: new Date(start).toISOString(),
    taskId: "t1",
    name: "check-run",
    details: { attempt: 1, phase: "started" },
  };
  appendFileSync(recordPath(recordHome), `${JSON.stringify(startEvent)}\n`);
  // A real, current-time event landing after the check started - stateOf
  // stays "checking" (heartbeat doesn't change it), but lastActivityAt
  // now points at this instead of the check's own start.
  appendEvent(recordHome, { taskId: "t1", name: "heartbeat", details: { attempt: 1 } });

  const io = captureIo();
  const code = await runStatusCommand([], { recordHome, ...io });

  assert.equal(code, 0);
  const rows = taskRows(io.out);
  assert.match(rows[0], /checking, 4h and still not finished/, `expected the check's real ~4h duration, got: ${rows[0]}`);
});

test("runStatusCommand: a red delivery shows failed, not delivered, and carries no verdict flag", async () => {
  const recordHome = tempRecordHome();
  // Self-tested: with Inspector, red is inspection-red, awaiting a verdict.
  const project = makeFixtureRepo("exit 1", { inspector: false });
  const task = await createForeman({ recordHome, checkBox: fixtureCheckBox().box }).do("small change", {
    project,
    brain: fakeBrain(),
  });
  const io = captureIo();

  const code = await runStatusCommand([], { recordHome, ...io });

  assert.equal(code, 0);
  const rows = taskRows(io.out);
  assert.match(rows[0], new RegExp(`^${task.id}\\s`));
  assert.match(rows[0], /failed/);
  assert.doesNotMatch(rows[0], /AWAITING YOUR VERDICT/);
});

// Issue #99: liveness read from the worker's own process, not inferred
// from the record. Every test below hands the command a process table of
// its own making (`listProcesses`) and writes the pid file by hand, so
// none of them depends on a real detached worker existing on whatever
// machine runs them.
function startedTask(recordHome: string, text = "small change"): string {
  const { id } = registerTask(recordHome, text);
  appendEvent(recordHome, { taskId: id, name: "work-started", details: { project: "/some/project" } });
  appendEvent(recordHome, { taskId: id, name: "heartbeat", details: { attempt: 1 } });
  return id;
}

/** A process table claiming this very test process is the task's own
 * detached runner - using our own pid is what makes the liveness half of
 * the check pass for real instead of being stubbed. */
function tableClaimingRunner(): () => { pid: number; args: string }[] {
  return () => [{ pid: process.pid, args: "node bootstrap.mjs /checkout/src/cli/run-task-entry.ts /home/.fabrica /proj task" }];
}

test("runStatusCommand: a working task whose worker process is gone says so, in place of any quiet notice", async () => {
  const recordHome = tempRecordHome();
  const id = startedTask(recordHome);
  // Above every documented pid_max, so this names nothing that could be
  // running - the record, meanwhile, says "working" and looks fine.
  writeTaskFile(recordHome, id, "worker.pid", "4194304");
  const io = captureIo();

  const code = await runStatusCommand([], { recordHome, listProcesses: tableClaimingRunner(), ...io });

  // Client ruling: status reports it and nothing more - exit code
  // unchanged, and nothing written back to the record.
  assert.equal(code, 0);
  const rows = taskRows(io.out);
  assert.equal(rows.length, 1);
  assert.match(rows[0], /worker process not found/);
  assert.equal(readEvents(recordHome).filter((e) => e.taskId === id).length, 3, "status must never write to the record");
});

test("runStatusCommand: a working task whose worker process is really there reads exactly as it did before", async () => {
  const recordHome = tempRecordHome();
  const id = startedTask(recordHome);
  writeTaskFile(recordHome, id, "worker.pid", String(process.pid));
  const io = captureIo();

  const code = await runStatusCommand([], { recordHome, listProcesses: tableClaimingRunner(), ...io });

  assert.equal(code, 0);
  const rows = taskRows(io.out);
  assert.match(rows[0], /working/);
  assert.doesNotMatch(rows[0], /worker process not found|liveness unknown/);
});

test("runStatusCommand: a task that never wrote a pid file says its liveness is unknown, never that its worker is gone", async () => {
  const recordHome = tempRecordHome();
  startedTask(recordHome);
  const io = captureIo();

  const code = await runStatusCommand([], { recordHome, listProcesses: tableClaimingRunner(), ...io });

  assert.equal(code, 0);
  assert.match(taskRows(io.out)[0], /liveness unknown \(started before pid files\)/);
});

test("runStatusCommand: a delivered task's exited worker is never reported as missing - its round is simply over", async () => {
  const recordHome = tempRecordHome();
  const id = startedTask(recordHome, "already done");
  appendEvent(recordHome, {
    taskId: id,
    name: "delivered",
    details: { outcome: "done", delivery: { confidence: 90, summary: "done", branch: `fabrica/${id}` } },
  });
  writeTaskFile(recordHome, id, "worker.pid", "4194304");
  const io = captureIo();

  const code = await runStatusCommand([], { recordHome, listProcesses: tableClaimingRunner(), ...io });

  assert.equal(code, 0);
  assert.match(taskRows(io.out)[0], /AWAITING YOUR VERDICT/);
  assert.doesNotMatch(taskRows(io.out)[0], /worker process not found/);
});

test("runStatusCommand: a just-ruled `fix` isn't called dead while its own round is still being spawned", async () => {
  const recordHome = tempRecordHome();
  const id = startedTask(recordHome, "needs a fix");
  appendEvent(recordHome, {
    taskId: id,
    name: "delivered",
    details: { outcome: "done", delivery: { confidence: 90, summary: "done", branch: `fabrica/${id}` } },
  });
  appendEvent(recordHome, { taskId: id, name: "verdict-recorded", details: { ruling: "fix", note: "use staging" } });
  // The previous round's pid file is still sitting there, naming a
  // process that exited long ago - exactly what must not be read as
  // this round's worker having died.
  writeTaskFile(recordHome, id, "worker.pid", "4194304");
  const io = captureIo();

  const code = await runStatusCommand([], { recordHome, listProcesses: tableClaimingRunner(), ...io });

  assert.equal(code, 0);
  assert.doesNotMatch(taskRows(io.out)[0], /worker process not found/);
});

test("runStatusCommand: an Inspector refusal sorts after live work and says no verdict was reached", async () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "refusal", name: "task-received" });
  appendEvent(recordHome, { taskId: "refusal", name: "work-started", details: { project: "/some/project" } });
  appendEvent(recordHome, { taskId: "refusal", name: "inspector-called", details: { branch: "fabrica/refusal" } });
  appendEvent(recordHome, {
    taskId: "refusal",
    name: "inspection-finished",
    details: { verdict: "refused", report: "container runtime unavailable" },
  });
  appendEvent(recordHome, { taskId: "asking", name: "task-received" });
  appendEvent(recordHome, { taskId: "asking", name: "questions-asked", details: { questions: ["Which endpoint?"] } });
  const io = captureIo();

  const code = await runStatusCommand([], { recordHome, ...io });

  assert.equal(code, 0);
  const rows = taskRows(io.out);
  assert.equal(rows.length, 2);
  assert.match(rows[0], /^asking\s/);
  assert.match(rows[1], /^refusal\s/);
  assert.match(rows[1], /INSPECTOR REACHED NO VERDICT/);
  assert.doesNotMatch(rows[1], /failed|quiet/i);
});

// Client ruling, issue #12 review finding (status-lists-ask-failed-tasks-
// forever): a task whose brain.ask() itself threw has no fix path back
// and never will again - it must stay in the listing (never hidden), but
// marked as the dead end it is, not left looking like ordinary open work.
test("runStatusCommand: an ask-failed task stays listed, marked unresolvable, not blended in with open work", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  await assert.rejects(
    createForeman({ recordHome, inspector: fixtureInspector() }).do("small change", {
      project,
      brain: fakeBrain({ askError: new Error("the brain is unreachable") }),
    })
  );
  const io = captureIo();

  const code = await runStatusCommand([], { recordHome, ...io });

  assert.equal(code, 0);
  const rows = taskRows(io.out);
  assert.equal(rows.length, 1);
  assert.match(rows[0], /failed/);
  assert.match(rows[0], /FAILED, UNRESOLVABLE/);
});

// Same ruling, its sibling: a live task still worth the Client's
// attention must sort ahead of a dead-end one, so scanning top-down
// finds the real open work first.
test("runStatusCommand: an ask-failed task sorts after a task that's still genuinely open", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  await assert.rejects(
    createForeman({ recordHome, inspector: fixtureInspector() }).do("dead end", {
      project,
      brain: fakeBrain({ askError: new Error("the brain is unreachable") }),
    })
  );
  const openTask = await createForeman({ recordHome, inspector: fixtureInspector() }).do("still open", {
    project,
    brain: fakeBrain({ askQuestions: ["what should this do?"] }),
  });
  const io = captureIo();

  const code = await runStatusCommand([], { recordHome, ...io });

  assert.equal(code, 0);
  const rows = taskRows(io.out);
  assert.equal(rows.length, 2);
  assert.match(rows[0], new RegExp(`^${openTask.id}\\s`));
  assert.match(rows[1], /FAILED, UNRESOLVABLE/);
});

// The pre-work window's own ceiling (PRE_WORK_QUIET_CEILING_MS): a task
// stuck between task-received and work-started past its own long window
// is flagged quiet too, catching a reboot or OOM during brain.ask() that
// would otherwise freeze the record here with the alarm never firing.
test("runStatusCommand: a task stuck before work-started past its own ceiling is flagged quiet, wording names the actual last event", async () => {
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
  const rows = taskRows(io.out);
  assert.equal(rows.length, 1);
  assert.match(rows[0], /working/, "state itself is still working - only ask() is unaccounted for");
  assert.match(rows[0], /no signal since the task was received/, "task-received is the record's actual last event here");
  assert.doesNotMatch(rows[0], /heartbeat/, "attempts.ts's heartbeat interval never wraps brain.ask()");
});

// Issue #11, Client ruling 2026-10-08, part 2: the SPEND UNKNOWN line is
// persistent - derived from the record on every run, so it survives a
// restart and stays until the real cost is recorded. Each run below is a
// genuinely separate OS process running the real `fabrica` binary, so a
// line held in one process's memory could not pass.
function runRealStatus(recordHome: string): string {
  const bin = fileURLToPath(new URL("./bin.mjs", import.meta.url));
  return execFileSync(process.execPath, [bin, "status"], {
    env: { ...process.env, FABRICA_HOME: recordHome },
    encoding: "utf8",
  });
}

test("fabrica status keeps showing SPEND UNKNOWN across fresh processes until the cost is recorded", async () => {
  const recordHome = tempRecordHome();
  writeFileSync(join(recordHome, "projects.toml"), "[caps]\nperDayUsd = 100\n");
  const project = makeFixtureRepo("exit 0");
  const task = await createForeman({ recordHome, caps: { perDayUsd: 100 }, inspector: fixtureInspector() }).do("unmeasured", {
    project,
    brain: fakeBrain({ costUsd: null }),
  });

  const first = runRealStatus(recordHome);
  const second = runRealStatus(recordHome);
  for (const output of [first, second]) {
    assert.ok(output.split("\n").includes("SPEND UNKNOWN - tasks blocked"), `missing the SPEND UNKNOWN line:\n${output}`);
    assert.ok(output.includes(`fabrica cost ${task.id} <usd>`), `the way out is not named:\n${output}`);
  }
});

test("runStatusCommand: with no cap set, an unmeasured task still shows cost: unknown, never nothing", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  await createForeman({ recordHome, inspector: fixtureInspector() }).do("unmeasured", { project, brain: fakeBrain({ costUsd: null }) });
  const io = captureIo();

  await runStatusCommand([], { recordHome, ...io });

  const rows = taskRows(io.out);
  assert.equal(rows.length, 1, "no cap is set, so nothing is blocked and no SPEND UNKNOWN line belongs here");
  assert.match(rows[0], /cost: unknown/);
});

test("runStatusCommand: a measured task shows its cost in dollars", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  await createForeman({ recordHome, inspector: fixtureInspector() }).do("measured", { project, brain: fakeBrain({ costUsd: 0.0421 }) });
  const io = captureIo();

  await runStatusCommand([], { recordHome, ...io });

  assert.match(taskRows(io.out)[0], /cost: \$0\.0421/);
});

// Negative first: fixtureInspector never reports a pull request url, so a
// delivered task's line must carry none - the existing "awaiting verdict"
// test already proves this implicitly (no "pull request:" substring),
// here it's asserted explicitly before the positive case below.
test("runStatusCommand: a delivered task with no reported pull request shows no url", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  await createForeman({ recordHome, inspector: fixtureInspector() }).do("small change", { project, brain: fakeBrain() });
  const io = captureIo();

  await runStatusCommand([], { recordHome, ...io });

  assert.doesNotMatch(taskRows(io.out)[0], /pull request/);
});

test("runStatusCommand: a delivered task's line shows the reported pull request url exactly once", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo("exit 0");
  const inspector = {
    async inspect() {
      return { verdict: "green" as const, report: "ok", prUrl: "https://example.test/pulls/7" };
    },
  };
  await createForeman({ recordHome, inspector }).do("small change", { project, brain: fakeBrain() });
  const io = captureIo();

  const code = await runStatusCommand([], { recordHome, ...io });

  assert.equal(code, 0);
  const rows = taskRows(io.out);
  assert.equal(rows.length, 1);
  const occurrences = rows[0].split("https://example.test/pulls/7").length - 1;
  assert.equal(occurrences, 1, `expected the url exactly once, got: ${rows[0]}`);
});

test("runStatusCommand: a task-failed task shows FAILED with its reason, not working", async () => {
  const recordHome = tempRecordHome();
  appendEvent(recordHome, { taskId: "t1", name: "task-received" });
  appendEvent(recordHome, { taskId: "t1", name: "line-cut", details: { branch: "fabrica/t1", reopened: false } });
  appendEvent(recordHome, { taskId: "t1", name: "task-failed", details: { message: "no check.sh in /some/project" } });
  const io = captureIo();

  await runStatusCommand([], { recordHome, ...io });

  const rows = taskRows(io.out);
  assert.match(rows[0], /^t1\s.*\sfailed\s/);
  assert.match(rows[0], /FAILED/);
  assert.match(rows[0], /no check\.sh in \/some\/project/);
  assert.doesNotMatch(rows[0], /working|quiet/);
});

// Issues #81/#110: the opening line, no cap set.
test("runStatusCommand: opens with the spend line saying no daily cap, when none is set", async () => {
  const recordHome = tempRecordHome();
  const io = captureIo();

  const code = await runStatusCommand([], { recordHome, ...io });

  assert.equal(code, 0);
  assert.equal(io.out[0], "spent in the last 24 hours: $0.00, no daily cap");
});

// Issues #81/#110: the opening line must use the exact same knownUsd the
// daily cap check (caps.ts's requireRoomToStart) derives from daySpend -
// computed independently here from the same record, to the cent.
test("runStatusCommand: the spend line matches daySpend to the cent, with a cap set", async () => {
  const recordHome = tempRecordHome();
  writeFileSync(join(recordHome, "projects.toml"), "[caps]\nperDayUsd = 100\n");
  const project = makeFixtureRepo("exit 0");
  await createForeman({ recordHome, caps: { perDayUsd: 100 }, inspector: fixtureInspector() }).do("measured", {
    project,
    brain: fakeBrain({ costUsd: 0.0421 }),
  });
  const now = Date.now();
  const expectedMeteredUsd = daySpend(readEvents(recordHome), now).meteredUsd;
  const io = captureIo();

  const code = await runStatusCommand([], { recordHome, now, ...io });

  assert.equal(code, 0);
  assert.equal(io.out[0], `spent in the last 24 hours: ${formatUsd(expectedMeteredUsd)} of $100.00`);
});

// Issue #188: a flat-rate subscription's own notional figure never binds
// the cap, and the opening line names it separately from metered spend.
test("runStatusCommand: the spend line names a subscription estimate separately, and it never counts against the cap", async () => {
  const recordHome = tempRecordHome();
  writeFileSync(join(recordHome, "projects.toml"), "[caps]\nperDayUsd = 5\n");
  const project = makeFixtureRepo("exit 0");
  const foreman = createForeman({ recordHome, caps: { perDayUsd: 5 }, inspector: fixtureInspector() });

  // Far more than the $5 cap, but notional - must not block anything.
  const subTask = await foreman.do("subscription work", {
    project,
    brain: fakeBrain({ costUsd: 50, costBasis: "subscription-estimate" }),
  });
  assert.equal(subTask.state, "delivered");
  await foreman.do("metered work, well under the cap", { project, brain: fakeBrain({ costUsd: 1 }) });

  const io = captureIo();
  const code = await runStatusCommand([], { recordHome, ...io });

  assert.equal(code, 0);
  assert.equal(
    io.out[0],
    "spent in the last 24 hours: $1.00 of $5.00 (+ ~$50.00 subscription-estimate, not counted against the cap)"
  );
});

// Issue #189: the subscription meters, shown with the same numbers the
// pause rule itself decides with.

/** One receipt's worth of meter reading on the record - the only place
 * a reading ever lands. */
function recordReading(
  recordHome: string,
  taskId: string,
  meters: { observedAt: string; fiveHourPercent: number | null; sevenDayPercent: number | null }
): void {
  appendEvent(recordHome, {
    taskId,
    name: "task-received",
  });
  appendEvent(recordHome, {
    taskId,
    name: "receipt-recorded",
    details: {
      receipt: {
        task: taskId,
        attempt: 1,
        brain: "fake",
        model: "fake-1",
        startedAt: meters.observedAt,
        durationMs: 1,
        costUsd: 0,
        costUnknown: false,
        costBasis: "subscription-estimate",
        meters,
        session: null,
        reasoningEffort: null,
        checks: null,
        outcome: "delivered",
      },
    },
  });
}

test("runStatusCommand: the meters line shows both windows and the pause rule's thresholds", async () => {
  const recordHome = tempRecordHome();
  const now = Date.now();
  recordReading(recordHome, "task-read", {
    observedAt: new Date(now - 60_000).toISOString(),
    fiveHourPercent: 7,
    sevenDayPercent: 64,
  });

  const io = captureIo();
  assert.equal(await runStatusCommand([], { recordHome, now, ...io }), 0);

  const line = io.out.find((l) => l.startsWith("subscription meters:"));
  assert.ok(line, io.out.join("\n"));
  assert.match(line!, /5h 7%, 7d 64%/);
  assert.match(line!, /new work stops above 70% of the week, running work above 90%/);
});

test("runStatusCommand: the meters line says new work is paused when the week is over its threshold", async () => {
  const recordHome = tempRecordHome();
  const now = Date.now();
  recordReading(recordHome, "task-read", {
    observedAt: new Date(now - 60_000).toISOString(),
    fiveHourPercent: 20,
    sevenDayPercent: 77,
  });

  const io = captureIo();
  await runStatusCommand([], { recordHome, now, ...io });

  const line = io.out.find((l) => l.startsWith("subscription meters:"))!;
  assert.match(line, /NEW WORK PAUSED/);
  assert.match(line, /77% of the 7-day window/);
});

test("runStatusCommand: with no reading at all, the meters line says so and that nothing is being refused", async () => {
  const io = captureIo();
  await runStatusCommand([], { recordHome: tempRecordHome(), ...io });

  const line = io.out.find((l) => l.startsWith("subscription meters:"))!;
  assert.match(line, /not read yet/);
  assert.match(line, /refusing nothing/);
});

test("runStatusCommand: a stale reading is shown but explicitly not acted on", async () => {
  const recordHome = tempRecordHome();
  const now = Date.now();
  recordReading(recordHome, "task-read", {
    observedAt: new Date(now - 6 * 60 * 60 * 1000).toISOString(),
    fiveHourPercent: 99,
    sevenDayPercent: 99,
  });

  const io = captureIo();
  await runStatusCommand([], { recordHome, now, ...io });

  const line = io.out.find((l) => l.startsWith("subscription meters:"))!;
  assert.match(line, /5h 99%, 7d 99%/, "the numbers are still shown - hiding them would hide the problem");
  assert.match(line, /too stale to judge by/);
  assert.doesNotMatch(line, /NEW WORK PAUSED/);
});

test("runStatusCommand: a task a meter paused reads as waiting on the Client, with the pause named", async () => {
  const recordHome = tempRecordHome();
  const now = Date.now();
  const taskId = "task-paused";
  appendEvent(recordHome, { taskId, name: "task-received" });
  appendEvent(recordHome, { taskId, name: "work-started", details: { project: "/repos/demo" } });
  appendEvent(recordHome, {
    taskId,
    name: "meter-paused",
    details: {
      attempt: 1,
      usedPercent: 93,
      thresholdPercent: 90,
      observedAt: new Date(now).toISOString(),
      message: "Paused by the subscription meter: 93% of the 7-day window is used, past the 90% this task stops at.",
      workerStopped: true,
    },
  });
  appendEvent(recordHome, {
    taskId,
    name: "delivered",
    details: { outcome: "paused-by-meter", project: "/repos/demo" },
  });

  const io = captureIo();
  await runStatusCommand([], { recordHome, now, ...io });

  const row = taskRows(io.out).find((l) => l.includes(taskId))!;
  assert.match(row, /delivered/, "a pause waits on the Client's verdict, exactly like any delivery");
  assert.match(row, /PAUSED BY THE SUBSCRIPTION METER/);
  assert.match(row, /93% of the 7-day window/);
  assert.match(row, new RegExp(`fabrica verdict ${taskId} fix`));
  assert.doesNotMatch(row, /FAILED/, "a pause is never a failure (Client's clarification)");
});
