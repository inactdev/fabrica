import { test } from "node:test";
import assert from "node:assert/strict";
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

test("startLiveView: an unknown task id's transcript is a 404, not a crash", async () => {
  const view = await startLiveView({ recordHome: tempRecordHome(), port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${view.port}/api/tasks/20260101-ghost-zz/transcript`);
    assert.equal(res.status, 404);
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
      fetch(`${base}/api/state`),
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
