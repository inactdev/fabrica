// The signaling half of issue #203's `stop`. The dangerous part of this
// file is not the HTTP route - it's that something here sends a real
// signal to a real pid, so these tests exercise the refusals hardest:
// every way a pid can turn out to be the wrong one must end in "nothing
// found", never in a signal.
//
// The two tests that genuinely signal something spawn their own
// throwaway child (detached, so it leads its own process group exactly
// as a real task runner does) rather than faking `process.kill` - the
// whole point of this module is what the operating system actually does
// with the signal, which a stub could not tell us.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTask, readTaskFile, writeTaskFile } from "../record/index.ts";
import {
  cachedProcessTable,
  commandLineMatchesTask,
  findTaskProcess,
  probeTaskWorker,
  STOP_GRACE_MS,
  stopTaskProcess,
  writeTaskPidFile,
} from "./task-process.ts";

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-task-process-"));
}

/** A process table holding exactly this test process, claiming whatever
 * command line the caller wants it to have. Using our own pid is what
 * makes the liveness check pass for real rather than being stubbed. */
function tableClaiming(args: string): () => { pid: number; args: string }[] {
  return () => [{ pid: process.pid, args }];
}

const DO_RUNNER = `/usr/local/bin/node /checkout/src/cli/tsx-bootstrap.mjs /checkout/src/cli/run-task-entry.ts /home/.fabrica /proj "do a thing"`;

test("writeTaskPidFile records this process's own pid in the task's folder", () => {
  const recordHome = freshHome();
  const { id } = registerTask(recordHome, "a task");

  writeTaskPidFile(recordHome, id);

  assert.equal(readTaskFile(recordHome, id, "worker.pid"), String(process.pid));
});

test("a pid file plus a matching command line identifies the task's process", () => {
  const recordHome = freshHome();
  const { id } = registerTask(recordHome, "a task");
  writeTaskPidFile(recordHome, id);

  assert.deepEqual(findTaskProcess(recordHome, id, { listProcesses: tableClaiming(DO_RUNNER) }), { pid: process.pid });
});

test("no pid file means nothing found - never a guess at which process it might be", () => {
  const recordHome = freshHome();
  const { id } = registerTask(recordHome, "a task");

  assert.equal(findTaskProcess(recordHome, id, { listProcesses: tableClaiming(DO_RUNNER) }), null);
});

test("a pid whose command line is something else entirely is refused, stale number and all", () => {
  const recordHome = freshHome();
  const { id } = registerTask(recordHome, "a task");
  writeTaskPidFile(recordHome, id);

  // The exact hazard this check exists for: the task's process exited,
  // its number got recycled, and something unrelated now holds it.
  assert.equal(findTaskProcess(recordHome, id, { listProcesses: tableClaiming("/usr/bin/postgres -D /var/db") }), null);
});

test("a pid missing from the process table altogether is refused", () => {
  const recordHome = freshHome();
  const { id } = registerTask(recordHome, "a task");
  writeTaskPidFile(recordHome, id);

  assert.equal(findTaskProcess(recordHome, id, { listProcesses: () => [] }), null);
});

test("a dead pid is refused without ever consulting the process table", () => {
  const recordHome = freshHome();
  const { id } = registerTask(recordHome, "a task");
  // Pid 2^22 is above every documented pid_max, so it cannot be live.
  writeTaskFile(recordHome, id, "worker.pid", "4194304");

  let consulted = false;
  const found = findTaskProcess(recordHome, id, {
    listProcesses: () => {
      consulted = true;
      return [];
    },
  });

  assert.equal(found, null);
  assert.equal(consulted, false);
});

test("a garbled pid file is refused rather than parsed into something", () => {
  const recordHome = freshHome();
  const { id } = registerTask(recordHome, "a task");

  for (const garbage of ["", "   ", "not-a-pid", "-1", "0", "12.5nonsense"]) {
    writeTaskFile(recordHome, id, "worker.pid", garbage);
    assert.equal(
      findTaskProcess(recordHome, id, { listProcesses: tableClaiming(DO_RUNNER) }),
      null,
      `"${garbage}" must not resolve to a process`
    );
  }
});

test("an answer or fix runner must carry THIS task's id, not just be a Fabrica runner", () => {
  const recordHome = freshHome();
  const { id } = registerTask(recordHome, "a task");
  writeTaskPidFile(recordHome, id);

  const otherTask = `node bootstrap.mjs /checkout/src/cli/answer-entry.ts /home/.fabrica task-someone-else`;
  assert.equal(findTaskProcess(recordHome, id, { listProcesses: tableClaiming(otherTask) }), null);

  const sameTask = `node bootstrap.mjs /checkout/src/cli/verdict-fix-entry.ts /home/.fabrica ${id}`;
  assert.deepEqual(findTaskProcess(recordHome, id, { listProcesses: tableClaiming(sameTask) }), { pid: process.pid });
});

test("commandLineMatchesTask names exactly the three detached runners and nothing else", () => {
  assert.equal(commandLineMatchesTask(DO_RUNNER, "task-1"), true);
  assert.equal(commandLineMatchesTask("node x/src/cli/answer-entry.ts /home task-1", "task-1"), true);
  assert.equal(commandLineMatchesTask("node x/src/cli/verdict-fix-entry.ts /home task-1", "task-1"), true);
  // The live view is a Fabrica process too, and must never be mistaken
  // for a task's worker.
  assert.equal(commandLineMatchesTask("node x/integrations/live-view/start.ts", "task-1"), false);
  assert.equal(commandLineMatchesTask("node x/src/cli/bin.mjs status", "task-1"), false);
  assert.equal(commandLineMatchesTask("", "task-1"), false);
});

// Issue #99: the reporting side. `status`/`watch` never signal anything,
// so what matters here is the opposite of the tests above - not "a wrong
// pid must never be signaled" but "a reading we don't have must never be
// reported as a worker that's gone". Each way of not knowing gets its own
// test, because collapsing any of them into "not-found" would put a
// confident false alarm on the Client's status line.

test("probeTaskWorker: a verified live runner reads as alive", () => {
  const recordHome = freshHome();
  const { id } = registerTask(recordHome, "a task");
  writeTaskPidFile(recordHome, id);

  assert.equal(probeTaskWorker(recordHome, id, { listProcesses: tableClaiming(DO_RUNNER) }), "alive");
});

test("probeTaskWorker: no pid file at all reads as unknown, never as a missing worker", () => {
  const recordHome = freshHome();
  const { id } = registerTask(recordHome, "a task");

  // A round already in flight when pid files landed (issue #203) has
  // none, and nothing whatsoever follows from that about its worker.
  let consulted = false;
  const presence = probeTaskWorker(recordHome, id, {
    listProcesses: () => {
      consulted = true;
      return [{ pid: process.pid, args: DO_RUNNER }];
    },
  });

  assert.equal(presence, "unknown");
  assert.equal(consulted, false, "with no pid to check, there is nothing to ask the process table about");
});

test("probeTaskWorker: a pid belonging to something unrelated now reads as not-found", () => {
  const recordHome = freshHome();
  const { id } = registerTask(recordHome, "a task");
  writeTaskPidFile(recordHome, id);

  assert.equal(
    probeTaskWorker(recordHome, id, { listProcesses: tableClaiming("/usr/bin/postgres -D /var/db") }),
    "not-found"
  );
});

test("probeTaskWorker: a dead pid reads as not-found", () => {
  const recordHome = freshHome();
  const { id } = registerTask(recordHome, "a task");
  // Above every documented pid_max, so it cannot be live.
  writeTaskFile(recordHome, id, "worker.pid", "4194304");

  assert.equal(probeTaskWorker(recordHome, id, { listProcesses: tableClaiming(DO_RUNNER) }), "not-found");
});

test("probeTaskWorker: a garbled pid file reads as not-found, not parsed into something", () => {
  const recordHome = freshHome();
  const { id } = registerTask(recordHome, "a task");

  for (const garbage of ["", "   ", "not-a-pid", "-1", "0"]) {
    writeTaskFile(recordHome, id, "worker.pid", garbage);
    assert.equal(
      probeTaskWorker(recordHome, id, { listProcesses: tableClaiming(DO_RUNNER) }),
      "not-found",
      `"${garbage}" must not read as a live worker`
    );
  }
});

test("probeTaskWorker: an unusable process table reads as unknown - a missing `ps` is not a missing worker", () => {
  const recordHome = freshHome();
  const { id } = registerTask(recordHome, "a task");
  writeTaskPidFile(recordHome, id);

  // listProcesses (live-view-process.ts) degrades to [] when no `ps` it
  // can use exists. An empty table is never the truth - this very
  // process is in it - so the only honest answer is "can't tell".
  assert.equal(probeTaskWorker(recordHome, id, { listProcesses: () => [] }), "unknown");
});

test("cachedProcessTable: reads the real table once, however many tasks ask", () => {
  let reads = 0;
  const table = cachedProcessTable(() => {
    reads++;
    return [{ pid: process.pid, args: DO_RUNNER }];
  });

  const recordHome = freshHome();
  for (const text of ["one", "two", "three"]) {
    const { id } = registerTask(recordHome, text);
    writeTaskPidFile(recordHome, id);
    assert.equal(probeTaskWorker(recordHome, id, { listProcesses: table }), "alive");
  }

  assert.equal(reads, 1, "a `fabrica status` listing must not spawn one `ps` per open task");
});

/** A throwaway child that outlives its own spawn call, leads its own
 * process group (`detached`, exactly as spawn-detached.ts's runners do),
 * and either dies on SIGTERM or deliberately ignores it. It announces
 * itself on stdout once it is genuinely ready - the handler installed,
 * if it has one - so a test never races the child's own startup and
 * mistakes a SIGTERM that landed too early for a SIGKILL that worked. */
async function throwawayChild(ignoreTerm: boolean) {
  const handler = ignoreTerm ? "process.on('SIGTERM', () => {});" : "";
  const child = spawn(process.execPath, ["-e", `${handler} console.log('ready'); setInterval(() => {}, 1000);`], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
  return { child, exited };
}

test("stopTaskProcess sends a SIGTERM that really reaches the process", async () => {
  const { child, exited } = await throwawayChild(false);
  assert.ok(child.pid, "the child must have started");

  // No SIGKILL needed here, so the grace step is given a schedule that
  // never fires - this test is only about the first signal.
  const sent = stopTaskProcess(child.pid!, { schedule: () => {} });

  assert.equal(sent, true);
  await exited;
  assert.equal(child.signalCode, "SIGTERM", "it died of the signal stop actually sent");
});

test("a process that ignores SIGTERM is killed once the grace period is up", async () => {
  const { child, exited } = await throwawayChild(true);
  assert.ok(child.pid, "the child must have started");

  // graceMs deliberately left at its default, so this proves the real
  // ten-second grace the Client asked for is what would be waited out.
  let graceMs: number | null = null;
  stopTaskProcess(child.pid!, {
    schedule: (fn, ms) => {
      graceMs = ms;
      fn();
    },
  });

  assert.equal(graceMs, STOP_GRACE_MS);
  assert.equal(STOP_GRACE_MS, 10_000, "ten seconds, as ruled");
  await exited;
  assert.equal(child.signalCode, "SIGKILL", "SIGTERM was ignored, so the grace period's kill is what ended it");
});
