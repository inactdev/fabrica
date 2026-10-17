// Rebuilt around the four Herdr commands the Client has verified by
// hand on his real Herdr (README.md): `tab create`, `pane run`, `pane
// report-agent`, `pane release-agent` - nothing else. Negative tests
// first: proving the watcher never calls `pane split` or `agent
// rename`, that a failing call is logged and the watcher keeps running,
// and that only the three promised states ever appear - before the
// happy-path state-mapping tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { appendEvent, registerTask } from "../../src/record/index.ts";
import {
  createHerdrWatcher,
  herdrWatcherLogPath,
  herdrWatcherStatus,
  isHerdrWatcherRunning,
  parseProcStatState,
} from "./herdr-watcher.ts";

const FAKE_HERDR = join(dirname(fileURLToPath(import.meta.url)), "helpers", "fake-herdr.mjs");
const ZOMBIE_PARENT = join(dirname(fileURLToPath(import.meta.url)), "helpers", "zombie-parent.mjs");

function makeRecordHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-herdr-record-"));
}

interface LoggedCall {
  args: string[];
}

function withFakeHerdr(env: Record<string, string>, run: (readCalls: () => LoggedCall[]) => void): void {
  const logPath = join(mkdtempSync(join(tmpdir(), "fabrica-herdr-log-")), "calls.jsonl");
  const vars: Record<string, string> = { FAKE_HERDR_LOG: logPath, ...env };
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    previous[key] = process.env[key];
    process.env[key] = vars[key];
  }
  try {
    run(() =>
      existsSync(logPath)
        ? readFileSync(logPath, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : []
    );
  } finally {
    for (const key of Object.keys(vars)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function withFakeHerdrLog(run: (readCalls: () => LoggedCall[]) => void): void {
  withFakeHerdr({}, run);
}

function watcherOver(recordHome: string): ReturnType<typeof createHerdrWatcher> {
  return createHerdrWatcher({ recordHome, herdrBin: [process.execPath, FAKE_HERDR] });
}

test("a task-received event runs exactly tab create, pane run, and report-agent - in that order, with the parsed pane id", () => {
  withFakeHerdrLog((readCalls) => {
    const recordHome = makeRecordHome();
    const watcher = watcherOver(recordHome);

    const { id } = registerTask(recordHome, "Fix the login bug");
    watcher.pollOnce();
    // A second poll with nothing new must not repeat any of this.
    watcher.pollOnce();

    const calls = readCalls();
    assert.equal(calls.length, 3, `expected exactly three Herdr calls, got ${JSON.stringify(calls)}`);

    assert.deepEqual(calls[0].args, ["tab", "create", "--no-focus", "--label", "Fix the login bug"]);
    assert.deepEqual(calls[1].args, ["pane", "run", "w1:p1", `FABRICA_HOME=${recordHome} fabrica watch ${id}`]);
    assert.deepEqual(calls[2].args, [
      "pane",
      "report-agent",
      "w1:p1",
      "--source",
      "custom:fabrica",
      "--agent",
      "Fix the login bug",
      "--state",
      "working",
      "--seq",
      "1",
    ]);
  });
});

test("the watcher never calls pane split or agent rename", () => {
  withFakeHerdrLog((readCalls) => {
    const recordHome = makeRecordHome();
    const watcher = watcherOver(recordHome);

    const { id } = registerTask(recordHome, "Fix the login bug");
    watcher.pollOnce();
    appendEvent(recordHome, { taskId: id, name: "heartbeat", details: {} });
    appendEvent(recordHome, { taskId: id, name: "delivered", details: {} });
    watcher.pollOnce();
    appendEvent(recordHome, { taskId: id, name: "verdict-recorded", details: { ruling: "accept", note: "" } });
    watcher.pollOnce();

    const calls = readCalls();
    assert.ok(calls.length > 0);
    for (const call of calls) {
      assert.ok(!(call.args[0] === "pane" && call.args[1] === "split"), "must never call pane split");
      assert.ok(!(call.args[0] === "agent" && call.args[1] === "rename"), "must never call agent rename");
      assert.ok(!(call.args[0] === "pane" && call.args[1] === "report-metadata"), "must never call pane report-metadata");
    }
  });
});

test("each record event maps to the documented state and message", () => {
  withFakeHerdrLog((readCalls) => {
    const recordHome = makeRecordHome();
    const watcher = watcherOver(recordHome);

    const { id } = registerTask(recordHome, "Fix the login bug");
    watcher.pollOnce(); // task-received -> working, seq 1

    appendEvent(recordHome, { taskId: id, name: "heartbeat", details: {} });
    watcher.pollOnce();

    appendEvent(recordHome, { taskId: id, name: "questions-asked", details: { questions: ["Which database?"] } });
    watcher.pollOnce();

    appendEvent(recordHome, { taskId: id, name: "delivered", details: {} });
    watcher.pollOnce();

    appendEvent(recordHome, { taskId: id, name: "task-failed", details: { message: "boom" } });
    watcher.pollOnce();

    const reports = readCalls().filter((c) => c.args[0] === "pane" && c.args[1] === "report-agent");
    const common = ["w1:p1", "--source", "custom:fabrica", "--agent", "Fix the login bug"];
    assert.deepEqual(reports.map((c) => c.args.slice(2)), [
      [...common, "--state", "working", "--seq", "1"],
      [...common, "--state", "working", "--seq", "2"],
      [...common, "--state", "blocked", "--seq", "3", "--message", "asked a question"],
      [...common, "--state", "idle", "--seq", "4", "--message", "delivered - awaiting your verdict"],
      [...common, "--state", "blocked", "--seq", "5", "--message", "failed - see fabrica log"],
    ]);
  });
});

test("a verdict-recorded event with ruling accept or wrong releases the agent instead of reporting a state", () => {
  withFakeHerdrLog((readCalls) => {
    const recordHome = makeRecordHome();
    const watcher = watcherOver(recordHome);

    const { id } = registerTask(recordHome, "Fix the login bug");
    watcher.pollOnce(); // seq 1

    appendEvent(recordHome, { taskId: id, name: "verdict-recorded", details: { ruling: "accept", note: "" } });
    watcher.pollOnce();

    const releases = readCalls().filter((c) => c.args[0] === "pane" && c.args[1] === "release-agent");
    assert.deepEqual(releases.map((c) => c.args.slice(2)), [
      ["w1:p1", "--source", "custom:fabrica", "--agent", "Fix the login bug", "--seq", "2"],
    ]);
  });
});

for (const ruling of ["accept", "wrong"]) {
  test(`a verdict-recorded event with ruling ${ruling} releases the agent, then sends ctrl+c, then closes the tab, in that order`, () => {
    withFakeHerdrLog((readCalls) => {
      const recordHome = makeRecordHome();
      const watcher = watcherOver(recordHome);

      const { id } = registerTask(recordHome, "Fix the login bug");
      watcher.pollOnce(); // seq 1 - tab create / pane run / report-agent

      appendEvent(recordHome, { taskId: id, name: "verdict-recorded", details: { ruling, note: "" } });
      watcher.pollOnce();

      const calls = readCalls().slice(3); // after task-received's three calls
      assert.equal(calls.length, 3, `expected exactly release-agent, send-keys, and tab close, got ${JSON.stringify(calls)}`);

      assert.deepEqual(calls[0].args, [
        "pane",
        "release-agent",
        "w1:p1",
        "--source",
        "custom:fabrica",
        "--agent",
        "Fix the login bug",
        "--seq",
        "2",
      ]);
      assert.deepEqual(calls[1].args, ["pane", "send-keys", "w1:p1", "ctrl+c"]);
      assert.deepEqual(calls[2].args, ["tab", "close", "w1:t1"]);
    });
  });
}

test("no event other than a closing verdict (accept or wrong) ever closes a tab", () => {
  withFakeHerdrLog((readCalls) => {
    const recordHome = makeRecordHome();
    const watcher = watcherOver(recordHome);

    const { id } = registerTask(recordHome, "Fix the login bug");
    watcher.pollOnce();
    appendEvent(recordHome, { taskId: id, name: "heartbeat", details: {} });
    appendEvent(recordHome, { taskId: id, name: "questions-asked", details: { questions: ["?"] } });
    appendEvent(recordHome, { taskId: id, name: "delivered", details: {} });
    appendEvent(recordHome, { taskId: id, name: "task-failed", details: { message: "boom" } });
    appendEvent(recordHome, { taskId: id, name: "verdict-recorded", details: { ruling: "fix", note: "try again" } });
    watcher.pollOnce();

    assert.deepEqual(
      readCalls().filter((c) => c.args[0] === "tab" && c.args[1] === "close"),
      []
    );

    appendEvent(recordHome, { taskId: id, name: "verdict-recorded", details: { ruling: "accept", note: "" } });
    watcher.pollOnce();

    const closes = readCalls().filter((c) => c.args[0] === "tab" && c.args[1] === "close");
    assert.equal(closes.length, 1, "only the closing verdict should ever close the tab");
  });
});

test("a failing tab close is logged with its exact arguments, and the watcher keeps running afterward", () => {
  withFakeHerdr({ FAKE_HERDR_FAIL_SUBCOMMAND: "tab close", FAKE_HERDR_FAIL_TIMES: "1" }, (readCalls) => {
    const recordHome = makeRecordHome();
    const watcher = watcherOver(recordHome);

    const a = registerTask(recordHome, "Task A");
    watcher.pollOnce();
    appendEvent(recordHome, { taskId: a.id, name: "verdict-recorded", details: { ruling: "accept", note: "" } });
    watcher.pollOnce();

    const logPath = herdrWatcherLogPath(recordHome);
    assert.ok(existsSync(logPath), "a failing tab close should be logged");
    const logged = readFileSync(logPath, "utf8");
    assert.match(logged, /tab close w1:t1 failed: .*simulated failure for/s);

    // release-agent and send-keys still ran before the failing close.
    assert.ok(readCalls().some((c) => c.args[0] === "pane" && c.args[1] === "release-agent"));
    assert.ok(readCalls().some((c) => c.args[0] === "pane" && c.args[1] === "send-keys"));

    // The watcher must still be usable afterward - a second task goes
    // through tab create/run/report-agent and its own close normally.
    const b = registerTask(recordHome, "Task B");
    watcher.pollOnce();
    appendEvent(recordHome, { taskId: b.id, name: "verdict-recorded", details: { ruling: "wrong", note: "" } });
    watcher.pollOnce();

    const closesForB = readCalls().filter((c) => c.args[0] === "tab" && c.args[1] === "close" && c.args[2] === "w1:t2");
    assert.equal(closesForB.length, 1, "a later task's tab close should still succeed");
  });
});

test("a verdict-recorded event with ruling fix neither reports a new state nor releases - the task stays open", () => {
  withFakeHerdrLog((readCalls) => {
    const recordHome = makeRecordHome();
    const watcher = watcherOver(recordHome);

    const { id } = registerTask(recordHome, "Fix the login bug");
    watcher.pollOnce(); // seq 1

    appendEvent(recordHome, { taskId: id, name: "verdict-recorded", details: { ruling: "fix", note: "try again" } });
    watcher.pollOnce();
    assert.equal(readCalls().length, 3, "a fix verdict must not itself produce a Herdr call");

    appendEvent(recordHome, { taskId: id, name: "heartbeat", details: {} });
    watcher.pollOnce();

    const reports = readCalls().filter((c) => c.args[0] === "pane" && c.args[1] === "report-agent");
    assert.deepEqual(reports.at(-1)?.args.slice(2), [
      "w1:p1",
      "--source",
      "custom:fabrica",
      "--agent",
      "Fix the login bug",
      "--state",
      "working",
      "--seq",
      "2",
    ]);
  });
});

test("--seq increases by one on every report or release call for a task, independently per task", () => {
  withFakeHerdrLog((readCalls) => {
    const recordHome = makeRecordHome();
    const watcher = watcherOver(recordHome);

    const a = registerTask(recordHome, "Task A");
    watcher.pollOnce();
    const b = registerTask(recordHome, "Task B");
    watcher.pollOnce();

    appendEvent(recordHome, { taskId: a.id, name: "heartbeat", details: {} });
    appendEvent(recordHome, { taskId: a.id, name: "heartbeat", details: {} });
    appendEvent(recordHome, { taskId: b.id, name: "heartbeat", details: {} });
    watcher.pollOnce();

    const seqFor = (paneId: string) =>
      readCalls()
        .filter((c) => c.args[0] === "pane" && (c.args[1] === "report-agent" || c.args[1] === "release-agent") && c.args[2] === paneId)
        .map((c) => c.args[c.args.indexOf("--seq") + 1]);

    assert.deepEqual(seqFor("w1:p1"), ["1", "2", "3"]); // task-received + two heartbeats
    assert.deepEqual(seqFor("w1:p2"), ["1", "2"]); // task-received + one heartbeat
  });
});

test("only the states working, idle, and blocked are ever sent", () => {
  withFakeHerdrLog((readCalls) => {
    const recordHome = makeRecordHome();
    const watcher = watcherOver(recordHome);

    const { id } = registerTask(recordHome, "Fix the login bug");
    watcher.pollOnce();
    appendEvent(recordHome, { taskId: id, name: "heartbeat", details: {} });
    appendEvent(recordHome, { taskId: id, name: "questions-asked", details: { questions: ["?"] } });
    appendEvent(recordHome, { taskId: id, name: "delivered", details: {} });
    appendEvent(recordHome, { taskId: id, name: "task-failed", details: { message: "boom" } });
    watcher.pollOnce();

    const reports = readCalls().filter((c) => c.args[0] === "pane" && c.args[1] === "report-agent");
    const states = reports.map((c) => c.args[c.args.indexOf("--state") + 1]);
    for (const state of states) {
      assert.ok(["working", "idle", "blocked"].includes(state), `unexpected state reported: ${state}`);
    }
    assert.ok(states.length > 0);
  });
});

test("a failing Herdr call is logged with its exact arguments and output, and the next poll still runs", () => {
  withFakeHerdr({ FAKE_HERDR_FAIL_SUBCOMMAND: "pane report-agent", FAKE_HERDR_FAIL_TIMES: "1" }, (readCalls) => {
    const recordHome = makeRecordHome();
    const watcher = watcherOver(recordHome);

    const a = registerTask(recordHome, "Task A");
    watcher.pollOnce(); // task-received's report-agent call is the one that fails

    const logPath = herdrWatcherLogPath(recordHome);
    assert.ok(existsSync(logPath), "a failing call should be logged");
    const logged = readFileSync(logPath, "utf8");
    assert.match(logged, /pane report-agent w1:p1 --source custom:fabrica --agent Task A --state working --seq 1/);
    assert.match(logged, /simulated failure for/);

    // The watcher must still be usable on the next poll - a second task
    // goes through all three calls normally.
    const b = registerTask(recordHome, "Task B");
    watcher.pollOnce();

    const tabCreates = readCalls().filter((c) => c.args[0] === "tab" && c.args[1] === "create");
    assert.equal(tabCreates.length, 2, "both tasks should have gotten a tab");

    const reportsForB = readCalls().filter(
      (c) => c.args[0] === "pane" && c.args[1] === "report-agent" && c.args[2] === "w1:p2"
    );
    assert.deepEqual(reportsForB.map((c) => c.args.slice(3)), [
      ["--source", "custom:fabrica", "--agent", "Task B", "--state", "working", "--seq", "1"],
    ]);

    // Task A's own heartbeat still works too, on a later poll - the one
    // failed call isn't retried, but the task itself stays registered.
    appendEvent(recordHome, { taskId: a.id, name: "heartbeat", details: {} });
    watcher.pollOnce();
    const reportsForA = readCalls().filter(
      (c) => c.args[0] === "pane" && c.args[1] === "report-agent" && c.args[2] === "w1:p1"
    );
    assert.deepEqual(reportsForA.at(-1)?.args.slice(3), [
      "--source",
      "custom:fabrica",
      "--agent",
      "Task A",
      "--state",
      "working",
      "--seq",
      "2",
    ]);
  });
});

test("a task this watcher never opened a tab for (received before it started) is ignored", () => {
  withFakeHerdrLog((readCalls) => {
    const recordHome = makeRecordHome();
    // Registered, and already past questions, before the watcher exists -
    // this watcher drains that history at startup rather than reopening a
    // tab for a task that may already be long closed.
    const { id } = registerTask(recordHome, "Older task");
    appendEvent(recordHome, { taskId: id, name: "questions-asked", details: { questions: ["?"] } });

    const watcher = watcherOver(recordHome);
    watcher.pollOnce();

    assert.deepEqual(readCalls(), []);
  });
});

test("the task's title is its request text's first line, cut to 60 characters, reused for every call", () => {
  withFakeHerdrLog((readCalls) => {
    const recordHome = makeRecordHome();
    const watcher = watcherOver(recordHome);

    const longText = "x".repeat(100);
    const { id } = registerTask(recordHome, `${longText}\nmore detail on a second line`);
    watcher.pollOnce();

    const expectedTitle = `${"x".repeat(57)}...`;
    assert.equal(expectedTitle.length, 60);

    const calls = readCalls();
    assert.deepEqual(calls[0].args.slice(-1), [expectedTitle]);
    assert.ok(calls[2].args.includes(expectedTitle));
    void id;
  });
});

test("herdrWatcherStatus: never-started with no pid file at all", () => {
  const recordHome = makeRecordHome();
  assert.equal(herdrWatcherStatus(recordHome), "never-started");
  assert.equal(isHerdrWatcherRunning(recordHome), false);
});

test("herdrWatcherStatus: running when the pid file names a real, live process", () => {
  const recordHome = makeRecordHome();
  writeFileSync(join(recordHome, "herdr-watcher.pid"), String(process.pid), "utf8");

  assert.equal(herdrWatcherStatus(recordHome), "running");
  assert.equal(isHerdrWatcherRunning(recordHome), true);
});

test("parseProcStatState: reads the state field, even when comm holds spaces and parentheses", () => {
  // Real shape, recorded from this project's own container: the second
  // field is parenthesised and can itself contain both, so the state
  // field is only findable after the LAST ")".
  assert.equal(parseProcStatState("127 (MainThread) Z 120 109 109 0 -1 4227084 3407 0\n"), "Z");
  assert.equal(parseProcStatState("841 (node) S 1 841 841 0 -1 4194304 29999 0\n"), "S");
  assert.equal(parseProcStatState("42 (weird (name) here) Z 1 42 42 0\n"), "Z");
  assert.equal(parseProcStatState("nothing parenthesised here"), null);
  assert.equal(parseProcStatState("42 (node)"), null);
});

test("herdrWatcherStatus: a finished-but-unreaped watcher (a zombie) reads as exited, not running", async () => {
  const recordHome = makeRecordHome();
  const pidFile = join(recordHome, "herdr-watcher.pid");
  const handoff = join(makeRecordHome(), "zombie.pid");

  // A real zombie: this child spawns a grandchild that exits at once and
  // then blocks its own event loop forever, so the grandchild is never
  // reaped - the same shape `fabrica up` produces when it spawns the
  // watcher detached and then blocks in the foreground harness.
  const parent = spawn(process.execPath, [ZOMBIE_PARENT, handoff], { stdio: "ignore" });
  try {
    const deadline = Date.now() + 15_000;
    let zombiePid = 0;
    while (zombiePid === 0 && Date.now() < deadline) {
      if (existsSync(handoff)) zombiePid = Number(readFileSync(handoff, "utf8").trim());
      if (zombiePid === 0) await delay(50);
    }
    assert.ok(Number.isInteger(zombiePid) && zombiePid > 0, "the helper should have reported its child's pid");

    // Poll until the grandchild has actually exited (it starts out
    // genuinely running, which must still read as "running").
    let status: ReturnType<typeof herdrWatcherStatus> = "never-started";
    while (Date.now() < deadline) {
      writeFileSync(pidFile, String(zombiePid), "utf8"); // rewritten each turn: "exited" removes it
      status = herdrWatcherStatus(recordHome);
      if (status === "exited") break;
      await delay(50);
    }

    // The assertion that makes this test about zombies at all: the pid
    // must still exist, i.e. signal 0 alone - all this check used to do -
    // would have called it "running" and `fabrica up` would never have
    // started a replacement. If it has been reaped, this is just the
    // ordinary dead-pid case the test above already covers.
    assert.doesNotThrow(
      () => process.kill(zombiePid, 0),
      "the child should still be an unreaped zombie - signal 0 must still find it"
    );
    assert.equal(status, "exited");
    assert.equal(existsSync(pidFile), false, "a zombie's pid file should be cleaned up too");
    writeFileSync(pidFile, String(zombiePid), "utf8");
    assert.equal(isHerdrWatcherRunning(recordHome), false);
  } finally {
    parent.kill("SIGKILL"); // releases the zombie: reparented to init, reaped
  }
});

test("herdrWatcherStatus: exited, and the stale file is removed, when the pid names a process that's gone", () => {
  const recordHome = makeRecordHome();
  // A real pid, guaranteed dead by the time this runs: spawn a trivial
  // child and wait for it to exit.
  const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  const deadPid = dead.pid;
  assert.ok(typeof deadPid === "number" && deadPid > 0);

  const pidFile = join(recordHome, "herdr-watcher.pid");
  writeFileSync(pidFile, String(deadPid), "utf8");

  assert.equal(herdrWatcherStatus(recordHome), "exited");
  assert.equal(existsSync(pidFile), false, "a stale pid file should be cleaned up");
  assert.equal(isHerdrWatcherRunning(recordHome), false);
});
