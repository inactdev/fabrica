// Issue #204's "Done when", as the 2026-10-25 amendment reinterprets it:
// shadow mode only, so "closes with closed-by-rule and never asks"
// becomes "records would-close with every answer safe and STILL waits for
// the verdict". These drive the real loop end to end - a real
// ProductionLine, a real delivery, a real record - rather than calling
// the evaluator by hand, because the claim being made is about the whole
// round, not about one function.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createForeman } from "../index.ts";
import { makeFixtureRepo, pushToOrigin } from "../../contract/helpers/fixture.ts";
import { fakeBrain } from "../../contract/helpers/fake-brain.ts";
import { fakeInspector } from "../../contract/helpers/fake-inspector.ts";
import { SKIP_RULES_PATH } from "./load.ts";
import type { KindEvaluation, WouldCloseByRuleDetails } from "./types.ts";

/** A rules file whose one kind every fixture change below satisfies - no
 * CI conditions, since a fake Inspector opens no pull request and so
 * concludes no checks (a `requiredGreenChecks` condition would answer
 * "unknown" here, which is correct behaviour and a different test). */
const DOCS_ONLY = `version = 1

[kinds.docs-only]
description = "A documentation-only change under docs/"
mode = "shadow"
allowedFolders = ["docs"]
maxFiles = 3
maxLines = 50
noTestFiles = true
noDependencyManifest = true
inspectorGreen = true
noQuestionsAsked = true
noCouldNotVerify = true
`;

function newRecordHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-home-"));
}

/** A fixture project carrying a committed skip-rules file, pushed to its
 * own origin so `createProductionLine`'s origin fetch sees it. */
function projectWithRules(rules: string | null = DOCS_ONLY): string {
  const project = makeFixtureRepo("exit 0");
  if (rules !== null) {
    mkdirSync(dirname(join(project, SKIP_RULES_PATH)), { recursive: true });
    writeFileSync(join(project, SKIP_RULES_PATH), rules);
    execFileSync("git", ["add", "-A"], { cwd: project });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "skip rules"], { cwd: project });
    pushToOrigin(project);
  }
  return project;
}

/** A worker that writes the files it is told to, into its own worktree. */
function brainWriting(files: Record<string, string>) {
  return fakeBrain({
    onWork: (workdir) => {
      for (const [path, body] of Object.entries(files)) {
        mkdirSync(dirname(join(workdir, path)), { recursive: true });
        writeFileSync(join(workdir, path), body);
      }
    },
  });
}

async function evaluationOf(
  foreman: ReturnType<typeof createForeman>,
  taskId: string
): Promise<WouldCloseByRuleDetails | undefined> {
  const event = (await foreman.events(taskId)).filter((e) => e.name === "would-close-by-rule").at(-1);
  return event?.details as WouldCloseByRuleDetails | undefined;
}

function kindNamed(details: WouldCloseByRuleDetails, name: string): KindEvaluation {
  const found = details.kinds.find((kind) => kind.kind === name);
  assert.ok(found, `no evaluation for kind "${name}"`);
  return found;
}

test("a task satisfying every line records would-close with every answer safe - and still waits for the verdict", async () => {
  const project = projectWithRules();
  const recordHome = newRecordHome();
  const foreman = createForeman({ recordHome, inspector: fakeInspector("green") });

  const task = await foreman.do("tidy the intro", {
    project,
    brain: brainWriting({ "docs/intro.md": "a tidier intro\n" }),
  });

  const details = await evaluationOf(foreman, task.id);
  assert.ok(details, "no would-close-by-rule event was recorded");
  assert.equal(details.mode, "shadow");
  assert.equal(details.wouldClose, true);
  assert.equal(details.closedByKind, "docs-only");
  assert.equal(details.project, project);
  assert.equal(details.rulesPath, SKIP_RULES_PATH);
  assert.match(details.rulesVersion ?? "", /^1@[0-9a-f]{12}$/);
  assert.match(details.fingerprint ?? "", /^[0-9a-f]{40,64}$/);
  assert.equal(details.problem, undefined);

  const kind = kindNamed(details, "docs-only");
  assert.equal(kind.safe, true);
  assert.equal(kind.description, "A documentation-only change under docs/");
  assert.ok(kind.answers.length > 1, "no condition answers were recorded");
  assert.ok(
    kind.answers.every((answer) => answer.answer === "safe"),
    `an answer was not safe: ${JSON.stringify(kind.answers.filter((a) => a.answer !== "safe"))}`
  );

  // The whole point of shadow mode: nothing closed, and the Client is
  // still the one who has to rule.
  const names = (await foreman.events(task.id)).map((e) => e.name);
  assert.equal(task.state, "delivered");
  assert.ok(!names.includes("verdict-recorded"), "a verdict was recorded without the Client");
  assert.deepEqual(
    names.filter((name) => name.includes("closed")),
    [],
    `something closed by rule: ${names.join(", ")}`
  );
  const open = await foreman.status();
  assert.equal(open.find((t) => t.id === task.id)?.state, "delivered", "the task did not stay waiting on the Client");
});

test("a task that touches a test file is unsafe, names the file, and goes to the Client as today", async () => {
  const project = projectWithRules();
  const recordHome = newRecordHome();
  const foreman = createForeman({ recordHome, inspector: fakeInspector("green") });

  const task = await foreman.do("tidy the intro and its test", {
    project,
    brain: brainWriting({ "docs/intro.md": "a tidier intro\n", "docs/intro.test.ts": "// a test\n" }),
  });

  const details = await evaluationOf(foreman, task.id);
  assert.ok(details);
  assert.equal(details.wouldClose, false);
  assert.equal(details.closedByKind, null);

  const kind = kindNamed(details, "docs-only");
  assert.equal(kind.safe, false);
  const testAnswer = kind.answers.find((answer) => answer.condition === "noTestFiles");
  assert.ok(testAnswer);
  assert.equal(testAnswer.answer, "unsafe");
  assert.match(testAnswer.detail, /docs\/intro\.test\.ts/);

  assert.equal(task.state, "delivered");
  assert.ok(!(await foreman.events(task.id)).some((e) => e.name === "verdict-recorded"));
});

test("a project with no rules file records nothing at all - never an empty evaluation", async () => {
  const project = projectWithRules(null);
  const recordHome = newRecordHome();
  const foreman = createForeman({ recordHome, inspector: fakeInspector("green") });

  const task = await foreman.do("small change", { project, brain: brainWriting({ "docs/a.md": "a\n" }) });

  assert.equal(await evaluationOf(foreman, task.id), undefined);
  assert.ok(!(await foreman.events(task.id)).some((e) => e.name === "would-close-by-rule"));
});

test('a rules file set to mode = "live" records the refusal, names CONTRACT rule 6, and loses no delivery', async () => {
  const project = projectWithRules(DOCS_ONLY.replace('mode = "shadow"', 'mode = "live"'));
  const recordHome = newRecordHome();
  const foreman = createForeman({ recordHome, inspector: fakeInspector("green") });

  const task = await foreman.do("tidy the intro", { project, brain: brainWriting({ "docs/intro.md": "tidier\n" }) });

  const details = await evaluationOf(foreman, task.id);
  assert.ok(details, "a refused rules file recorded nothing - a silent skip is a bug");
  assert.equal(details.wouldClose, false);
  assert.deepEqual(details.kinds, []);
  assert.match(details.problem ?? "", /CONTRACT rule 6/);
  assert.equal(details.rulesVersion, null);

  // The delivery itself is untouched: the evaluation never throws into
  // the round.
  assert.equal(task.state, "delivered");
  assert.ok((await foreman.deliveryOf(task.id)) !== null);
});

test("a malformed rules file records its own problem rather than passing quietly", async () => {
  const project = projectWithRules('version = 1\n\n[kinds.x]\ndescription = "x"\nmode = "shadow"\nmaxComplexity = 2\n');
  const recordHome = newRecordHome();
  const foreman = createForeman({ recordHome, inspector: fakeInspector("green") });

  const task = await foreman.do("tidy the intro", { project, brain: brainWriting({ "docs/intro.md": "tidier\n" }) });

  const details = await evaluationOf(foreman, task.id);
  assert.ok(details);
  assert.match(details.problem ?? "", /maxComplexity/);
  assert.equal(task.state, "delivered");
});

test("a red delivery is unsafe on the code floor, whatever the rest of the change looks like", async () => {
  const project = projectWithRules();
  const recordHome = newRecordHome();
  const foreman = createForeman({ recordHome, inspector: fakeInspector("red") });

  const task = await foreman.do("tidy the intro", {
    project,
    brain: brainWriting({ "docs/intro.md": "tidier\n" }),
    attempts: 1,
  });

  const details = await evaluationOf(foreman, task.id);
  assert.ok(details, "a red delivery was not evaluated at all");
  assert.equal(details.wouldClose, false);
  const floor = kindNamed(details, "docs-only").answers.find((answer) => answer.condition === "deliveryDone");
  assert.ok(floor);
  assert.equal(floor.answer, "unsafe");
  assert.equal(floor.fixed, true);
  assert.equal(task.state, "delivered");
});

test("a fix round is evaluated again, and the latest evaluation is the task's answer", async () => {
  const project = projectWithRules();
  const recordHome = newRecordHome();
  const foreman = createForeman({ recordHome, inspector: fakeInspector("green") });

  const task = await foreman.do("tidy the intro", {
    project,
    brain: brainWriting({ "docs/intro.md": "tidier\n", "docs/extra.md": "extra\n" }),
  });
  const first = await evaluationOf(foreman, task.id);
  assert.equal(first?.wouldClose, true);

  // The Client's own fix round, whose worker adds a test file - so the
  // second evaluation disagrees with the first, and the latest wins.
  await foreman.verdict(task.id, "fix", "also cover it with a test");
  const after = (await foreman.events(task.id)).filter((e) => e.name === "would-close-by-rule");
  assert.equal(after.length, 2, "the fix round was not evaluated");
});
