// CONTRACT rule 11 - It asks itself first.
// Every brief Fabrica hands a worker begins with the standing question,
// put there by Fabrica's own code - never left to a file the model might
// or might not read. Checked across every kind of brief: the first
// attempt, the retry after a red, a fix verdict, and an answered round.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "../src/index.ts";
import { fakeBrain } from "./helpers/fake-brain.ts";
import { fakeInspector } from "./helpers/fake-inspector.ts";
import { makeFixtureRepo } from "./helpers/fixture.ts";

const STANDING_QUESTION =
  "Before you change anything: if your planned solution works, is it the best one, all things considered - " +
  "safest first, then most accurate, then fastest? Name one alternative you rejected and why. Write this down " +
  "before you start.";

function assertBeginsWithStandingQuestion(brief: string, which: string): void {
  assert.ok(brief.startsWith(STANDING_QUESTION), `the ${which} brief does not begin with the standing question - rule 11 broken`);
  assert.equal(brief.split(STANDING_QUESTION).length - 1, 1, `the ${which} brief carries the standing question more than once`);
}

test("rule 11: every brief begins with the standing question - first attempt, retry after red, and fix round", async () => {
  const brain = fakeBrain();
  const foreman = createForeman({
    recordHome: mkdtempSync(join(tmpdir(), "fabrica-home-")),
    inspector: fakeInspector(["red", "green", "green"]),
  });

  const task = await foreman.do("small change", { project: makeFixtureRepo("exit 0"), brain });
  await foreman.verdict(task.id, "fix", "one more thing");

  assert.equal(brain.briefs.length, 3);
  assertBeginsWithStandingQuestion(brain.briefs[0], "first-attempt");
  assertBeginsWithStandingQuestion(brain.briefs[1], "retry-after-red");
  assertBeginsWithStandingQuestion(brain.briefs[2], "fix-round");
});

test("rule 11: an answered round's brief begins with the standing question", async () => {
  const brain = fakeBrain({ askQuestions: ["Which database?"] });
  const foreman = createForeman({
    recordHome: mkdtempSync(join(tmpdir(), "fabrica-home-")),
    inspector: fakeInspector("green"),
  });

  const asked = await foreman.do("build me an app", { project: makeFixtureRepo("exit 0"), brain });
  assert.equal(asked.state, "asking");
  await foreman.answer(asked.id, "Use Postgres.");

  assert.equal(brain.briefs.length, 1);
  assertBeginsWithStandingQuestion(brain.briefs[0], "answered-round");
});
