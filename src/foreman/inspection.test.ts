import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "./foreman.ts";
import { ForemanError } from "./errors.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { fakeIssueReader } from "./helpers/fake-issue-reader.ts";
import type { Brain } from "../brain/index.ts";
import type { Inspection, Inspector } from "../inspector/index.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { fixtureCheckBox } from "../../contract/helpers/fake-check-box.ts";
import { runLogCommand } from "../cli/log-command.ts";
import { readEventsForTask, readTaskFile } from "../record/index.ts";
import { handToInspector } from "./inspection.ts";

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-inspection-home-"));
}

function inspectedProject(): string {
  const project = makeFixtureRepo("exit 0");
  writeFileSync(join(project, ".inspector.json"), '{"check":"./check.sh","image":"test"}\n');
  execSync("git add .inspector.json && git -c user.email=t@t -c user.name=t commit -qm inspector-config", {
    cwd: project,
    shell: "/bin/bash",
  });
  return project;
}

function fakeInspector(
  ...results: Inspection[]
): Inspector & { calls: { branch: string; workdir: string; prTitle?: string; prBody?: string }[] } {
  const calls: { branch: string; workdir: string; prTitle?: string; prBody?: string }[] = [];
  return {
    calls,
    async inspect(request) {
      calls.push(request);
      const result = results.shift();
      assert.ok(result, "Inspector was called more often than this test arranged");
      return result;
    },
  };
}

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (line: string) => out.push(line), stderr: (line: string) => err.push(line) };
}

test("a green Fabrica check hands a configured branch to Inspector before delivery, and the log keeps its report", async () => {
  const recordHome = freshHome();
  const inspector = fakeInspector({ verdict: "green", report: "independent check passed" });
  const foreman = createForeman({ recordHome, inspector });

  const task = await foreman.do("small change", { project: inspectedProject(), brain: fakeBrain() });

  assert.equal(task.state, "delivered");
  const delivery = await foreman.deliveryOf(task.id);
  assert.equal(delivery?.outcome, "done");
  assert.deepEqual(delivery?.inspection, { verdict: "green", report: "independent check passed" });
  assert.match(readTaskFile(recordHome, task.id, "delivery.md") ?? "", /inspection: green: independent check passed/);
  assert.equal(inspector.calls.length, 1);
  assert.equal(inspector.calls[0].branch, delivery?.branch);

  const io = captureIo();
  assert.equal(await runLogCommand([task.id], { recordHome, ...io }), 0);
  assert.deepEqual(io.err, []);
  assert.ok(io.out.some((line) => line.includes(`Inspector called for ${delivery?.branch}`)));
  assert.ok(io.out.some((line) => line.includes("Inspector green: independent check passed")));
});

// "Make every pull request it opens close its issue on merge": case 1,
// the task's own text names the issue as the whole of the work.
test("a task whose text starts with \"Issue #N:\" gets a pull request body opening with Closes #N", async () => {
  const recordHome = freshHome();
  const inspector = fakeInspector({ verdict: "green", report: "ok" });
  const foreman = createForeman({ recordHome, inspector });

  await foreman.do("Issue #186: add retries", { project: inspectedProject(), brain: fakeBrain() });

  assert.equal(inspector.calls.length, 1);
  assert.match(inspector.calls[0].prBody ?? "", /^Closes #186\n/);
});

// Case 2, the chat agent names the issue explicitly instead - even when
// the text itself doesn't start with the "Issue #N:" prefix. The
// explicit path now also fetches the issue (src/foreman/task-issue.ts),
// so it needs an IssueReader: a fake, like the Inspector above, so no
// test reaches the real GitHub.
test("a task whose caller names an issue explicitly gets the same closing line", async () => {
  const recordHome = freshHome();
  const inspector = fakeInspector({ verdict: "green", report: "ok" });
  const foreman = createForeman({ recordHome, inspector, issueReader: fakeIssueReader().reader });

  await foreman.do("add retries, see the issue tracker", { project: inspectedProject(), brain: fakeBrain(), issue: 186 });

  assert.equal(inspector.calls.length, 1);
  assert.match(inspector.calls[0].prBody ?? "", /^Closes #186\n/);
});

// A task that is only part of an issue's work names it in passing, not
// as the whole of the work - no closing line, and the explicit path
// (case 2) is simply never used for it.
test("a task that is only part of an issue's work gets no closing line", async () => {
  const recordHome = freshHome();
  const inspector = fakeInspector({ verdict: "green", report: "ok" });
  const foreman = createForeman({ recordHome, inspector });

  await foreman.do("the first half of #186, only the worker part", { project: inspectedProject(), brain: fakeBrain() });

  assert.equal(inspector.calls.length, 1);
  assert.ok(!/Closes #/.test(inspector.calls[0].prBody ?? ""));
});

// A "fix" round re-opens the same pull request's body - the closing
// line must still be there, re-derived from the record rather than lost
// once the first round's process has exited.
test("a fix round's pull request body still opens with Closes #N", async () => {
  const recordHome = freshHome();
  const inspector = fakeInspector({ verdict: "red", report: "lint fails" }, { verdict: "green", report: "fixed" });
  const brain = fakeBrain({ onWork: (_brief, workdir) => writeFileSync(join(workdir, "f.txt"), `${Math.random()}\n`) });
  const foreman = createForeman({ recordHome, inspector });

  const task = await foreman.do("Issue #186: add retries", { project: inspectedProject(), brain, attempts: 1 });
  await foreman.verdict(task.id, "fix", "repair the lint failure");

  assert.equal(inspector.calls.length, 2);
  assert.match(inspector.calls[1].prBody ?? "", /^Closes #186\n/);
});

// Negative first (the write-up rule's own fix #1, revised by the
// structured write-up ruling 2026-10-13): a worker whose write-up is
// invalid is red on that alone - judge() never runs for that attempt, so
// there is no Inspector call and no pull request for it. Its work is
// committed with a fallback message, and the later valid attempt amends
// that unpublished commit: exactly one commit, one Inspector call, one
// pull request.
test("an invalid write-up is red with no Inspector call and no PR - a later valid one leaves exactly one of each, and one commit", async () => {
  const recordHome = freshHome();
  const project = inspectedProject();
  const baseCommit = execSync("git rev-parse HEAD", { cwd: project, encoding: "utf8" }).trim();
  const inspector = fakeInspector({ verdict: "green", report: "ok", prUrl: "https://example.test/pulls/7" });
  const titles = ["x".repeat(145), "Add the feature"];
  let calls = 0;
  const brain: Brain = {
    name: "fake",
    model: "fake-1",
    async ask() {
      return {};
    },
    async work(_brief, workdir) {
      writeFileSync(join(workdir, `feature-${calls}.txt`), "work\n");
      const title = titles[calls++];
      return {
        transcript: [],
        session: "s1",
        writeup: {
          title,
          why: "b",
          what: "a",
          how: "c",
          outsideChanges: "None.",
          confidence: 90,
          assumptions: "None.",
          expectedOutcomes: "None.",
          deviations: "None.",
          quiz: [
            { question: "What changed?", answer: "The thing this test is about." },
            { question: "Why?", answer: "So the write-up is valid." },
            { question: "What should the owner watch?", answer: "Nothing - this is a test." },
          ],
        },
      };
    },
  };
  const foreman = createForeman({ recordHome, inspector });

  const task = await foreman.do("small change", { project, brain, attempts: 2 });

  assert.equal(calls, 2, "both attempts ran - the invalid one is a correctable red, not a stop");
  assert.equal(task.state, "delivered");
  const delivery = await foreman.deliveryOf(task.id);
  assert.equal(delivery?.outcome, "done");
  assert.equal(inspector.calls.length, 1, "Inspector is never called for the invalid attempt");

  const commitCount = execSync(`git rev-list --count ${baseCommit}..${delivery!.branch}`, {
    cwd: project,
    encoding: "utf8",
  }).trim();
  assert.equal(commitCount, "1", "exactly one commit - the invalid attempt's commit is amended, never stacked on");

  const events = await foreman.events(task.id);
  assert.equal(events.filter((event) => event.name === "pr-opened").length, 1);
});

test("an Inspector red report reaches the Client and a fix returns to the same warm worker and branch", async () => {
  const recordHome = freshHome();
  const inspector = fakeInspector(
    { verdict: "red", report: "lint still fails in app.ts" },
    { verdict: "green", report: "lint repaired" }
  );
  // Each call writes a new version of the same file, so the fix round
  // lands a real new commit and is genuinely handed to Inspector again,
  // rather than being skipped as a no-op round.
  let version = 0;
  const brain = fakeBrain({ onWork: (_brief, workdir) => writeFileSync(join(workdir, "lint-fix.txt"), `v${++version}\n`) });
  const foreman = createForeman({ recordHome, inspector });

  // One attempt, so Inspector's red goes to the Client rather than into a
  // second attempt's brief.
  const task = await foreman.do("small change", { project: inspectedProject(), brain, attempts: 1 });
  const redDelivery = await foreman.deliveryOf(task.id);

  assert.equal(task.state, "delivered", "Inspector red still reaches the Client for a verdict");
  assert.equal(redDelivery?.outcome, "inspection-red");
  assert.deepEqual(redDelivery?.inspection, { verdict: "red", report: "lint still fails in app.ts" });
  assert.match(redDelivery?.evidence ?? "", /lint still fails in app\.ts/);
  const firstSession = (await foreman.receiptsOf(task.id))[0].session;
  assert.ok(firstSession);

  await foreman.verdict(task.id, "fix", "repair the lint failure");

  assert.equal(brain.calls, 2);
  assert.deepEqual([...brain.historyBySession.keys()], [firstSession]);
  assert.equal(inspector.calls.length, 2);
  assert.equal(inspector.calls[1].branch, inspector.calls[0].branch);
  assert.equal(inspector.calls[1].workdir, inspector.calls[0].workdir);
  assert.equal((await foreman.deliveryOf(task.id))?.outcome, "done");
});

test("an Inspector refusal records its reason as no verdict, never as red", async () => {
  const recordHome = freshHome();
  const inspector = fakeInspector({ verdict: "refused", report: "GITHUB_TOKEN is missing" });
  const foreman = createForeman({ recordHome, inspector });

  const task = await foreman.do("small change", { project: inspectedProject(), brain: fakeBrain() });

  assert.equal(task.state, "refused");
  assert.equal(await foreman.deliveryOf(task.id), null, "a refusal must not be turned into a Client delivery");
  assert.equal((await foreman.receiptsOf(task.id)).length, 1, "completed work keeps its attempt receipt");
  assert.equal((await foreman.status()).find((candidate) => candidate.id === task.id)?.state, "refused");
  await assert.rejects(
    () => foreman.verdict(task.id, "accept"),
    (err: unknown) => err instanceof ForemanError && err.code === "inspection-refused"
  );

  const io = captureIo();
  assert.equal(await runLogCommand([task.id], { recordHome, ...io }), 0);
  assert.ok(io.out.some((line) => line.includes("Inspector refused: GITHUB_TOKEN is missing")));
  assert.ok(!io.out.some((line) => line.includes("Inspector red")));
});

test("removing Inspector config cannot bypass a handoff required by the task base commit", async () => {
  const recordHome = freshHome();
  const inspector = fakeInspector({ verdict: "green", report: "should not be called" });
  const project = inspectedProject();
  const foreman = createForeman({ recordHome, inspector });

  const task = await foreman.do("remove config", {
    project,
    brain: fakeBrain({ onWork: (_brief, workdir) => rmSync(join(workdir, ".inspector.json")) }),
  });

  assert.equal(task.state, "refused");
  assert.equal(inspector.calls.length, 0);
  const events = await foreman.events(task.id);
  assert.ok(!events.some((event) => event.name === "inspection-skipped"));
  assert.ok(!events.some((event) => event.name === "inspector-called"));
  const details = events.filter((event) => event.name === "inspection-finished").at(-1)?.details as Inspection;
  assert.equal(details.verdict, "refused");
  assert.equal(details.report, "Inspector could not run: .inspector.json was removed from the ProductionLine");
});

test("changing Inspector config cannot weaken inspection established by the task base commit", async () => {
  const recordHome = freshHome();
  const inspector = fakeInspector({ verdict: "green", report: "should not be called" });
  const project = inspectedProject();
  const foreman = createForeman({ recordHome, inspector });

  const task = await foreman.do("weaken config", {
    project,
    brain: fakeBrain({
      onWork: (_brief, workdir) => writeFileSync(join(workdir, ".inspector.json"), '{"check":"true"}\n'),
    }),
  });

  assert.equal(task.state, "refused");
  assert.equal(inspector.calls.length, 0);
  assert.equal(await foreman.deliveryOf(task.id), null);
  assert.equal((await foreman.receiptsOf(task.id)).length, 1);
  const events = await foreman.events(task.id);
  assert.ok(!events.some((event) => event.name === "inspector-called"));
  const details = events.filter((event) => event.name === "inspection-finished").at(-1)?.details as Inspection;
  assert.equal(details.verdict, "refused");
  assert.equal(details.report, "Inspector could not run: .inspector.json differs from the task base commit");
});

test("a fix round cannot disable inspection established by the task base commit", async () => {
  const recordHome = freshHome();
  const inspector = fakeInspector({ verdict: "red", report: "needs a fix" });
  let workRound = 0;
  const brain = fakeBrain({
    onWork: (_brief, workdir) => {
      workRound += 1;
      if (workRound === 2) rmSync(join(workdir, ".inspector.json"));
    },
  });
  const foreman = createForeman({ recordHome, inspector });

  const task = await foreman.do("small change", { project: inspectedProject(), brain, attempts: 1 });
  assert.equal((await foreman.deliveryOf(task.id))?.outcome, "inspection-red");

  // Exercises recordVerdict directly - handToInspector's own behavior is
  // what this test is about, not the CLI's detached-process wiring
  // (src/cli/verdict-command.test.ts covers that separately, and the two
  // can't share this test's in-process `inspector`/`brain` fakes once a
  // "fix" round is handed to a different process).
  await foreman.verdict(task.id, "fix", "apply the requested fix");

  assert.equal(inspector.calls.length, 1);
  assert.equal((await foreman.status()).find((candidate) => candidate.id === task.id)?.state, "refused");
  assert.equal(await foreman.deliveryOf(task.id), null);
  assert.equal((await foreman.receiptsOf(task.id)).length, 2, "the refused fix round keeps its new receipt");
  const events = await foreman.events(task.id);
  const verdictIndex = events.map((event) => event.name).lastIndexOf("verdict-recorded");
  assert.ok(!events.slice(verdictIndex).some((event) => event.name === "inspection-skipped"));
  assert.equal(
    (events.filter((event) => event.name === "inspection-finished").at(-1)?.details as Inspection).verdict,
    "refused"
  );
});

test("an answered Inspector refusal completes the clarification round without requesting a verdict", async () => {
  const recordHome = freshHome();
  const inspector = fakeInspector({ verdict: "refused", report: "publishing is unavailable" });
  const foreman = createForeman({ recordHome, inspector });
  const task = await foreman.do("build me an app", {
    project: inspectedProject(),
    brain: fakeBrain({ askQuestions: ["Which database?"] }),
  });

  // Exercises answerTask directly - same reasoning as the fix-round test
  // above: this is about handToInspector's behavior, not the CLI's
  // detached-process wiring.
  const resumed = await foreman.answer(task.id, "Use Postgres.");
  assert.equal(resumed.state, "refused");
  assert.equal(await foreman.deliveryOf(task.id), null);

  await assert.rejects(
    () => foreman.answer(task.id, "Use SQLite instead."),
    /already got its one clarification round/
  );
});

test("Inspector handoff records heartbeats while awaiting a verdict", async () => {
  const recordHome = freshHome();
  const project = inspectedProject();
  const baseCommit = execSync("git rev-parse HEAD", { cwd: project, encoding: "utf8" }).trim();
  const inspector: Inspector = {
    async inspect() {
      await new Promise((resolve) => setTimeout(resolve, 35));
      return { verdict: "green", report: "done" };
    },
  };

  await handToInspector(
    recordHome,
    "heartbeat-task",
    { taskId: "heartbeat-task", branch: "fabrica/heartbeat-task", project, workdir: project, recordHome },
    baseCommit,
    inspector,
    { heartbeatIntervalMs: 5 }
  );

  const events = readEventsForTask(recordHome, "heartbeat-task");
  assert.ok(events.some((event) => event.name === "heartbeat"));
  assert.equal(events.at(-1)?.name, "inspection-finished");
});

test("a project without Inspector config is self-tested in the worker's box, never handed to Inspector", async () => {
  const recordHome = freshHome();
  const inspector = fakeInspector({ verdict: "green", report: "should not be called" });
  const foreman = createForeman({ recordHome, inspector, checkBox: fixtureCheckBox().box });

  const task = await foreman.do("small change", {
    project: makeFixtureRepo("exit 0", { inspector: false }),
    brain: fakeBrain(),
  });

  assert.equal(task.state, "delivered");
  const delivery = await foreman.deliveryOf(task.id);
  assert.equal(delivery?.outcome, "done");
  assert.equal(delivery?.inspection, undefined);
  assert.equal(inspector.calls.length, 0);
  assert.ok((await foreman.events(task.id)).some((event) => event.name === "inspection-skipped"));
});

// Negative first: Inspector reporting green, with a report that never
// mentions a pull request, must leave no "pr-opened" event behind - that
// event is only ever allowed to key on Inspector's own stdout line.
test("no pr-opened event is recorded when Inspector's result carries no pull request url", async () => {
  const recordHome = freshHome();
  const inspector = fakeInspector({ verdict: "green", report: "independent check passed" });
  const foreman = createForeman({ recordHome, inspector });

  const task = await foreman.do("small change", { project: inspectedProject(), brain: fakeBrain() });

  const events = await foreman.events(task.id);
  assert.ok(!events.some((event) => event.name === "pr-opened"));
});

test("a pr-opened event carries Inspector's reported url exactly once", async () => {
  const recordHome = freshHome();
  const inspector = fakeInspector({
    verdict: "green",
    report: "independent check passed",
    prUrl: "https://example.test/pulls/42",
  });
  const foreman = createForeman({ recordHome, inspector });

  const task = await foreman.do("small change", { project: inspectedProject(), brain: fakeBrain() });

  const events = await foreman.events(task.id);
  const prEvents = events.filter((event) => event.name === "pr-opened");
  assert.equal(prEvents.length, 1);
  assert.deepEqual(prEvents[0].details, { url: "https://example.test/pulls/42" });
});

// Pull requests must read like a human wrote them: Inspector is handed
// the worker's own write-up title and sections, never the raw task text -
// "Fix the login bug..." here is deliberately not what either field
// carries.
test("Inspector is handed the worker's own write-up title as pr-title and its sections as pr-body", async () => {
  const recordHome = freshHome();
  const inspector = fakeInspector({ verdict: "green", report: "ok" });
  const foreman = createForeman({ recordHome, inspector });
  const brain = fakeBrain({
    writeup: {
      title: "Fix retry on login timeout",
      why: "It happens on retry.",
      what: "Retries once.",
      how: "Added a retry.",
      outsideChanges: "None.",
      confidence: 92,
      assumptions: "None.",
      expectedOutcomes: "Login no longer fails on the first timeout.",
      deviations: "None.",
      quiz: [
        { question: "What changed?", answer: "The thing this test is about." },
        { question: "Why?", answer: "So the write-up is valid." },
        { question: "What should the owner watch?", answer: "Nothing - this is a test." },
      ],
      couldNotVerify: "The login service itself was not reachable from here.",
    },
  });

  await foreman.do("Fix the login bug\n\nIt happens on retry.", { project: inspectedProject(), brain });

  assert.equal(inspector.calls.length, 1);
  assert.equal(inspector.calls[0].prTitle, "Fix retry on login timeout");
  assert.equal(
    inspector.calls[0].prBody,
    "## Context (Why)\n\nIt happens on retry.\n\n" +
      "## Description (What)\n\nRetries once.\n\n" +
      "## Changes in the codebase (How)\n\nAdded a retry.\n\n" +
      "## Changes outside the codebase\n\nNone.\n\n" +
      "## Additional information\n\n" +
      "- Confidence: 92/100\n" +
      "- Assumptions: None.\n" +
      "- Expected outcomes: Login no longer fails on the first timeout.\n" +
      "- Deviations: None.\n" +
      "- Could not verify here: The login service itself was not reachable from here."
  );
});

// Negative first: an Inspector that writes no report files leaves nothing
// in the task folder to read back.
test("no report files are copied into the task folder when Inspector writes none", async () => {
  const recordHome = freshHome();
  const inspector = fakeInspector({ verdict: "green", report: "independent check passed" });
  const foreman = createForeman({ recordHome, inspector });

  const task = await foreman.do("small change", { project: inspectedProject(), brain: fakeBrain() });

  assert.equal(readTaskFile(recordHome, task.id, "inspector-latest.json"), null);
  assert.equal(readTaskFile(recordHome, task.id, "inspector-run.json"), null);
});

test("Inspector's report files are copied into the task folder before the worktree is torn down", async () => {
  const recordHome = freshHome();
  const inspector: Inspector = {
    async inspect(request) {
      mkdirSync(join(request.workdir, ".inspector", "runs"), { recursive: true });
      writeFileSync(join(request.workdir, ".inspector", "runs", "run-1.json"), '{"ok":true}');
      writeFileSync(join(request.workdir, ".inspector", "latest.json"), '{"run":"run-1.json"}');
      return { verdict: "green", report: "done" };
    },
  };
  const foreman = createForeman({ recordHome, inspector });

  const task = await foreman.do("small change", { project: inspectedProject(), brain: fakeBrain() });

  assert.equal(readTaskFile(recordHome, task.id, "inspector-latest.json"), '{"run":"run-1.json"}');
  assert.equal(readTaskFile(recordHome, task.id, "inspector-run.json"), '{"ok":true}');
});
