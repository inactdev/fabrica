import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectorAdapter, inspectorIsConfigured, reportForRecord, MAX_INSPECTION_REPORT_BYTES } from "./run.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-inspector-"));
}

function command(dir: string, exitCode: number, output: string): string {
  const path = join(dir, `inspector-${exitCode}.sh`);
  writeFileSync(path, `#!/bin/sh\nprintf '%s' ${JSON.stringify(output)}\nexit ${exitCode}\n`);
  chmodSync(path, 0o755);
  return path;
}

test("inspectorAdapter maps Inspector's three verdict exit codes without the real binary or GitHub", async () => {
  const workdir = tempDir();

  for (const [exitCode, verdict] of [
    [0, "green"],
    [1, "red"],
    [2, "refused"],
  ] as const) {
    const inspection = await inspectorAdapter(command(workdir, exitCode, `${verdict} report`)).inspect({
      branch: "fabrica/task",
      workdir,
    });
    assert.deepEqual(inspection, { verdict, report: `${verdict} report` });
  }
});

test("inspectorAdapter treats every other exit as refused rather than red", async () => {
  const workdir = tempDir();
  const inspection = await inspectorAdapter(command(workdir, 64, "bad invocation")).inspect({
    branch: "fabrica/task",
    workdir,
  });

  assert.deepEqual(inspection, { verdict: "refused", report: "bad invocation" });
});

test("inspectorIsConfigured only accepts a project-local Inspector config", () => {
  const workdir = tempDir();
  assert.equal(inspectorIsConfigured(workdir), false);
  writeFileSync(join(workdir, ".inspector.json"), "{}\n");
  assert.equal(inspectorIsConfigured(workdir), true);
});

test("reportForRecord keeps Inspector's final diagnosis within the record limit", () => {
  const report = `start\n${"x".repeat(MAX_INSPECTION_REPORT_BYTES)}\nreason at end`;
  const saved = reportForRecord(report);

  assert.match(saved, /^\[truncated, showing last/);
  assert.match(saved, /reason at end$/);
  assert.ok(Buffer.byteLength(saved, "utf8") < Buffer.byteLength(report, "utf8"));
});
