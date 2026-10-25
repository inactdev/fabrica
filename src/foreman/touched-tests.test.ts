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
import { execFileSync } from "node:child_process";
import { readEventsForTask } from "../record/index.ts";
import { ForemanError } from "./errors.ts";
import { TEST_MAP_FILENAME } from "../testmap/index.ts";
import type { WorkerWriteup } from "../brain/index.ts";

function branchExists(project: string, branch: string): boolean {
  const out = execFileSync("git", ["branch", "--list", branch], { cwd: project, encoding: "utf8" });
  return out.trim().length > 0;
}

/** A valid write-up that also reports which mapped tests ran. */
function writeupReporting(testsRun: string): WorkerWriteup {
  return {
    title: "Fake brain update",
    why: "Testing.",
    what: "Did the thing.",
    how: "Directly.",
    outsideChanges: "None.",
    confidence: 90,
    assumptions: "None.",
    expectedOutcomes: "The fake's work lands as described.",
    deviations: "None.",
    quiz: [
      { question: "What changed?", answer: "The fake brain's own stand-in change." },
      { question: "Why?", answer: "So a test has a valid write-up to work with." },
      { question: "What should the owner watch?", answer: "Nothing - this is a test fixture." },
    ],
    testsRun,
  };
}

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

// ---------------------------------------------------------------------
// A project's committed test map (tests.map). The resolution's own unit
// tests are src/testmap/; these prove it reaches the three places that
// matter - the brief, the delivery, and a task that fails before any
// ProductionLine exists.
// ---------------------------------------------------------------------

test("a project committing a test map gets its notice INSTEAD of the only-touched-tests one", async () => {
  // Never both: that notice tells a worker not to run the project's
  // whole suite, and the map's own ruling tells it to run the whole
  // suite once the mapped tests are green.
  const project = makeFixtureRepo("exit 0");
  writeFileSync(join(project, TEST_MAP_FILENAME), "app.txt: check.sh\n");
  const recordHome = freshHome(`[projects.demo]\npath = "${project}"\ncheck = "./check.sh"\n`);
  const { brain, briefs } = recordingBrain();

  await createForeman({ recordHome, inspector: fixtureInspector() }).do("small change", { project, brain });

  assert.equal(briefs.length, 1);
  assert.ok(!briefs[0].includes(ONLY_TOUCHED_TESTS_NOTICE), "the brief told the worker both things at once");
  assert.match(briefs[0], /tests\.map/);
  assert.match(briefs[0], /whole suite/);
  // A first round has touched nothing yet, so no list is invented for it.
  assert.ok(!briefs[0].includes("run these first"));
});

test("the delivery records the mapped tests, the worker's own list, and every unmapped touched file", async () => {
  const project = makeFixtureRepo("exit 0");
  writeFileSync(join(project, TEST_MAP_FILENAME), "mapped.txt: check.sh\n");
  const recordHome = freshHome(`[projects.demo]\npath = "${project}"\ncheck = "./check.sh"\n`);
  const brain = fakeBrain({
    writeup: writeupReporting("check.sh - green"),
    onWork: (_brief, workdir) => {
      writeFileSync(join(workdir, "mapped.txt"), "covered\n");
      writeFileSync(join(workdir, "stray.txt"), "covered by nothing\n");
    },
  });
  const foreman = createForeman({ recordHome, inspector: fixtureInspector() });

  const task = await foreman.do("touch two files", { project, brain });
  const delivery = await foreman.deliveryOf(task.id);

  assert.deepEqual(delivery?.tests?.tests, ["check.sh"]);
  assert.deepEqual(delivery?.tests?.unmapped, ["stray.txt"]);
  // The worker's own words, carried verbatim and never compared against
  // the mapped list (Client ruling: the record is the worker's own
  // report; the full suite's own run is the independent check).
  assert.equal(delivery?.tests?.reportedByWorker, "check.sh - green");
  assert.deepEqual(delivery?.tests?.broken, []);
});

test("a fix round's brief names the concrete tests its branch has already touched", async () => {
  const project = makeFixtureRepo("exit 0");
  writeFileSync(join(project, TEST_MAP_FILENAME), "mapped.txt: check.sh\n");
  const recordHome = freshHome(`[projects.demo]\npath = "${project}"\ncheck = "./check.sh"\n`);
  const briefs: string[] = [];
  let version = 0;
  const brain = fakeBrain({
    onWork: (brief, workdir) => {
      briefs.push(brief);
      writeFileSync(join(workdir, "mapped.txt"), `v${++version}\n`);
      writeFileSync(join(workdir, "stray.txt"), `v${version}\n`);
    },
  });
  const foreman = createForeman({ recordHome, inspector: fixtureInspector() });

  const task = await foreman.do("touch two files", { project, brain });
  await foreman.verdict(task.id, "fix", "one more pass");

  assert.equal(briefs.length, 2);
  // The first round had nothing to resolve; the fix round's branch
  // carries a real diff, so its worker is handed the list itself.
  assert.ok(!briefs[0].includes("run these first"));
  assert.match(briefs[1], /run these first:\n {2}- check\.sh/);
  assert.match(briefs[1], /mapped to nothing[^]*- stray\.txt/);
});

test("a project whose tests.map cannot be read fails the task before any line is cut", async () => {
  const project = makeFixtureRepo("exit 0");
  writeFileSync(join(project, TEST_MAP_FILENAME), "app.txt: check.sh\nnonsense\n");
  const recordHome = freshHome(`[projects.demo]\npath = "${project}"\ncheck = "./check.sh"\n`);
  const { brain, briefs } = recordingBrain();
  let taskId: string | undefined;
  const foreman = createForeman({
    recordHome,
    inspector: fixtureInspector(),
    onTaskRegistered: (id) => {
      taskId = id;
    },
  });

  await assert.rejects(
    () => foreman.do("small change", { project, brain }),
    (err: unknown) => {
      assert.ok(err instanceof ForemanError, `not a ForemanError: ${err}`);
      assert.equal(err.code, "test-map-unreadable");
      return true;
    }
  );

  assert.equal(briefs.length, 0, "a worker ran against a map nobody could read");
  const names = readEventsForTask(recordHome, taskId!).map((event) => event.name);
  assert.ok(!names.includes("line-cut"), `a ProductionLine was cut anyway: ${names.join(", ")}`);
  // The record always says what happened, even for a task that never
  // got a brief.
  assert.ok(names.includes("task-failed"), "the record does not say the task failed");
  assert.ok(!branchExists(project, `fabrica/${taskId}`), "a branch was left behind");
});
