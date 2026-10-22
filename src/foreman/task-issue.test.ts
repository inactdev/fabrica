// The issue a task names, end to end: fetched once at registration,
// frozen on the record, and carried verbatim into every brief - the
// clarifying step, the work, and a fix round - so a task worded "do
// issue #N as written" never has to ask what #N says.
//
// No test here reaches GitHub: every one hands over an IssueReader fake
// (helpers/fake-issue-reader.ts), the same way the suites around it hand
// over a fake Inspector and a fake worker's box.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "./foreman.ts";
import { ForemanError } from "./errors.ts";
import {
  ISSUE_BRIEF_HEADER,
  renderIssueFile,
  resolveIssueRef,
  storedClosesIssue,
  taskIssueText,
  withIssueText,
} from "./task-issue.ts";
import { FAKE_PROJECT_REPO, fakeIssueReader, refusingIssueReader } from "./helpers/fake-issue-reader.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import type { Inspection, Inspector } from "../inspector/index.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { readEvents, readEventsForTask, readTaskFile, writeTaskFile } from "../record/index.ts";

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-task-issue-home-"));
}

/** A fixture project Inspector judges, so a test can read the pull
 * request body Fabrica asks for. */
function inspectedProject(): string {
  const project = makeFixtureRepo("exit 0");
  writeFileSync(join(project, ".inspector.json"), '{"check":"./check.sh","image":"test"}\n');
  execSync("git add .inspector.json && git -c user.email=t@t -c user.name=t commit -qm inspector-config", {
    cwd: project,
    shell: "/bin/bash",
  });
  return project;
}

/** Always green, and keeps the whole request - contract/helpers' own
 * fake records only the branch and workdir, and the pull request body is
 * exactly what these tests are about. */
function greenInspector(): Inspector & { calls: { prTitle?: string; prBody?: string }[] } {
  const calls: { prTitle?: string; prBody?: string }[] = [];
  return {
    calls,
    installed: () => true,
    async inspect(request): Promise<Inspection> {
      calls.push({ prTitle: request.prTitle, prBody: request.prBody });
      return { verdict: "green", report: "fake Inspector: green" };
    },
  };
}

const ISSUE = {
  title: "Carry the issue into the brief",
  body: "The worker must get the issue's own words,\nincluding this second line.",
};

/** Every brief this fake worker was handed, in order. */
function briefsOf(brain: { historyBySession: ReadonlyMap<string, string[]> }): string[] {
  return [...brain.historyBySession.values()].flat();
}

// ----------------------------------------------------------------- units

test("renderIssueFile names the issue, links it, and keeps its body verbatim", () => {
  const text = renderIssueFile({
    ref: { owner: "inactdev", repo: "fabrica", number: 142 },
    title: ISSUE.title,
    body: ISSUE.body,
    url: "https://github.com/inactdev/fabrica/issues/142",
  });

  assert.match(text, /^# inactdev\/fabrica#142: Carry the issue into the brief\n/);
  assert.ok(text.includes("https://github.com/inactdev/fabrica/issues/142"));
  assert.ok(text.includes(ISSUE.body), "the body was reworded or reflowed");
});

test("renderIssueFile says so, rather than nothing, when an issue has no description", () => {
  const text = renderIssueFile({
    ref: { owner: "o", repo: "r", number: 1 },
    title: "A title and nothing else",
    body: "",
    url: "u",
  });
  assert.match(text, /no description/);
});

test("withIssueText appends the issue once, and leaves a brief with no issue alone", () => {
  const issueText = "# o/r#1: t\n\nbody\n";
  const once = withIssueText("do the thing", issueText);

  assert.ok(once.startsWith("do the thing"), "the Client's own words no longer come first");
  assert.ok(once.includes(ISSUE_BRIEF_HEADER));
  assert.ok(once.includes("body"));
  assert.equal(withIssueText(once, issueText), once, "a second application doubled the issue");
  assert.equal(withIssueText("do the thing", null), "do the thing");
  assert.equal(withIssueText("do the thing", "   "), "do the thing");
});

test("storedClosesIssue reads what the record holds, and refuses to half-read it", () => {
  const recordHome = freshHome();
  writeTaskFile(recordHome, "t-own", "issue", "186");
  writeTaskFile(recordHome, "t-other", "issue", "inactdev/inspector#45");
  writeTaskFile(recordHome, "t-junk", "issue", "whatever");

  assert.deepEqual(storedClosesIssue(recordHome, "t-own"), { number: 186 });
  assert.deepEqual(storedClosesIssue(recordHome, "t-other"), { number: 45, repo: "inactdev/inspector" });
  assert.equal(storedClosesIssue(recordHome, "t-junk"), undefined);
  assert.equal(storedClosesIssue(recordHome, "t-none"), undefined);
});

test("resolveIssueRef: a bare number resolves against the project's own repository", () => {
  assert.deepEqual(resolveIssueRef("/some/project", 186, fakeIssueReader().reader), {
    ...FAKE_PROJECT_REPO,
    number: 186,
  });
});

test("resolveIssueRef: an explicitly named repository wins over the project's own", () => {
  assert.deepEqual(resolveIssueRef("/some/project", "inactdev/inspector#45", fakeIssueReader().reader), {
    owner: "inactdev",
    repo: "inspector",
    number: 45,
  });
});

// A project whose origin is not a github.com remote has no repository to
// resolve a bare number against - refused with the two spellings that do
// work, rather than asked about on api.github.com as if its last two
// path segments were an owner and a repository.
test("resolveIssueRef: a project with no GitHub repository refuses, naming what to do instead", () => {
  const project = makeFixtureRepo("exit 0");
  assert.throws(
    () => resolveIssueRef(project, 186, fakeIssueReader({ projectRepo: null }).reader),
    (err: unknown) =>
      err instanceof ForemanError &&
      err.code === "issue-unavailable" &&
      err.message.includes(project) &&
      /owner\/repo#N/.test(err.message)
  );
});

test("resolveIssueRef: a value naming no issue at all is refused before anything else", () => {
  assert.throws(
    () => resolveIssueRef("/some/project", "not-an-issue", fakeIssueReader().reader),
    (err: unknown) => err instanceof ForemanError && err.code === "invalid-issue"
  );
});

// ------------------------------------------------------------ end to end

test("the issue's own words reach the clarifying step and the worker's brief, in full", async () => {
  const recordHome = freshHome();
  const issues = fakeIssueReader(ISSUE);
  const brain = fakeBrain();
  const foreman = createForeman({ recordHome, inspector: greenInspector(), issueReader: issues.reader });

  const task = await foreman.do("do issue #142 as written", { project: inspectedProject(), brain, issue: 142 });

  // Fetched exactly once, at registration, for the whole task.
  assert.equal(issues.calls.length, 1);
  assert.deepEqual(issues.calls[0], { ...FAKE_PROJECT_REPO, number: 142 });

  // The clarifying step - the whole point of this change: a task that
  // only says "as written" has nothing to go on without it.
  assert.equal(brain.askCalls.length, 1);
  assert.ok(brain.askCalls[0].includes(ISSUE.title), "the clarifying step never saw the issue's title");
  assert.ok(brain.askCalls[0].includes(ISSUE.body), "the clarifying step never saw the issue's body");

  // And the work itself.
  const briefs = briefsOf(brain);
  assert.ok(briefs.length > 0);
  assert.ok(briefs.every((brief) => brief.includes(ISSUE.title) && brief.includes(ISSUE.body)));

  // Frozen on the record, so a later round reads it rather than GitHub.
  const stored = taskIssueText(recordHome, task.id) ?? "";
  assert.ok(stored.includes(ISSUE.title) && stored.includes(ISSUE.body));
  assert.equal(readTaskFile(recordHome, task.id, "issue"), "142");
});

test("a fix round carries the same issue, and never asks GitHub again", async () => {
  const recordHome = freshHome();
  const issues = fakeIssueReader(ISSUE);
  let file = 0;
  const brain = fakeBrain({ onWork: (_brief, workdir) => writeFileSync(join(workdir, `f${file++}.txt`), "x\n") });
  const foreman = createForeman({ recordHome, inspector: greenInspector(), issueReader: issues.reader });

  const task = await foreman.do("do issue #142 as written", {
    project: inspectedProject(),
    brain,
    issue: 142,
    attempts: 1,
  });
  const beforeFix = briefsOf(brain).length;
  await foreman.verdict(task.id, "fix", "rename the helper");

  const briefs = briefsOf(brain);
  assert.ok(briefs.length > beforeFix, "the fix round never ran");
  assert.ok(briefs.at(-1)!.includes(ISSUE.body), "the fix round's worker lost the issue");
  assert.ok(briefs.at(-1)!.includes("rename the helper"), "the fix round lost the Client's note");
  assert.equal(issues.calls.length, 1, "the issue was fetched again instead of read off the record");
});

// Decision 4: a fetch that fails refuses the task, naming the cause,
// before any ProductionLine is cut.
test("an unreadable issue refuses the task before anything is cut, naming the cause", async () => {
  const recordHome = freshHome();
  const brain = fakeBrain();
  const refusal = "GitHub has no issue fixture-owner/fixture-project#9000 this token can read (HTTP 404).";
  const foreman = createForeman({
    recordHome,
    inspector: greenInspector(),
    issueReader: refusingIssueReader(refusal).reader,
  });

  await assert.rejects(
    () => foreman.do("do issue #9000 as written", { project: inspectedProject(), brain, issue: 9000 }),
    (err: unknown) =>
      err instanceof ForemanError && err.code === "issue-unavailable" && err.message.includes(refusal)
  );

  // Nothing started: no clarifying call, no line, no work - and the
  // task's own record says what happened rather than staying silent at
  // "task-received".
  assert.equal(brain.askCalls.length, 0, "the clarifying step ran anyway");
  const events = onlyTaskEvents(recordHome);
  assert.deepEqual(
    events.map((event) => event.name),
    ["task-received", "task-failed"]
  );
  assert.ok(((events[1].details as { message?: string }).message ?? "").includes(refusal));
});

test("an issue in another repository is closed by its full name, and recorded that way", async () => {
  const recordHome = freshHome();
  const inspector = greenInspector();
  const foreman = createForeman({ recordHome, inspector, issueReader: fakeIssueReader(ISSUE).reader });

  const task = await foreman.do("do the Fabrica half of the inspector issue", {
    project: inspectedProject(),
    brain: fakeBrain(),
    issue: "https://github.com/inactdev/inspector/issues/45",
  });

  assert.equal(readTaskFile(recordHome, task.id, "issue"), "inactdev/inspector#45");
  assert.equal(inspector.calls.length, 1);
  assert.match(inspector.calls[0].prBody ?? "", /^Closes inactdev\/inspector#45\n/);
});

test("a task that names no issue is untouched: no fetch, no record file, no brief section", async () => {
  const recordHome = freshHome();
  const issues = fakeIssueReader(ISSUE);
  const brain = fakeBrain();
  const foreman = createForeman({ recordHome, inspector: greenInspector(), issueReader: issues.reader });

  const task = await foreman.do("add a comment", { project: inspectedProject(), brain });

  assert.equal(issues.calls.length, 0);
  assert.equal(taskIssueText(recordHome, task.id), null);
  assert.equal(readTaskFile(recordHome, task.id, "issue"), null);
  assert.ok(briefsOf(brain).every((brief) => !brief.includes(ISSUE_BRIEF_HEADER)));
});

/** Every event of the one task a record home holds - for the refusal
 * above, where `do()` threw and never handed back a task id. */
function onlyTaskEvents(recordHome: string) {
  const ids = new Set(readEvents(recordHome).map((event) => event.taskId));
  assert.equal(ids.size, 1, "expected exactly one task in this record home");
  return readEventsForTask(recordHome, [...ids][0]);
}
