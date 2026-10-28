// A rebase-only fix round: the Client's note begins "master moved", so
// the round is a rebase and nothing else. The pure parts of the policy
// are driven directly; the round's shape is driven through
// `createForeman`, like src/foreman/fix-rebase.test.ts, because what is
// worth proving is what the worker is told, what the pull request ends
// up saying, and that a note of any other shape still gets today's full
// round.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "./foreman.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { makeFixtureRepo, pushToOrigin } from "../../contract/helpers/fixture.ts";
import { fixtureCheckExit } from "../../contract/helpers/fake-check-box.ts";
import { latestDeliveredDetails } from "./queries.ts";
import { finalMessageFor } from "./pr-body.ts";
import { testMapReport } from "../testmap/index.ts";
import {
  appendRebaseRound,
  isRebaseOnlyNote,
  pullRequestOnRecord,
  publishedPullRequestMessage,
  rebaseOnlyBriefNotice,
  rebaseOnlyMessage,
  rebaseOnlyProblem,
  rebaseRoundEntry,
  REBASE_ROUNDS_HEADING,
  withRebaseRoundSection,
} from "./rebase-only.ts";
import type { FabricaEvent } from "../record/index.ts";
import type { Inspector } from "../inspector/index.ts";
import type { WorkerWriteup } from "../brain/index.ts";

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-rebase-only-home-"));
}

const QUIZ = [
  { question: "q1", answer: "a1" },
  { question: "q2", answer: "a2" },
  { question: "q3", answer: "a3" },
];

function writeup(fields: Partial<WorkerWriteup> = {}): WorkerWriteup {
  return {
    title: "Add the thing",
    why: "The product needs the thing.",
    what: "Added it.",
    how: "A new module.",
    outsideChanges: "None.",
    confidence: 90,
    assumptions: "None.",
    expectedOutcomes: "The thing works.",
    deviations: "None.",
    quiz: QUIZ,
    ...fields,
  };
}

function event(name: FabricaEvent["name"], details: unknown, occurredAt = "2026-10-20T10:00:00.000Z"): FabricaEvent {
  return { occurredAt, taskId: "task-1", name, details };
}

test("only a note that begins with \"master moved\" asks for a rebase-only round", () => {
  assert.equal(isRebaseOnlyNote("master moved"), true);
  assert.equal(isRebaseOnlyNote("master moved, rebase and resolve"), true);
  assert.equal(isRebaseOnlyNote("Master moved on - bring the branch up"), true);
  assert.equal(isRebaseOnlyNote("  master moved\n"), true);
  // Anchored, like pr-body.ts's issue prefix: a note that mentions it in
  // passing is asking for ordinary work on top of that fact.
  assert.equal(isRebaseOnlyNote("rebase please, master moved"), false);
  assert.equal(isRebaseOnlyNote("the master moved files need renaming"), false);
  assert.equal(isRebaseOnlyNote("tidy the error message"), false);
  assert.equal(isRebaseOnlyNote(""), false);
});

test("a rebase-only brief names only the tests the map maps the conflicted files to", () => {
  const entries = [
    { pattern: "src/a.ts", tests: ["npm test -- a"], line: 1 },
    { pattern: "src/b.ts", tests: ["npm test -- b"], line: 2 },
  ];
  const notice = rebaseOnlyBriefNotice(["src/a.ts"], testMapReport(entries, ["src/a.ts"]));

  assert.match(notice, /This round is a rebase and nothing else/);
  assert.match(notice, /- npm test -- a/);
  assert.doesNotMatch(notice, /npm test -- b/, "a test mapped to a file that did not conflict was named");
  assert.match(notice, /NOT the project's whole suite/);
  // The one-section instruction, and what it is appended to.
  assert.match(notice, /write-up for this round is one section/);
  assert.match(notice, /Rebase rounds/);
});

test("a rebase-only brief with nothing mapped, and one with nothing conflicted, both say to run nothing", () => {
  const unmapped = rebaseOnlyBriefNotice(["src/a.ts"], testMapReport([{ pattern: "src/z.ts", tests: ["t"], line: 1 }], ["src/a.ts"]));
  assert.match(unmapped, /Run nothing in this box/);
  assert.match(unmapped, /maps to the files that conflicted/);
  assert.match(unmapped, /- src\/a\.ts/, "the unmapped conflicted file was not named");

  // No map at all: the same instruction, naming the real reason.
  const noMap = rebaseOnlyBriefNotice(["src/a.ts"], undefined);
  assert.match(noMap, /Run nothing in this box/);
  assert.match(noMap, /commits no tests\.map/);

  // Nothing conflicted at all: nothing to resolve, nothing to run.
  const clean = rebaseOnlyBriefNotice([], undefined);
  assert.match(clean, /Nothing conflicted/);
  assert.doesNotMatch(clean, /Run exactly these tests/);
});

test("a rebase-only write-up needs its title and its one section, and nothing else", () => {
  assert.equal(rebaseOnlyProblem(writeup({ why: "", deviations: "", quiz: [] })), undefined);
  assert.equal(rebaseOnlyProblem(undefined), "the worker returned no write-up");
  assert.equal(
    rebaseOnlyProblem(writeup({ how: "   " })),
    "the how field is empty - it is the one section a rebase round reports"
  );
  assert.equal(rebaseOnlyProblem(writeup({ title: "" })), "the title field is empty");
  assert.match(rebaseOnlyProblem(writeup({ title: "x".repeat(61) }))!, /the title is 61 characters/);
});

test("a rebase-only round's message is its title and one dated section", () => {
  const message = rebaseOnlyMessage(writeup({ title: "Resolve the rebase", how: "shared.txt: kept both sides." }), "fallback", {
    date: "2026-10-25",
    base: "master",
  });
  assert.equal(message.ok, true);
  assert.equal(message.title, "Resolve the rebase");
  assert.equal(message.body, "**2026-10-25 - rebased onto `origin/master`**\n\nshared.txt: kept both sides.");
  // No four-section template anywhere in it.
  assert.doesNotMatch(message.body, /## Context \(Why\)/);

  const invalid = rebaseOnlyMessage(writeup({ how: "" }), "fallback title", { date: "2026-10-25" });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.title, "fallback title");
  assert.match(invalid.body, /write-up invalid: the how field is empty/);
});

test("each rebase round appends its own entry under one \"Rebase rounds\" heading", () => {
  const body = "## Context (Why)\n\nThe product needs the thing.";
  const first = withRebaseRoundSection(body, rebaseRoundEntry("shared.txt: kept both sides.", { date: "2026-10-25" }));
  const second = withRebaseRoundSection(first, rebaseRoundEntry("other.txt: took origin's.", { date: "2026-10-27" }));

  assert.equal(second.match(new RegExp(REBASE_ROUNDS_HEADING, "g"))?.length, 1, "the heading repeated");
  assert.match(second, /## Context \(Why\)\n\nThe product needs the thing\./);
  assert.ok(second.indexOf("2026-10-25") < second.indexOf("2026-10-27"), "entries are not in order");
  assert.equal(
    second,
    `${body}\n\n${REBASE_ROUNDS_HEADING}\n\n**2026-10-25**\n\nshared.txt: kept both sides.\n\n**2026-10-27**\n\nother.txt: took origin's.`
  );
  // No line of an entry begins with "#": the same text is a rebase
  // round's commit message, and git strips such a line from a message it
  // considers edited - which `git rebase --continue` writes (see
  // rebaseRoundEntry).
  assert.doesNotMatch(rebaseRoundEntry("resolved", { date: "2026-10-25", base: "master" }), /^\s*#/m);
  assert.equal(appendRebaseRound({ title: "Add the thing", body }, "### x\n\ny").title, "Add the thing");
});

test("the prior pull request is rebuilt from the record: the last real round's body, plus every rebase round since", () => {
  const events = [
    event("delivered", { writeup: writeup({ why: "Because the product needs it." }) }, "2026-10-20T10:00:00.000Z"),
    event("verdict-recorded", { ruling: "fix", note: "master moved" }, "2026-10-21T10:00:00.000Z"),
    event(
      "delivered",
      { writeup: writeup({ title: "Rebase", how: "shared.txt: kept both sides." }) },
      "2026-10-22T09:30:00.000Z"
    ),
  ];
  const prior = pullRequestOnRecord(events)!;

  assert.equal(prior.title, "Add the thing", "the pull request was renamed by a rebase round");
  assert.match(prior.body, /## Context \(Why\)\n\nBecause the product needs it\./);
  assert.match(prior.body, /## Rebase rounds\n\n\*\*2026-10-22\*\*\n\nshared\.txt: kept both sides\./);

  // An ordinary fix round that followed replaces the base body again, and
  // the rebase history of the body it replaced goes with it.
  const afterRealWork = pullRequestOnRecord([
    ...events,
    event("verdict-recorded", { ruling: "fix", note: "tidy the error message" }, "2026-10-23T10:00:00.000Z"),
    event("delivered", { writeup: writeup({ title: "Add the thing, tidied" }) }, "2026-10-23T11:00:00.000Z"),
  ])!;
  assert.equal(afterRealWork.title, "Add the thing, tidied");
  assert.doesNotMatch(afterRealWork.body, /Rebase rounds/);

  // Nothing to append to: a task whose only delivery carried no write-up.
  assert.equal(pullRequestOnRecord([event("delivered", { outcome: "inspection-red" })]), undefined);
  assert.equal(pullRequestOnRecord([]), undefined);
});

test("the review page is shown what the pull request says, not a render of a rebase round's write-up", () => {
  const full = writeup({ why: "Because the product needs it." });
  const rebase = writeup({ title: "Rebase", how: "shared.txt: kept both sides." });
  const events = [
    event("delivered", { writeup: full }, "2026-10-20T10:00:00.000Z"),
    event("verdict-recorded", { ruling: "fix", note: "master moved" }, "2026-10-21T10:00:00.000Z"),
    event("delivered", { writeup: rebase }, "2026-10-22T09:30:00.000Z"),
  ];

  const shown = publishedPullRequestMessage(events, rebase, "fabrica: task-1");
  assert.equal(shown.ok, true);
  assert.equal(shown.title, "Add the thing");
  assert.match(shown.body, /## Context \(Why\)\n\nBecause the product needs it\./);
  assert.match(shown.body, /## Rebase rounds\n\n\*\*2026-10-22\*\*\n\nshared\.txt: kept both sides\./);

  // An ordinary round is rendered exactly as it always was.
  const ordinary = publishedPullRequestMessage([events[0]], full, "fabrica: task-1");
  assert.equal(ordinary.body, finalMessageFor(full, "fabrica: task-1").body);
  assert.doesNotMatch(ordinary.body, /Rebase rounds/);
  // And a rebase round whose write-up was unusable falls through to the
  // renderer that names the problem, rather than showing an old body as
  // though this round had published one.
  assert.equal(publishedPullRequestMessage(events, undefined, "fabrica: task-1").ok, false);
});

/** A green Inspector that keeps the pull request title and body of every
 * handoff - the one thing a rebase-only round changes about what the
 * publishing side receives. */
function prRecordingInspector(): Inspector & { readonly calls: { prTitle?: string; prBody?: string }[] } {
  const calls: { prTitle?: string; prBody?: string }[] = [];
  return {
    calls,
    installed: () => true,
    async inspect(request) {
      calls.push({ prTitle: request.prTitle, prBody: request.prBody });
      const green = fixtureCheckExit(request.workdir, "./check.sh") === 0;
      return { verdict: green ? "green" : "red", report: `fake Inspector: ${green ? "green" : "red"}` };
    },
  };
}

/** Moves origin's default branch on, through the project's own checkout. */
function advanceOrigin(project: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) writeFileSync(join(project, name), content);
  execFileSync("git", ["add", "-A"], { cwd: project, stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "origin moves on"], {
    cwd: project,
    stdio: ["ignore", "pipe", "pipe"],
  });
  pushToOrigin(project);
}

function commitMessage(project: string, taskId: string): string {
  return execFileSync("git", ["log", "-1", "--format=%B", `fabrica/${taskId}`], {
    cwd: project,
    encoding: "utf8",
  }).trim();
}

/** A worker resolving markers in place, with no git of its own. */
function resolveMarkers(workdir: string, files: string[], resolution: string): boolean {
  let resolved = false;
  for (const name of files) {
    const path = join(workdir, name);
    if (existsSync(path) && readFileSync(path, "utf8").includes("<<<<<<<")) {
      writeFileSync(path, resolution);
      resolved = true;
    }
  }
  return resolved;
}

test("a \"master moved\" round: a narrow brief, and the pull request body appended to rather than rewritten", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");
  writeFileSync(join(project, "tests.map"), "shared.txt: npm test -- shared\napp.txt: npm test -- app\n");
  const briefs: string[] = [];
  // fakeBrain reads its own options object on every call, so the fix
  // round's write-up can be a different one from the first round's - two
  // brains would be two warm workers, which a fix round is not.
  const brainOpts = {
    writeup: writeup({ title: "Add the thing", why: "Because the product needs it." }),
    onWork: (brief: string, workdir: string) => {
      briefs.push(brief);
      if (!resolveMarkers(workdir, ["shared.txt"], "both sides, reconciled\n")) {
        writeFileSync(join(workdir, "shared.txt"), "the task's version\n");
      }
    },
  };
  const brain = fakeBrain(brainOpts);
  const inspector = prRecordingInspector();
  const foreman = createForeman({ recordHome, inspector });
  const task = await foreman.do("small change", { project, brain });
  const firstBody = inspector.calls.at(-1)!.prBody!;
  assert.match(firstBody, /## Context \(Why\)\n\nBecause the product needs it\./);

  brainOpts.writeup = writeup({ title: "Resolve the rebase conflict", how: "shared.txt: kept both sides, reconciled." });
  advanceOrigin(project, { "shared.txt": "origin's version\n" });
  await foreman.verdict(task.id, "fix", "master moved - bring this up to it and resolve what conflicts");

  // The brief: this round's job, the conflicted file's mapped test, and
  // nothing about the whole suite or about files that did not conflict.
  const brief = briefs.at(-1)!;
  assert.match(brief, /This round is a rebase and nothing else/);
  assert.match(brief, /- npm test -- shared/);
  assert.doesNotMatch(brief, /npm test -- app/, "a test for a file that did not conflict was named");
  assert.doesNotMatch(brief, /run the project's whole suite the way its check runs it/);
  assert.match(brief, /the rebase stopped on a conflict/, "the conflict instructions are still handed over");

  // The pull request body: everything it already said, plus this round's
  // own dated entry under the fixed heading - and the same title.
  const handed = inspector.calls.at(-1)!;
  assert.equal(handed.prTitle, "Add the thing");
  assert.match(handed.prBody!, /## Context \(Why\)\n\nBecause the product needs it\./);
  assert.match(
    handed.prBody!,
    /## Rebase rounds\n\n\*\*\d{4}-\d{2}-\d{2} - rebased onto `origin\/master`\*\*\n\nshared\.txt: kept both sides, reconciled\./
  );
  assert.equal(latestDeliveredDetails(recordHome, task.id)?.outcome, "done");
  // Nothing about the conflict round reaches the branch as a commit of
  // its own: the host folds the worker's resolution into the commit the
  // rebase was replaying (src/line/rebase.ts), which keeps that commit's
  // own message. The one section is what the pull request gets.
  assert.match(commitMessage(project, task.id), /^Add the thing/);
});

test("a \"master moved\" round that did commit something commits the one section, not the template", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");
  const brainOpts = {
    writeup: writeup(),
    onWork: (_brief: string, workdir: string) => {
      // Round one writes the task's work; the rebase round adapts it to
      // what origin changed, so this round has a commit of its own.
      writeFileSync(join(workdir, "task.txt"), existsSync(join(workdir, "origin.txt")) ? "adapted\n" : "the work\n");
    },
  };
  const brain = fakeBrain(brainOpts);
  const inspector = prRecordingInspector();
  const foreman = createForeman({ recordHome, inspector });
  const task = await foreman.do("small change", { project, brain });

  brainOpts.writeup = writeup({ title: "Rebase onto master", how: "No conflicts; adapted task.txt to origin's rename." });
  advanceOrigin(project, { "origin.txt": "origin work\n" });
  await foreman.verdict(task.id, "fix", "master moved");

  const message = commitMessage(project, task.id);
  assert.match(message, /^Rebase onto master\n\n\*\*\d{4}-\d{2}-\d{2} - rebased onto `origin\/master`\*\*/);
  assert.match(message, /No conflicts; adapted task\.txt to origin's rename\./);
  assert.doesNotMatch(message, /## Context \(Why\)/, "the four-section template was committed for a rebase round");
  assert.doesNotMatch(message, /Confidence/);
});

test("a fix note that does not begin with \"master moved\" gets today's full round", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");
  writeFileSync(join(project, "tests.map"), "shared.txt: npm test -- shared\napp.txt: npm test -- app\n");
  const briefs: string[] = [];
  const brainOpts = {
    writeup: writeup(),
    onWork: (brief: string, workdir: string) => {
      briefs.push(brief);
      if (!resolveMarkers(workdir, ["shared.txt"], "both sides, reconciled\n")) {
        writeFileSync(join(workdir, "shared.txt"), "the task's version\n");
      }
    },
  };
  const brain = fakeBrain(brainOpts);
  const inspector = prRecordingInspector();
  const foreman = createForeman({ recordHome, inspector });
  const task = await foreman.do("small change", { project, brain });

  brainOpts.writeup = writeup({ title: "Tidy the message", why: "The wording was wrong." });
  advanceOrigin(project, { "shared.txt": "origin's version\n" });
  await foreman.verdict(task.id, "fix", "tidy the error message - master moved too, so expect a conflict");

  const brief = briefs.at(-1)!;
  assert.match(brief, /run the project's whole suite the way its check runs it/, "the ordinary test-map notice is gone");
  assert.doesNotMatch(brief, /This round is a rebase and nothing else/);

  // The write-up is rendered whole, and the pull request body is this
  // round's own - no rebase section anywhere.
  const handed = inspector.calls.at(-1)!;
  assert.equal(handed.prTitle, "Tidy the message");
  assert.match(handed.prBody!, /## Context \(Why\)\n\nThe wording was wrong\./);
  assert.doesNotMatch(handed.prBody!, /Rebase rounds/);
});

test("a rebase-only round whose worker changes nothing is still inspected, because the rebase rewrote the branch", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");
  const brainOpts = {
    writeup: writeup(),
    onWork: (_brief: string, workdir: string) => {
      if (!existsSync(join(workdir, "task.txt"))) writeFileSync(join(workdir, "task.txt"), "the task's work\n");
    },
  };
  const brain = fakeBrain(brainOpts);
  const inspector = prRecordingInspector();
  const foreman = createForeman({ recordHome, inspector });
  const task = await foreman.do("small change", { project, brain });
  const callsAfterFirstRound = inspector.calls.length;

  brainOpts.writeup = writeup({ title: "Rebase onto master", how: "Nothing conflicted; nothing to resolve." });
  advanceOrigin(project, { "elsewhere.txt": "origin work\n" });
  await foreman.verdict(task.id, "fix", "master moved");

  assert.equal(inspector.calls.length, callsAfterFirstRound + 1, "the rebased branch never reached Inspector");
  assert.equal(latestDeliveredDetails(recordHome, task.id)?.outcome, "done");
  assert.match(inspector.calls.at(-1)!.prBody!, /## Rebase rounds/);
});

test("an ordinary fix round whose worker changes nothing still delivers nothing-changed", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0");
  const brain = fakeBrain({
    onWork: (_brief, workdir) => {
      if (!existsSync(join(workdir, "task.txt"))) writeFileSync(join(workdir, "task.txt"), "the task's work\n");
    },
  });
  const inspector = prRecordingInspector();
  const foreman = createForeman({ recordHome, inspector });
  const task = await foreman.do("small change", { project, brain });
  const callsAfterFirstRound = inspector.calls.length;

  advanceOrigin(project, { "elsewhere.txt": "origin work\n" });
  await foreman.verdict(task.id, "fix", "one more tweak");

  assert.equal(inspector.calls.length, callsAfterFirstRound, "an unchanged branch was handed over again");
  assert.equal(latestDeliveredDetails(recordHome, task.id)?.outcome, "nothing-changed");
});
