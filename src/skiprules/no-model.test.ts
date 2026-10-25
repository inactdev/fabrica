// Issue #204's third "Done when": "a test proves no model is called
// between 'checks finished' and 'merge or ask'". That is the load-bearing
// property of the whole design - a model's finding may send a task to the
// Client and must never let one skip him - so it is pinned three ways
// rather than one.
//
//   1. Structurally: nothing in this module imports the brain socket, or
//      anything that could reach a model, and nothing here spawns a child
//      process for anything but git. (The same shape
//      src/foreman/no-host-check.test.ts uses for its own invariant.)
//   2. By signature: the decision's one entry point is handed a record
//      home, a project, a commit and a branch. There is nowhere for a
//      brain to go.
//   3. Behaviourally: a round's brain is called exactly as many times as
//      the round had attempts, and evaluating the delivery afterwards
//      calls it zero more times.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createForeman } from "../index.ts";
import { makeFixtureRepo, pushToOrigin } from "../../contract/helpers/fixture.ts";
import { fakeBrain } from "../../contract/helpers/fake-brain.ts";
import { fakeInspector } from "../../contract/helpers/fake-inspector.ts";
import { evaluateInShadow } from "./shadow.ts";
import { SKIP_RULES_PATH } from "./load.ts";

const moduleDir = dirname(fileURLToPath(import.meta.url));

function productionFiles(): string[] {
  return readdirSync(moduleDir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
}

test("no file in this module imports anything that could reach a model", () => {
  for (const name of productionFiles()) {
    const source = readFileSync(join(moduleDir, name), "utf8");
    for (const [, specifier] of source.matchAll(/\bfrom\s+"([^"]+)"/g)) {
      assert.doesNotMatch(
        specifier,
        /brain|adapters/,
        `${name} imports "${specifier}" - the skip-rule decision must not be able to reach a model at all`
      );
    }
    assert.doesNotMatch(
      source,
      /\bimport\s*\(/,
      `${name} uses a dynamic import, which this scan cannot follow - keep the decision's imports static`
    );
  }
});

test("no file in this module spawns a child process for anything but git", () => {
  for (const name of productionFiles()) {
    const source = readFileSync(join(moduleDir, name), "utf8");
    if (!/from "node:child_process"|require\("child_process"\)|from "child_process"/.test(source)) continue;
    // The `(?<![.\w])` matters: without it, an ordinary method call that
    // happens to share one of these names - `new RegExp(...).exec(line)`
    // in git.ts - is read as a child-process spawn and this test fails on
    // a regex match rather than on a real finding.
    // (src/foreman/no-host-check.test.ts's own copy of this scan has the
    // same gap; nothing under src/foreman trips it today.)
    const calls = [
      ...source.matchAll(/(?<![.\w])(execSync|execFileSync|exec|execFile|spawn|spawnSync|fork)\s*\(\s*([^,)]*)/g),
    ];
    assert.ok(calls.length > 0, `${name} imports child_process but no call was found to check - read it by hand`);
    for (const [, fn, firstArg] of calls) {
      assert.equal(
        firstArg.trim(),
        '"git"',
        `${name} calls ${fn}(${firstArg.trim()}, ...) - only git may be spawned from the skip-rule decision`
      );
    }
  }
});

test("the decision's own entry point has nowhere to put a brain", () => {
  const source = readFileSync(join(moduleDir, "shadow.ts"), "utf8");
  const request = /export interface ShadowEvaluationRequest \{([\s\S]*?)\n\}/.exec(source);
  assert.ok(request, "ShadowEvaluationRequest is no longer declared in shadow.ts - this scan is broken, not passing");
  assert.doesNotMatch(request[1], /brain|model|vendor/i, "the shadow evaluation's request grew a way to reach a model");
});

test("a round's brain is called once per attempt, and the evaluation afterwards calls it zero more times", async () => {
  const project = makeFixtureRepo("exit 0");
  mkdirSync(dirname(join(project, SKIP_RULES_PATH)), { recursive: true });
  writeFileSync(
    join(project, SKIP_RULES_PATH),
    `version = 1

[kinds.docs-only]
description = "A documentation-only change"
mode = "shadow"
allowedFolders = ["docs"]
maxFiles = 3
inspectorGreen = true
`
  );
  execFileSync("git", ["add", "-A"], { cwd: project });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "skip rules"], { cwd: project });
  pushToOrigin(project);

  const recordHome = mkdtempSync(join(tmpdir(), "fabrica-home-"));
  const brain = fakeBrain({
    onWork: (workdir) => {
      mkdirSync(join(workdir, "docs"), { recursive: true });
      writeFileSync(join(workdir, "docs", "intro.md"), "tidier\n");
    },
  });
  const foreman = createForeman({ recordHome, inspector: fakeInspector("green") });

  const task = await foreman.do("tidy the intro", { project, brain });

  // One work() call per attempt and nothing more: the shadow evaluation
  // added no model call anywhere in the round, not just at its end.
  const attempts = (await foreman.receiptsOf(task.id)).length;
  assert.equal(brain.calls, attempts, "the round made more model calls than it had attempts");
  assert.ok((await foreman.events(task.id)).some((e) => e.name === "would-close-by-rule"), "the round was never evaluated");

  // ...and evaluating the same delivery again, by hand, calls nothing.
  const before = brain.calls;
  const details = evaluateInShadow({
    recordHome,
    taskId: task.id,
    project,
    baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: project, encoding: "utf8" }).trim(),
    branch: `fabrica/${task.id}`,
  });
  assert.ok(details, "the hand-run evaluation recorded nothing");
  assert.equal(brain.calls, before, "evaluating a delivery called the brain");
});
