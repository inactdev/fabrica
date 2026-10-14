import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, appendTaskFile, registerTask } from "../../src/record/index.ts";
import { startLiveView } from "./server.ts";

function tempRecordHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-live-view-server-test-"));
}

/** Every regular file under `dir`, with its size and mtime, so a test can
 * prove a batch of requests touched none of them - including files
 * created after the snapshot, which a plain "nothing changed" diff on
 * existing paths alone would miss. */
function snapshotTree(dir: string): Record<string, { size: number; mtimeMs: number }> {
  const out: Record<string, { size: number; mtimeMs: number }> = {};
  const walk = (current: string) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const stat = statSync(full);
        out[full] = { size: stat.size, mtimeMs: stat.mtimeMs };
      }
    }
  };
  walk(dir);
  return out;
}

test("startLiveView: /api/version reports this running copy's own commit - the real detectCopy-based computation by default", async () => {
  const view = await startLiveView({ recordHome: tempRecordHome(), port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${view.port}/api/version`);
    assert.equal(res.status, 200);
    const body = await res.json();
    // This test runs inside this project's own git checkout, so the
    // real commit is whatever HEAD currently is - the same ground
    // truth src/cli/doctor-command.ts's own "checkout" line reports.
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert.equal(body.commit, head);
  } finally {
    await view.close();
  }
});

test("startLiveView: /api/version reports exactly whatever the commit override returns, overriding the real git lookup", async () => {
  const view = await startLiveView({ recordHome: tempRecordHome(), port: 0, commit: () => "fixed-test-commit" });
  try {
    const res = await fetch(`http://127.0.0.1:${view.port}/api/version`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { commit: "fixed-test-commit" });
  } finally {
    await view.close();
  }
});

test("startLiveView: /api/version reports null, not a crash, when the commit override itself returns null", async () => {
  const view = await startLiveView({ recordHome: tempRecordHome(), port: 0, commit: () => null });
  try {
    const res = await fetch(`http://127.0.0.1:${view.port}/api/version`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { commit: null });
  } finally {
    await view.close();
  }
});

test("startLiveView: binds only to 127.0.0.1, never to every interface", async () => {
  const view = await startLiveView({ recordHome: tempRecordHome(), port: 0 });
  try {
    const address = view.server.address();
    assert.ok(address && typeof address === "object", "expected a bound TCP address");
    assert.equal((address as { address: string }).address, "127.0.0.1");
  } finally {
    await view.close();
  }
});

test("startLiveView: serves /api/state without crashing when the record home does not exist at all", async () => {
  const recordHome = join(tempRecordHome(), "never-created");
  const view = await startLiveView({ recordHome, port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${view.port}/api/state`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.tasks, []);
  } finally {
    await view.close();
  }
});

test("startLiveView: serves /api/state without crashing when the record home exists but is empty", async () => {
  const view = await startLiveView({ recordHome: tempRecordHome(), port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${view.port}/api/state`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.tasks, []);
    assert.equal(body.spend.dailyUsd, 0);
  } finally {
    await view.close();
  }
});

test("startLiveView: serves the static page and rejects everything but GET", async () => {
  const view = await startLiveView({ recordHome: tempRecordHome(), port: 0 });
  try {
    const page = await fetch(`http://127.0.0.1:${view.port}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html/);

    const notFound = await fetch(`http://127.0.0.1:${view.port}/no-such-route`);
    assert.equal(notFound.status, 404);

    const posted = await fetch(`http://127.0.0.1:${view.port}/api/state`, { method: "POST" });
    assert.equal(posted.status, 405);
  } finally {
    await view.close();
  }
});

test("startLiveView: a task id that fails the id pattern is refused before it ever reaches the filesystem", async () => {
  const view = await startLiveView({ recordHome: tempRecordHome(), port: 0 });
  try {
    // A literal "/" smuggled in as "%2f" so it survives routing as one
    // path segment, then decodes back to a slash - exactly what a path-
    // traversal attempt through this parameter would look like.
    const res = await fetch(`http://127.0.0.1:${view.port}/api/tasks/..%2f..%2fetc/transcript`);
    assert.equal(res.status, 400);
  } finally {
    await view.close();
  }
});

test("startLiveView: a task's live transcript tails as it grows", async () => {
  const recordHome = tempRecordHome();
  const taskId = registerTask(recordHome, "stream me").id;
  appendTaskFile(recordHome, taskId, "transcript.log", `${JSON.stringify({ occurredAt: "t0", kind: "stdout", text: "first" })}\n`);

  const view = await startLiveView({ recordHome, port: 0 });
  try {
    const first = await (await fetch(`http://127.0.0.1:${view.port}/api/tasks/${taskId}/transcript`)).json();
    assert.deepEqual(
      first.transcript.map((e: { text: string }) => e.text),
      ["first"]
    );

    appendTaskFile(recordHome, taskId, "transcript.log", `${JSON.stringify({ occurredAt: "t1", kind: "stdout", text: "second" })}\n`);

    const second = await (await fetch(`http://127.0.0.1:${view.port}/api/tasks/${taskId}/transcript`)).json();
    assert.deepEqual(
      second.transcript.map((e: { text: string }) => e.text),
      ["first", "second"]
    );
  } finally {
    await view.close();
  }
});

test("startLiveView: an event with a valid JSON shape but unexpected contents never kills the server - it answers with an error, and keeps answering after", async () => {
  const recordHome = tempRecordHome();
  const taskId = registerTask(recordHome, "confuse the ledger").id;
  // A real receipt, so this task "has attempts" and its cost is actually
  // rendered (describeTaskCost only calls formatUsd down that path) -
  // then a "cost-recorded" event whose "usd" is a string, not a number:
  // valid JSON, wrong type. taskSpend's reduce has no type guard on it,
  // so "knownUsd" silently becomes a string ("0" + the string, via "+"),
  // and formatUsd's usd.toFixed(2) throws once something downstream
  // actually tries to format it - deep inside reused library code this
  // integration never parses itself.
  appendEvent(recordHome, {
    taskId,
    name: "receipt-recorded",
    details: {
      receipt: {
        task: taskId,
        attempt: 1,
        brain: "x",
        model: "y",
        startedAt: new Date().toISOString(),
        durationMs: 1,
        costUsd: 0.42,
        costUnknown: false,
        session: null,
        reasoningEffort: null,
        checks: null,
        outcome: "delivered",
      },
    },
  });
  appendEvent(recordHome, { taskId, name: "cost-recorded", details: { usd: "oops", attempts: [1] } });

  const view = await startLiveView({ recordHome, port: 0 });
  try {
    const first = await fetch(`http://127.0.0.1:${view.port}/api/state`);
    assert.equal(first.status, 200, "the server must still answer, not hang up or crash");
    const firstBody = await first.json();
    assert.match(firstBody.error, /^could not read the record: /);

    // The crux of the ask: a second request right after must still get a
    // real answer - the process is still alive and the server is still
    // listening, not just that this one response object looked fine.
    const second = await fetch(`http://127.0.0.1:${view.port}/api/state`);
    assert.equal(second.status, 200);
    const secondBody = await second.json();
    assert.match(secondBody.error, /^could not read the record: /);
  } finally {
    await view.close();
  }
});

test("startLiveView: an unknown task id's transcript is a 404, not a crash", async () => {
  const view = await startLiveView({ recordHome: tempRecordHome(), port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${view.port}/api/tasks/20260101-ghost-zz/transcript`);
    assert.equal(res.status, 404);
  } finally {
    await view.close();
  }
});

test("startLiveView: /api/tasks/<id> answers a known task's full view, and 404s an unknown one", async () => {
  const recordHome = tempRecordHome();
  const taskId = registerTask(recordHome, "look at me directly").id;
  appendEvent(recordHome, { taskId, name: "work-started", details: { project: "/p" } });

  const view = await startLiveView({ recordHome, port: 0 });
  try {
    const found = await fetch(`http://127.0.0.1:${view.port}/api/tasks/${taskId}`);
    assert.equal(found.status, 200);
    const body = await found.json();
    assert.equal(body.task.id, taskId);
    assert.equal(body.task.project, "/p");

    const notFound = await fetch(`http://127.0.0.1:${view.port}/api/tasks/20260101-ghost-zz`);
    assert.equal(notFound.status, 404);
  } finally {
    await view.close();
  }
});

test("startLiveView: a task id that fails the id pattern is refused on /api/tasks/<id> too", async () => {
  const view = await startLiveView({ recordHome: tempRecordHome(), port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${view.port}/api/tasks/..%2f..%2fetc`);
    assert.equal(res.status, 400);
  } finally {
    await view.close();
  }
});

test("startLiveView: /tasks/<id> serves the task page for a real task id's shape, and falls through to 404 otherwise", async () => {
  const recordHome = tempRecordHome();
  const taskId = registerTask(recordHome, "give me my own page").id;

  const view = await startLiveView({ recordHome, port: 0 });
  try {
    const page = await fetch(`http://127.0.0.1:${view.port}/tasks/${taskId}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html/);

    // Not shaped like a real task id (TASK_ID_PATTERN) - never reaches
    // task.html, same as any other unknown route.
    const notATaskId = await fetch(`http://127.0.0.1:${view.port}/tasks/not-a-real-id`);
    assert.equal(notATaskId.status, 404);
  } finally {
    await view.close();
  }
});

test("startLiveView: no request, of any kind, ever changes a file on disk", async () => {
  const recordHome = tempRecordHome();
  const taskId = registerTask(recordHome, "do not touch me").id;
  appendEvent(recordHome, { taskId, name: "work-started", details: { project: "/p" } });
  appendTaskFile(recordHome, taskId, "transcript.log", `${JSON.stringify({ occurredAt: "t0", kind: "stdout", text: "hi" })}\n`);

  const view = await startLiveView({ recordHome, port: 0 });
  try {
    const base = `http://127.0.0.1:${view.port}`;
    const before = snapshotTree(recordHome);

    await Promise.all([
      fetch(`${base}/`),
      fetch(`${base}/app.js`),
      fetch(`${base}/style.css`),
      fetch(`${base}/task.js`),
      fetch(`${base}/tasks/${taskId}`),
      fetch(`${base}/api/state`),
      fetch(`${base}/api/version`),
      fetch(`${base}/api/tasks/${taskId}`),
      fetch(`${base}/api/tasks/${taskId}/transcript`),
      fetch(`${base}/api/tasks/${taskId}/transcript`),
      fetch(`${base}/no-such-route`),
      fetch(`${base}/api/state`, { method: "POST" }),
      fetch(`${base}/api/tasks/..%2f..%2fetc/transcript`),
    ]);

    assert.deepEqual(snapshotTree(recordHome), before);
  } finally {
    await view.close();
  }
});
