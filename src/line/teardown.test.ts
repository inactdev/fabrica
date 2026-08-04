import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { cutLine } from "./cut.ts";
import { tearDownLine } from "./teardown.ts";
import { LineError } from "./errors.ts";
import { fingerprint, makeFixtureHome, makeFixtureProject } from "./helpers/fixture.ts";

test("tearDownLine removes the worktree but keeps the branch for review", () => {
  const project = makeFixtureProject();
  const home = makeFixtureHome();
  const line = cutLine({ project, id: "task-td", home });

  tearDownLine(line);

  assert.equal(existsSync(line.workdir), false);
  const branches = execFileSync("git", ["branch", "--list", "fabrica/task-td"], {
    cwd: project,
  }).toString();
  assert.match(branches, /fabrica\/task-td/);
});

test("tearDownLine succeeds on a dirty worktree (staged, unstaged, untracked)", () => {
  const project = makeFixtureProject();
  const home = makeFixtureHome();
  const before = fingerprint(project);
  const line = cutLine({ project, id: "task-dirty", home });

  writeFileSync(join(line.workdir, "app.txt"), "modified by the worker\n");
  writeFileSync(join(line.workdir, "untracked.txt"), "never committed\n");
  execFileSync("git", ["add", "app.txt"], { cwd: line.workdir });

  assert.doesNotThrow(() => tearDownLine(line));
  assert.equal(existsSync(line.workdir), false);
  assert.equal(fingerprint(project), before, "dirty teardown must not touch the Client's checkout");
});

test("tearDownLine refuses a ProductionLine whose workdir is the project's own checkout", () => {
  const project = makeFixtureProject();
  const home = makeFixtureHome();
  const before = fingerprint(project);
  const real = cutLine({ project, id: "task-spoof", home });

  const spoofed = { ...real, workdir: project };

  assert.throws(
    () => tearDownLine(spoofed),
    (err: unknown) => err instanceof LineError && err.code === "unsafe-teardown"
  );
  assert.equal(fingerprint(project), before);
  assert.equal(existsSync(join(project, "app.txt")), true);
});

test("tearDownLine refuses a path that is not a registered worktree at all", () => {
  const project = makeFixtureProject();
  const home = makeFixtureHome();
  const real = cutLine({ project, id: "task-random", home });

  const randomDir = mkdtempSync(join(tmpdir(), "fabrica-line-random-"));
  writeFileSync(join(randomDir, "innocent.txt"), "leave me alone\n");
  const spoofed = { ...real, workdir: randomDir };

  assert.throws(
    () => tearDownLine(spoofed),
    (err: unknown) => err instanceof LineError && err.code === "unsafe-teardown"
  );
  assert.equal(existsSync(randomDir), true);
  assert.equal(readFileSync(join(randomDir, "innocent.txt"), "utf8"), "leave me alone\n");
});

test("tearDownLine refuses a workdir that doesn't match the expected task path", () => {
  const project = makeFixtureProject();
  const home = makeFixtureHome();
  const real = cutLine({ project, id: "task-tamper", home });

  const tampered = { ...real, workdir: join(home, "tasks", "some-other-task", "worktree") };

  assert.throws(
    () => tearDownLine(tampered),
    (err: unknown) => err instanceof LineError && err.code === "unsafe-teardown"
  );
  assert.equal(existsSync(real.workdir), true, "the real, correctly-addressed line must be untouched");
});
