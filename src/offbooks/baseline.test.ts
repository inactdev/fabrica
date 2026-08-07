import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readBaseline, writeBaseline } from "./baseline.ts";
import type { ProjectGitState } from "./types.ts";

function tempRecordHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-offbooks-baseline-"));
}

test("readBaseline: a project never seen before reads as null", () => {
  const recordHome = tempRecordHome();
  assert.equal(readBaseline(recordHome, "spending-app"), null);
});

test("writeBaseline then readBaseline: round-trips exactly", () => {
  const recordHome = tempRecordHome();
  const state: ProjectGitState = { branch: "main", headCommit: "a".repeat(40), dirty: [" M app.txt"] };
  writeBaseline(recordHome, "spending-app", state);
  assert.deepEqual(readBaseline(recordHome, "spending-app"), state);
});

test("writeBaseline: is human-readable JSON, one file per project (SPEC.md's 'read with bare hands')", () => {
  const recordHome = tempRecordHome();
  writeBaseline(recordHome, "spending-app", { branch: "main", headCommit: "a".repeat(40), dirty: [] });
  const path = join(recordHome, "offbooks", "spending-app.json");
  const text = readFileSync(path, "utf8");
  assert.doesNotThrow(() => JSON.parse(text));
});

test("readBaseline: a corrupted baseline file reads as null rather than throwing", () => {
  const recordHome = tempRecordHome();
  mkdirSync(join(recordHome, "offbooks"), { recursive: true });
  writeFileSync(join(recordHome, "offbooks", "spending-app.json"), "{ not valid json");
  assert.equal(readBaseline(recordHome, "spending-app"), null);
});

test("writeBaseline: a reader during concurrent writes from separate OS processes never sees a torn baseline", async () => {
  const recordHome = tempRecordHome();
  writeBaseline(recordHome, "spending-app", {
    branch: "main",
    headCommit: "a".repeat(40),
    dirty: Array.from({ length: 2000 }, (_, n) => ` M seed-file-${n}.txt`),
  });

  const workerPath = fileURLToPath(new URL("./helpers/concurrent-baseline-worker.ts", import.meta.url));
  const tsxBin = join(process.cwd(), "node_modules", ".bin", "tsx");

  const runWorker = (label: string) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(tsxBin, [workerPath, recordHome, "spending-app", "120", label]);
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker ${label} exited ${code}: ${stderr}`))));
      child.on("error", reject);
    });

  let writing = true;
  const workers = Promise.all(["w0", "w1", "w2", "w3"].map(runWorker)).then(() => (writing = false));

  // A torn read shows up as readBaseline returning null (invalid JSON), which
  // detect.ts would treat as "never seen" and silently swallow a real change.
  let torn = 0;
  let reads = 0;
  while (writing) {
    for (let i = 0; i < 20; i++) {
      if (readBaseline(recordHome, "spending-app") === null) torn++;
      reads++;
    }
    await new Promise((done) => setImmediate(done));
  }
  await workers;

  assert.ok(reads > 100, `expected reads to overlap the writers, got ${reads}`);
  assert.equal(torn, 0, "a baseline read mid-write must never come back unreadable");
  assert.deepEqual(
    readdirSync(join(recordHome, "offbooks")).filter((name) => name.endsWith(".tmp")),
    [],
    "no temp file left behind",
  );
});

test("writeBaseline: a project name with unsafe path characters never escapes the offbooks directory", () => {
  const recordHome = tempRecordHome();
  const state: ProjectGitState = { branch: "main", headCommit: "b".repeat(40), dirty: [] };
  writeBaseline(recordHome, "../../escape", state);
  assert.deepEqual(readBaseline(recordHome, "../../escape"), state);
  // Nothing was written outside recordHome/offbooks/ itself.
  const outside = join(recordHome, "..", "escape.json");
  assert.equal(existsSync(outside), false);
});
