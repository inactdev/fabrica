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
  "before you start. You cannot and need not commit - leave your changes in the working tree; Fabrica commits " +
  "them. When your change calls an outside tool or service, read its current documentation before writing the " +
  "call; never guess a command or API shape. If you cannot reach the documentation from here, stop and ask " +
  "instead of guessing.";

const COMMIT_NOTICE = "You cannot and need not commit - leave your changes in the working tree; Fabrica commits them.";

const DOCS_BEFORE_GUESSING_NOTICE =
  "When your change calls an outside tool or service, read its current documentation before writing the call; " +
  "never guess a command or API shape. If you cannot reach the documentation from here, stop and ask instead of " +
  "guessing.";

function assertBeginsWithStandingQuestion(brief: string, which: string): void {
  assert.ok(brief.startsWith(STANDING_QUESTION), `the ${which} brief does not begin with the standing question - rule 11 broken`);
  assert.equal(brief.split(STANDING_QUESTION).length - 1, 1, `the ${which} brief carries the standing question more than once`);
}

// Negative-first: before the commit-ownership line was added to
// STANDING_QUESTION, this assertion is the one that actually catches it -
// startsWith alone would still pass against a stale, shorter duplicate,
// since the old text is a prefix of the new one.
function assertCarriesCommitNotice(brief: string, which: string): void {
  assert.ok(brief.includes(COMMIT_NOTICE), `the ${which} brief does not tell the worker Fabrica commits on its behalf`);
  assert.equal(brief.split(COMMIT_NOTICE).length - 1, 1, `the ${which} brief carries the commit notice more than once`);
}

// Negative-first, same reasoning as assertCarriesCommitNotice: startsWith
// against STANDING_QUESTION alone would still pass against a stale,
// shorter duplicate missing this rule, since the old text is a prefix of
// the new one.
function assertCarriesDocsBeforeGuessingNotice(brief: string, which: string): void {
  assert.ok(
    brief.includes(DOCS_BEFORE_GUESSING_NOTICE),
    `the ${which} brief does not tell the worker to read documentation before calling an outside tool or service`,
  );
  assert.equal(
    brief.split(DOCS_BEFORE_GUESSING_NOTICE).length - 1,
    1,
    `the ${which} brief carries the docs-before-guessing notice more than once`,
  );
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
  assertCarriesCommitNotice(brain.briefs[0], "first-attempt");
  assertCarriesCommitNotice(brain.briefs[1], "retry-after-red");
  assertCarriesCommitNotice(brain.briefs[2], "fix-round");
  assertCarriesDocsBeforeGuessingNotice(brain.briefs[0], "first-attempt");
  assertCarriesDocsBeforeGuessingNotice(brain.briefs[1], "retry-after-red");
  assertCarriesDocsBeforeGuessingNotice(brain.briefs[2], "fix-round");
});

test("rule 11: an answered round's brief begins with the standing question", async () => {
  const brain = fakeBrain({ askQuestion: { question: "Which database?", options: ["Postgres", "SQLite"] } });
  const foreman = createForeman({
    recordHome: mkdtempSync(join(tmpdir(), "fabrica-home-")),
    inspector: fakeInspector("green"),
  });

  const asked = await foreman.do("build me an app", { project: makeFixtureRepo("exit 0"), brain });
  assert.equal(asked.state, "asking");
  await foreman.answer(asked.id, "Use Postgres.");

  assert.equal(brain.briefs.length, 1);
  assertBeginsWithStandingQuestion(brain.briefs[0], "answered-round");
  assertCarriesCommitNotice(brain.briefs[0], "answered-round");
  assertCarriesDocsBeforeGuessingNotice(brain.briefs[0], "answered-round");
});
