// Issue #142: "run only the tests you touched" is carried by each
// project's settings, so it never has to be said per task. Two layers
// here, deliberately: the resolution itself (which project setting and
// which task text produce which answer), and a real round proving the
// answer actually reaches the brief a worker is handed - on a first
// round, an answered round, and a fix round alike, since those are the
// three places that build a brief.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "./foreman.ts";
import { ONLY_TOUCHED_TESTS_NOTICE } from "./standing-question.ts";
import { asksForFullSuite, onlyTouchedTestsFor } from "./touched-tests.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { fakeInspector, fixtureInspector } from "../../contract/helpers/fake-inspector.ts";

function freshHome(projectsToml?: string): string {
  const recordHome = mkdtempSync(join(tmpdir(), "fabrica-touched-tests-home-"));
  if (projectsToml !== undefined) writeFileSync(join(recordHome, "projects.toml"), projectsToml);
  return recordHome;
}

/** Collects every brief a round's worker is actually handed. */
function recordingBrain(opts: Parameters<typeof fakeBrain>[0] = {}) {
  const briefs: string[] = [];
  const brain = fakeBrain({ ...opts, onWork: (brief) => briefs.push(brief) });
  return { brain, briefs };
}

test("asksForFullSuite: only a task plainly asking for the whole suite opts out", () => {
  for (const text of [
    "run the full suite",
    "Please run the full suite before you finish.",
    "RUN THE WHOLE SUITE",
    "run the full test suite this time",
    "run the whole test suite",
  ]) {
    assert.equal(asksForFullSuite(text), true, `"${text}" should opt out`);
  }

  // Narrow on purpose: ordinary task text must never become an
  // accidental opt-out.
  for (const text of [
    "add a full-width suite of buttons",
    "run the tests you touched",
    "the suite is slow",
    "rerun the failing test",
    "document how to run the suite",
  ]) {
    assert.equal(asksForFullSuite(text), false, `"${text}" should not opt out`);
  }
});

test("onlyTouchedTestsFor: on by default, for a registered project and an unregistered path alike", () => {
  const project = makeFixtureRepo("exit 0");

  assert.equal(onlyTouchedTestsFor(freshHome(), project, "do the thing"), true, "no projects.toml at all");
  assert.equal(
    onlyTouchedTestsFor(freshHome(`[projects.demo]\npath = "${project}"\ncheck = "./check.sh"\n`), project, "do the thing"),
    true,
    "an entry written before this setting existed"
  );
});

test("onlyTouchedTestsFor: a project turns it off for good; a task turns it off for itself", () => {
  const project = makeFixtureRepo("exit 0");
  const off = freshHome(
    `[projects.demo]\npath = "${project}"\ncheck = "./check.sh"\nonlyTouchedTests = false\n`
  );
  const on = freshHome(`[projects.demo]\npath = "${project}"\ncheck = "./check.sh"\nonlyTouchedTests = true\n`);

  assert.equal(onlyTouchedTestsFor(off, project, "do the thing"), false, "the project turned it off");
  assert.equal(onlyTouchedTestsFor(on, project, "do the thing"), true);
  assert.equal(
    onlyTouchedTestsFor(on, project, "do the thing, and run the full suite"),
    false,
    "this one task asked for the full suite"
  );
});

test("a registered project's ruling reaches the worker's brief, once, without the task saying it", async () => {
  const project = makeFixtureRepo("exit 0");
  const recordHome = freshHome(`[projects.demo]\npath = "${project}"\ncheck = "./check.sh"\n`);
  const { brain, briefs } = recordingBrain();

  await createForeman({ recordHome, inspector: fixtureInspector() }).do("small change", { project, brain });

  assert.equal(briefs.length, 1);
  assert.ok(briefs[0].includes(ONLY_TOUCHED_TESTS_NOTICE), "the worker was never told the standing ruling");
  assert.equal(briefs[0].split(ONLY_TOUCHED_TESTS_NOTICE).length - 1, 1, "the notice landed more than once");
});

test("a project that turned the ruling off says nothing about it to its workers", async () => {
  const project = makeFixtureRepo("exit 0");
  const recordHome = freshHome(
    `[projects.demo]\npath = "${project}"\ncheck = "./check.sh"\nonlyTouchedTests = false\n`
  );
  const { brain, briefs } = recordingBrain();

  await createForeman({ recordHome, inspector: fixtureInspector() }).do("small change", { project, brain });

  assert.equal(briefs.length, 1);
  assert.ok(!briefs[0].includes(ONLY_TOUCHED_TESTS_NOTICE));
});

test("a task asking for the full suite opts itself out, leaving the project's own setting alone", async () => {
  const project = makeFixtureRepo("exit 0");
  const recordHome = freshHome(`[projects.demo]\npath = "${project}"\ncheck = "./check.sh"\n`);
  const foreman = createForeman({ recordHome, inspector: fixtureInspector() });

  const optedOut = recordingBrain();
  await foreman.do("rework the parser - run the full suite", { project, brain: optedOut.brain });
  assert.ok(!optedOut.briefs[0].includes(ONLY_TOUCHED_TESTS_NOTICE), "this task asked for the full suite");

  const next = recordingBrain();
  await foreman.do("rework the parser", { project, brain: next.brain });
  assert.ok(next.briefs[0].includes(ONLY_TOUCHED_TESTS_NOTICE), "the opt-out leaked into the next task");
});

test("an answered round and a fix round carry the ruling too", async () => {
  const project = makeFixtureRepo("exit 0");
  const recordHome = freshHome(`[projects.demo]\npath = "${project}"\ncheck = "./check.sh"\n`);
  const { brain, briefs } = recordingBrain({ askQuestions: ["Which parser?"] });
  const foreman = createForeman({ recordHome, inspector: fixtureInspector() });

  const asked = await foreman.do("rework the parser", { project, brain });
  assert.equal(asked.state, "asking");
  await foreman.answer(asked.id, "The JSON one.");
  await foreman.verdict(asked.id, "fix", "also handle the empty case");

  assert.equal(briefs.length, 2, "one answered round, one fix round");
  for (const [which, brief] of [["answered", briefs[0]], ["fix", briefs[1]]] as const) {
    assert.ok(brief.includes(ONLY_TOUCHED_TESTS_NOTICE), `the ${which} round's brief lost the ruling`);
    assert.equal(brief.split(ONLY_TOUCHED_TESTS_NOTICE).length - 1, 1, `the ${which} round doubled the ruling`);
  }
});

// A fix round answering an Inspector refusal builds its brief from the
// same call site as any other, with one more part joined in (verdict.ts's
// `refusalCorrection`). Pinned here because the ruling and that part are
// resolved together in one expression: a future edit to either could drop
// the other silently, and a brief missing a line still works.
test("a fix round answering an Inspector refusal carries both the refusal's reason and the ruling", async () => {
  const project = makeFixtureRepo("exit 0");
  const recordHome = freshHome(`[projects.demo]\npath = "${project}"\ncheck = "./check.sh"\n`);
  const inspector = fakeInspector(["green", "refused", "green"], (verdict) =>
    verdict === "refused" ? "Inspector could not start: no container runtime" : `fake Inspector: ${verdict}`
  );
  const foreman = createForeman({ recordHome, inspector });
  // Every round has to leave a real change behind, or the fix round is
  // skipped before Inspector is ever called and there is no refusal for
  // the round after it to answer.
  const briefs: string[] = [];
  let version = 0;
  const brain = fakeBrain({
    onWork: (brief, workdir) => {
      briefs.push(brief);
      writeFileSync(join(workdir, "work.txt"), `v${++version}\n`);
    },
  });

  const task = await foreman.do("rework the parser", { project, brain });
  await foreman.verdict(task.id, "fix", "one more pass");
  await foreman.verdict(task.id, "fix", "have another go now the runtime is back");

  const last = briefs.at(-1)!;
  assert.match(last, /Inspector refused the previous round: Inspector could not start: no container runtime/);
  assert.ok(last.includes(ONLY_TOUCHED_TESTS_NOTICE), "the refusal-answering round's brief lost the ruling");
  assert.equal(last.split(ONLY_TOUCHED_TESTS_NOTICE).length - 1, 1, "it doubled the ruling");
});
