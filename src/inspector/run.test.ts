import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractPrUrl, inspectorAdapter, inspectorIsConfigured, reportForRecord, MAX_INSPECTION_REPORT_BYTES } from "./run.ts";

/** A fake token, so no test here ever asks the machine's real `gh`. */
function testAdapter(command: string) {
  return inspectorAdapter(command, { env: { ...process.env, GITHUB_TOKEN: "fake-test-token" } });
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-inspector-"));
}

function command(dir: string, exitCode: number, output: string): string {
  const path = join(dir, `inspector-${exitCode}.sh`);
  writeFileSync(path, `#!/bin/sh\nprintf '%s' ${JSON.stringify(output)}\nexit ${exitCode}\n`);
  chmodSync(path, 0o755);
  return path;
}

function commandStreams(dir: string, exitCode: number, stdout: string, stderr: string): string {
  const path = join(dir, `inspector-streams-${exitCode}.sh`);
  writeFileSync(
    path,
    `#!/bin/sh\nprintf '%s' ${JSON.stringify(stdout)}\nprintf '%s' ${JSON.stringify(stderr)} >&2\nexit ${exitCode}\n`
  );
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
    const inspection = await testAdapter(command(workdir, exitCode, `${verdict} report`)).inspect({
      branch: "fabrica/task",
      workdir,
    });
    assert.deepEqual(inspection, { verdict, report: `${verdict} report` });
  }
});

test("inspectorAdapter treats every other exit as refused rather than red", async () => {
  const workdir = tempDir();
  const inspection = await testAdapter(command(workdir, 64, "bad invocation")).inspect({
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

test("inspectorAdapter bounds streamed output and reports its true byte count", async () => {
  const workdir = tempDir();
  const stdout = "x".repeat(MAX_INSPECTION_REPORT_BYTES * 4);
  const stderr = "reason at end";
  const total = Buffer.byteLength(stdout) + 1 + Buffer.byteLength(stderr);
  const inspection = await testAdapter(commandStreams(workdir, 2, stdout, stderr)).inspect({
    branch: "fabrica/task",
    workdir,
  });

  assert.equal(inspection.verdict, "refused");
  assert.match(inspection.report, new RegExp(`^\\[truncated, showing last \\d+ of ${total} bytes\\]\\n`));
  assert.match(inspection.report, /reason at end$/);
  assert.ok(Buffer.byteLength(inspection.report) <= MAX_INSPECTION_REPORT_BYTES);
});

test("reportForRecord keeps Inspector's final diagnosis within the record limit", () => {
  const report = `start\n${"x".repeat(MAX_INSPECTION_REPORT_BYTES)}\nreason at end`;
  const saved = reportForRecord(report);

  assert.match(saved, /^\[truncated, showing last/);
  assert.match(saved, /reason at end$/);
  assert.ok(Buffer.byteLength(saved, "utf8") < Buffer.byteLength(report, "utf8"));
});

test("inspectorAdapter names the branch Inspector may publish: -branch fabrica/<taskId>", async () => {
  const workdir = tempDir();
  const path = join(workdir, "inspector-args.sh");
  writeFileSync(path, '#!/bin/sh\nprintf \'%s \' "$@"\nexit 0\n');
  chmodSync(path, 0o755);

  const inspection = await testAdapter(path).inspect({ branch: "fabrica/task-1", workdir });

  assert.equal(inspection.report, `-repo ${workdir} -branch fabrica/task-1`);
});

// Negative first: a green run that never printed the line gets no prUrl -
// the only thing a "pr-opened" event is ever allowed to key on.
test("inspectorAdapter reports no prUrl when Inspector's stdout never prints the pull request line", async () => {
  const workdir = tempDir();
  const inspection = await testAdapter(command(workdir, 0, "all good, nothing more to say")).inspect({
    branch: "fabrica/task",
    workdir,
  });

  assert.equal(inspection.verdict, "green");
  assert.equal(inspection.prUrl, undefined);
});

test("inspectorAdapter reads the pull request url from Inspector's own stdout line", async () => {
  const workdir = tempDir();
  const inspection = await testAdapter(
    command(workdir, 0, "checks passed\npull request: https://example.test/pulls/9\n")
  ).inspect({ branch: "fabrica/task", workdir });

  assert.equal(inspection.verdict, "green");
  assert.equal(inspection.prUrl, "https://example.test/pulls/9");
});

test("extractPrUrl takes the last pull request line when more than one appears", () => {
  assert.equal(extractPrUrl("pull request: https://x/1\nnoise\npull request: https://x/2\n"), "https://x/2");
  assert.equal(extractPrUrl("nothing relevant here"), undefined);
});

// $1=-repo $2=workdir $3=-branch $4=branch $5=-pr-title $6=<title>
// $7=-pr-body-file $8=<path to the body file>
test("inspectorAdapter passes -pr-title and -pr-body-file, and the body file holds the given text", async () => {
  const workdir = tempDir();
  const path = join(workdir, "inspector-pr-args.sh");
  writeFileSync(path, '#!/bin/sh\nprintf \'%s|%s|%s|%s|%s|%s|%s|\' "$1" "$2" "$3" "$4" "$5" "$6" "$7"\ncat "$8"\nexit 0\n');
  chmodSync(path, 0o755);

  const inspection = await testAdapter(path).inspect({
    branch: "fabrica/task-1",
    workdir,
    prTitle: "Fix the login bug",
    prBody: "Completed: Fix the login bug\n\nDeviations:\nNone.\n",
  });

  assert.equal(
    inspection.report,
    `-repo|${workdir}|-branch|fabrica/task-1|-pr-title|Fix the login bug|-pr-body-file|` +
      "Completed: Fix the login bug\n\nDeviations:\nNone."
  );
});

test("inspectorAdapter cleans up the pr-body temp file after Inspector exits", async () => {
  const workdir = tempDir();
  const path = join(workdir, "inspector-echo-path.sh");
  writeFileSync(path, '#!/bin/sh\necho "$6" > "' + join(workdir, "captured-path.txt") + '"\nexit 0\n');
  chmodSync(path, 0o755);

  await testAdapter(path).inspect({ branch: "fabrica/task", workdir, prBody: "body text" });

  const { readFileSync, existsSync } = await import("node:fs");
  const capturedPath = readFileSync(join(workdir, "captured-path.txt"), "utf8").trim();
  assert.ok(capturedPath.length > 0);
  assert.equal(existsSync(capturedPath), false, "the temp pr-body file must not survive the call");
});

test("inspectorAdapter reports whether its command is installed", () => {
  const workdir = tempDir();
  assert.equal(inspectorAdapter(command(workdir, 0, "ok")).installed?.(), true);
  assert.equal(inspectorAdapter(join(workdir, "missing-inspector")).installed?.(), false);
  assert.equal(inspectorAdapter("sh").installed?.(), true, "a bare name is looked up on PATH");
});
