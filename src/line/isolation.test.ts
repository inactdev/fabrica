// Adversarial coverage for CONTRACT rule 1 ("It never touches your
// stuff"), the worst-failure-mode rule in the whole contract. The
// contract's own rule1.isolation.test.ts proves this end to end through
// createForeman (src/foreman/, issue #7) — so these tests prove the same
// invariant directly against createProductionLine/destroyProductionLine,
// plus scenarios the contract test doesn't reach: a failed run, destroying
// a dirty line, and two lines created at once.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createProductionLine } from "./cut.ts";
import { destroyProductionLine } from "./teardown.ts";
import { fingerprint, makeFixtureHome, makeFixtureProject } from "./helpers/fixture.ts";

const here = dirname(fileURLToPath(import.meta.url));

test("checkout is untouched after a successful run: create, work, commit, destroy", () => {
  const project = makeFixtureProject();
  const recordHome = makeFixtureHome();
  const before = fingerprint(project);

  const line = createProductionLine({ project, taskId: "task-success", recordHome });
  try {
    const original = readFileSync(join(line.workdir, "app.txt"), "utf8");
    writeFileSync(join(line.workdir, "app.txt"), original + "one more line\n");
    execFileSync("git", ["add", "-A"], { cwd: line.workdir });
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "work"],
      { cwd: line.workdir }
    );
  } finally {
    destroyProductionLine(line);
  }

  assert.equal(fingerprint(project), before);
  assert.equal(existsSync(line.workdir), false);
});

test("checkout is untouched after a failed run", () => {
  const project = makeFixtureProject();
  const recordHome = makeFixtureHome();
  const before = fingerprint(project);

  const line = createProductionLine({ project, taskId: "task-failure", recordHome });
  assert.throws(() => {
    try {
      writeFileSync(join(line.workdir, "app.txt"), "a change made right before blowing up\n");
      throw new Error("simulated worker failure");
    } finally {
      destroyProductionLine(line);
    }
  }, /simulated worker failure/);

  assert.equal(fingerprint(project), before);
  assert.equal(existsSync(line.workdir), false);
});

test("checkout is untouched after teardown of a dirty worktree", () => {
  const project = makeFixtureProject();
  const recordHome = makeFixtureHome();
  const before = fingerprint(project);

  const line = createProductionLine({ project, taskId: "task-dirty-e2e", recordHome });
  writeFileSync(join(line.workdir, "app.txt"), "uncommitted worker scratch\n");
  writeFileSync(join(line.workdir, "scratch.txt"), "never staged, never committed\n");
  execFileSync("git", ["add", "scratch.txt"], { cwd: line.workdir });

  destroyProductionLine(line);

  assert.equal(fingerprint(project), before);
  assert.equal(existsSync(line.workdir), false);
});

test("two ProductionLines created from the same project at once do not collide", async () => {
  const project = makeFixtureProject();
  const recordHome = makeFixtureHome();
  const before = fingerprint(project);

  const [a, b] = await Promise.all([
    runCreateInSubprocess(project, "task-concurrent-a", recordHome),
    runCreateInSubprocess(project, "task-concurrent-b", recordHome),
  ]);

  assert.equal(a.code, 0, `subprocess A failed: ${a.stderr}`);
  assert.equal(b.code, 0, `subprocess B failed: ${b.stderr}`);

  const lineA = JSON.parse(a.stdout);
  const lineB = JSON.parse(b.stdout);

  assert.notEqual(lineA.workdir, lineB.workdir);
  assert.notEqual(lineA.branch, lineB.branch);
  assert.ok(existsSync(lineA.workdir));
  assert.ok(existsSync(lineB.workdir));
  assert.equal(fingerprint(project), before);

  destroyProductionLine(lineA);
  destroyProductionLine(lineB);
  assert.equal(existsSync(lineA.workdir), false);
  assert.equal(existsSync(lineB.workdir), false);
  assert.equal(fingerprint(project), before);
});

function resolveTsxBin(): string {
  let dir = here;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "node_modules", ".bin", "tsx");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("could not find node_modules/.bin/tsx above " + here);
}

function runCreateInSubprocess(
  project: string,
  taskId: string,
  recordHome: string
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const helper = join(here, "helpers", "cut-in-subprocess.ts");
    const child = spawn(resolveTsxBin(), [helper, project, taskId, recordHome]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}
