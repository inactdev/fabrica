import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { appendEvent, recordPath } from "./append.ts";
import { readEvents } from "./read.ts";
import { makeTestHome } from "./helpers/test-home.ts";

test("appendEvent: writes one JSON line per call, in call order", () => {
  const home = makeTestHome();

  appendEvent(home, { taskId: "t1", name: "task-received" });
  appendEvent(home, { taskId: "t1", name: "work-started" });

  const lines = readFileSync(recordPath(home), "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).name, "task-received");
  assert.equal(JSON.parse(lines[1]).name, "work-started");
});

test("appendEvent: stamps occurredAt and preserves taskId/name/details", () => {
  const home = makeTestHome();
  const before = new Date().toISOString();

  const record = appendEvent(home, { taskId: "t1", name: "check-run", details: { attempt: 1 } });

  assert.equal(record.taskId, "t1");
  assert.equal(record.name, "check-run");
  assert.deepEqual(record.details, { attempt: 1 });
  assert.ok(record.occurredAt >= before, "occurredAt should be stamped at write time");
});

test("appendEvent: a caller-smuggled occurredAt never overrides the record's own stamp", () => {
  const home = makeTestHome();
  const before = new Date().toISOString();

  const replayed = { occurredAt: "1999-01-01T00:00:00.000Z", taskId: "t1", name: "task-received" };
  const record = appendEvent(home, replayed);

  assert.ok(record.occurredAt >= before, "occurredAt must be stamped by the record, not taken from the caller");
  const line = readFileSync(recordPath(home), "utf8").trim();
  assert.ok(line.startsWith('{"occurredAt":'), "occurredAt must stay the first key in the serialized line");
  assert.equal(JSON.parse(line).occurredAt, record.occurredAt);
});

test("appendEvent: omits details entirely when not given, rather than writing null/undefined", () => {
  const home = makeTestHome();
  appendEvent(home, { taskId: "t1", name: "task-received" });

  const line = readFileSync(recordPath(home), "utf8").trim();
  assert.ok(!("details" in JSON.parse(line)));
});

test("appendEvent: never rewrites a prior line, even for the same taskId+name repeated", () => {
  const home = makeTestHome();

  const first = appendEvent(home, { taskId: "t1", name: "task-received" });
  const firstSnapshot = readFileSync(recordPath(home), "utf8");

  appendEvent(home, { taskId: "t1", name: "task-received" }); // same taskId+name again
  const secondSnapshot = readFileSync(recordPath(home), "utf8");

  assert.ok(
    secondSnapshot.startsWith(firstSnapshot),
    "the first snapshot's bytes must be an untouched prefix of the second"
  );
  assert.deepEqual(JSON.parse(secondSnapshot.trim().split("\n")[0]), first);
});

test("appendEvent: mutating the returned record does not reach the file on disk", () => {
  const home = makeTestHome();

  const record = appendEvent(home, { taskId: "t1", name: "task-received" });
  (record as { name: string }).name = "tampered";
  record.details = "tampered";

  const [onDisk] = readEvents(home);
  assert.equal(onDisk.name, "task-received");
  assert.equal(onDisk.details, undefined);
});

test("the record module exposes no update or delete path for events.jsonl", async () => {
  const record = await import("./index.ts");
  const forbidden = /^(update|delete|remove|rewrite|edit|truncate|clear|overwrite)/i;
  const offending = Object.keys(record).filter((name) => forbidden.test(name));
  assert.deepEqual(offending, [], `found a rewrite-shaped export: ${offending.join(", ")}`);
});

test("appendEvent: concurrent appends from separate OS processes never tear or interleave a line", async () => {
  const home = makeTestHome();
  const workerPath = fileURLToPath(new URL("./helpers/concurrent-append-worker.ts", import.meta.url));
  const tsxBin = join(process.cwd(), "node_modules", ".bin", "tsx");

  const WORKERS = 6;
  const EVENTS_PER_WORKER = 40;

  const runWorker = (label: string) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(tsxBin, [workerPath, home, "concurrent-task", String(EVENTS_PER_WORKER), label]);
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`worker ${label} exited ${code}: ${stderr}`));
      });
      child.on("error", reject);
    });

  await Promise.all(Array.from({ length: WORKERS }, (_, i) => runWorker(`w${i}`)));

  const raw = readFileSync(recordPath(home), "utf8");
  assert.ok(raw.endsWith("\n"), "file must end cleanly on a full line, not mid-write");

  const lines = raw.split("\n").filter((line) => line.length > 0);
  assert.equal(lines.length, WORKERS * EVENTS_PER_WORKER, "no line lost or merged across processes");

  // Every line parses on its own: a torn/interleaved write would produce a
  // line that is not valid JSON, or content that doesn't match any writer.
  const parsed = lines.map((line) => JSON.parse(line));
  const seen = new Set<string>();
  for (const event of parsed) {
    assert.equal(event.taskId, "concurrent-task");
    assert.equal(event.name, "concurrent-write");
    seen.add(`${event.details.label}-${event.details.i}`);
  }

  const expected = new Set<string>();
  for (let w = 0; w < WORKERS; w++) {
    for (let i = 0; i < EVENTS_PER_WORKER; i++) expected.add(`w${w}-${i}`);
  }
  assert.deepEqual(seen, expected, "every writer's every event must survive intact, none lost or corrupted");
});
