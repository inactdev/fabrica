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

  appendEvent(home, { task: "t1", event: "task-received" });
  appendEvent(home, { task: "t1", event: "work-started" });

  const lines = readFileSync(recordPath(home), "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).event, "task-received");
  assert.equal(JSON.parse(lines[1]).event, "work-started");
});

test("appendEvent: stamps ts and preserves task/event/detail", () => {
  const home = makeTestHome();
  const before = new Date().toISOString();

  const record = appendEvent(home, { task: "t1", event: "check-run", detail: { attempt: 1 } });

  assert.equal(record.task, "t1");
  assert.equal(record.event, "check-run");
  assert.deepEqual(record.detail, { attempt: 1 });
  assert.ok(record.ts >= before, "ts should be stamped at write time");
});

test("appendEvent: omits detail entirely when not given, rather than writing null/undefined", () => {
  const home = makeTestHome();
  appendEvent(home, { task: "t1", event: "task-received" });

  const line = readFileSync(recordPath(home), "utf8").trim();
  assert.ok(!("detail" in JSON.parse(line)));
});

test("appendEvent: never rewrites a prior line, even for the same task+event repeated", () => {
  const home = makeTestHome();

  const first = appendEvent(home, { task: "t1", event: "task-received" });
  const firstSnapshot = readFileSync(recordPath(home), "utf8");

  appendEvent(home, { task: "t1", event: "task-received" }); // same task+event again
  const secondSnapshot = readFileSync(recordPath(home), "utf8");

  assert.ok(
    secondSnapshot.startsWith(firstSnapshot),
    "the first snapshot's bytes must be an untouched prefix of the second"
  );
  assert.deepEqual(JSON.parse(secondSnapshot.trim().split("\n")[0]), first);
});

test("appendEvent: mutating the returned record does not reach the file on disk", () => {
  const home = makeTestHome();

  const record = appendEvent(home, { task: "t1", event: "task-received" });
  (record as { event: string }).event = "tampered";
  record.detail = "tampered";

  const [onDisk] = readEvents(home);
  assert.equal(onDisk.event, "task-received");
  assert.equal(onDisk.detail, undefined);
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
    assert.equal(event.task, "concurrent-task");
    assert.equal(event.event, "concurrent-write");
    seen.add(`${event.detail.label}-${event.detail.i}`);
  }

  const expected = new Set<string>();
  for (let w = 0; w < WORKERS; w++) {
    for (let i = 0; i < EVENTS_PER_WORKER; i++) expected.add(`w${w}-${i}`);
  }
  assert.deepEqual(seen, expected, "every writer's every event must survive intact, none lost or corrupted");
});
