// The worker's write-up is structured data (BrainWorkResult.writeup),
// never parsed from its prose. Client ruling 2026-10-13: every attempt is
// committed once work() returns; a valid write-up is that commit's
// message and the pull request's title and body; a missing or invalid
// one still commits (with a fallback message naming what is wrong), is
// red on that alone, and is never handed to Inspector. A retry that only
// supplies the write-up amends that unpublished commit. A round that ends
// on an invalid write-up delivers as a failure report, never as an
// Inspector red.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "./foreman.ts";
import type { Brain, BrainWorkResult } from "../brain/index.ts";
import type { Inspector } from "../inspector/index.ts";
import type { WorkerWriteup } from "../../contract/surface.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { fixtureCheckBox } from "../../contract/helpers/fake-check-box.ts";

const WRITEUP: WorkerWriteup = {
  title: "Add the retry on login timeout",
  what: "Retries login once on a timeout.",
  why: "Users saw spurious failures.",
  how: "Wrapped the call in one retry.",
  deviations: "None.",
};

const WRITEUP_MESSAGE =
  "Add the retry on login timeout\n\n" +
  "What:\nRetries login once on a timeout.\n\n" +
  "Why:\nUsers saw spurious failures.\n\n" +
  "How:\nWrapped the call in one retry.\n\n" +
  "Deviations:\nNone.";

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-writeup-home-"));
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

function greenInspector(): Inspector & { calls: { branch: string; prTitle?: string; prBody?: string }[] } {
  const calls: { branch: string; prTitle?: string; prBody?: string }[] = [];
  return {
    calls,
    async inspect(request) {
      calls.push({ branch: request.branch, prTitle: request.prTitle, prBody: request.prBody });
      return { verdict: "green", report: "ok", prUrl: `https://example.test/pulls/${calls.length}` };
    },
  };
}

/** One scripted attempt per call: which files to write, and what write-up to return. */
function scriptedBrain(attempts: { files: string[]; writeup?: WorkerWriteup }[]): Brain & { readonly calls: number } {
  let calls = 0;
  return {
    name: "fake",
    model: "fake-1",
    get calls() {
      return calls;
    },
    async ask() {
      return {};
    },
    async work(_brief, workdir) {
      const step = attempts[Math.min(calls++, attempts.length - 1)];
      for (const file of step.files) writeFileSync(join(workdir, file), `${file}\n`);
      const result: BrainWorkResult = { transcript: [], session: "s1" };
      if (step.writeup) result.writeup = step.writeup;
      return result;
    },
  };
}

function commitsOn(project: string, base: string, branch: string): string[] {
  return execSync(`git log --format=%B%x00 ${base}..${branch}`, { cwd: project, encoding: "utf8" })
    .split("\0")
    .map((m) => m.trim())
    .filter(Boolean);
}

function headOf(project: string): string {
  return execSync("git rev-parse HEAD", { cwd: project, encoding: "utf8" }).trim();
}

test("a write-up becomes the one commit's exact message, and Inspector is called once with it", async () => {
  const recordHome = freshHome();
  const project = inspectedProject();
  const base = headOf(project);
  const inspector = greenInspector();
  const foreman = createForeman({ recordHome, inspector });

  const task = await foreman.do("small change", {
    project,
    brain: scriptedBrain([{ files: ["feature.txt"], writeup: WRITEUP }]),
  });

  const delivery = await foreman.deliveryOf(task.id);
  assert.equal(delivery?.outcome, "done");
  assert.deepEqual(commitsOn(project, base, delivery!.branch), [WRITEUP_MESSAGE]);
  assert.equal(inspector.calls.length, 1);
  assert.equal(inspector.calls[0].prTitle, WRITEUP.title);
  assert.equal(inspector.calls[0].prBody, WRITEUP_MESSAGE.slice(WRITEUP.title.length + 2));
});

test("no write-up: the work is still committed, the attempt is red naming why, and Inspector is never called", async () => {
  const recordHome = freshHome();
  const project = inspectedProject();
  const base = headOf(project);
  const inspector = greenInspector();
  const foreman = createForeman({ recordHome, inspector });

  const task = await foreman.do("small change", {
    project,
    brain: scriptedBrain([{ files: ["feature.txt"] }]),
    attempts: 1,
  });

  assert.equal(inspector.calls.length, 0, "an attempt with no write-up was handed to Inspector");
  assert.equal(task.state, "failed");
  const delivery = await foreman.deliveryOf(task.id);
  assert.equal(delivery?.outcome, "failure-report", "a write-up failure must never deliver as an Inspector red");
  assert.equal(delivery?.summary, "write-up invalid: the worker returned no write-up");
  assert.deepEqual(delivery?.files, ["feature.txt"]);
  const commits = commitsOn(project, base, delivery!.branch);
  assert.equal(commits.length, 1, "the attempt's work was not committed");
  assert.match(commits[0], /write-up invalid: the worker returned no write-up/);

  const receipts = (await foreman.events(task.id)).filter((e) => e.name === "receipt-recorded");
  const checks = (receipts[0].details as { receipt: { checks: { green: boolean; output: string } } }).receipt.checks;
  assert.equal(checks.green, false);
  assert.match(checks.output, /write-up invalid: the worker returned no write-up/);
});

for (const [label, writeup, reason] of [
  ["a title over 60 characters", { ...WRITEUP, title: "x".repeat(61) }, /the title is 61 characters \(at most 60\)/],
  ["an empty deviations field", { ...WRITEUP, deviations: "  " }, /the deviations field is empty/],
] as const) {
  test(`a write-up with ${label} is invalid, named, and never handed to Inspector`, async () => {
    const recordHome = freshHome();
    const inspector = greenInspector();
    const foreman = createForeman({ recordHome, inspector });

    const task = await foreman.do("small change", {
      project: inspectedProject(),
      brain: scriptedBrain([{ files: ["feature.txt"], writeup }]),
      attempts: 1,
    });

    assert.equal(inspector.calls.length, 0);
    const delivery = await foreman.deliveryOf(task.id);
    assert.equal(delivery?.outcome, "failure-report");
    assert.match(delivery!.summary, /^write-up invalid: /);
    assert.match(delivery!.summary, reason);
  });
}

test("a retry that only supplies the write-up amends the unpublished commit: one commit, one Inspector call, one pull request", async () => {
  const recordHome = freshHome();
  const project = inspectedProject();
  const base = headOf(project);
  const inspector = greenInspector();
  const foreman = createForeman({ recordHome, inspector });
  const brain = scriptedBrain([{ files: ["feature.txt"] }, { files: [], writeup: WRITEUP }]);

  const task = await foreman.do("small change", { project, brain, attempts: 2 });

  assert.equal(brain.calls, 2);
  const delivery = await foreman.deliveryOf(task.id);
  assert.equal(delivery?.outcome, "done");
  assert.deepEqual(commitsOn(project, base, delivery!.branch), [WRITEUP_MESSAGE], "expected the one commit, amended");
  assert.deepEqual(delivery?.files, ["feature.txt"]);
  assert.equal(inspector.calls.length, 1);
  const prs = (await foreman.events(task.id)).filter((e) => e.name === "pr-opened");
  assert.equal(prs.length, 1);
});

test("a retry with new changes and a write-up folds into the unpublished commit, never leaving a fallback message on the branch", async () => {
  const recordHome = freshHome();
  const project = inspectedProject();
  const base = headOf(project);
  const inspector = greenInspector();
  const foreman = createForeman({ recordHome, inspector });
  const brain = scriptedBrain([{ files: ["one.txt"] }, { files: ["two.txt"], writeup: WRITEUP }]);

  const task = await foreman.do("small change", { project, brain, attempts: 2 });

  const delivery = await foreman.deliveryOf(task.id);
  assert.deepEqual(commitsOn(project, base, delivery!.branch), [WRITEUP_MESSAGE]);
  assert.deepEqual(delivery?.files, ["one.txt", "two.txt"]);
  assert.equal(inspector.calls.length, 1);
});

test("self-tested, no write-up: committed, delivered as a write-up failure report, the check never run", async () => {
  const recordHome = freshHome();
  const project = makeFixtureRepo("exit 0", { inspector: false });
  const base = headOf(project);
  const box = fixtureCheckBox();
  const foreman = createForeman({ recordHome, checkBox: box.box });

  const task = await foreman.do("small change", {
    project,
    brain: scriptedBrain([{ files: ["feature.txt"] }]),
    attempts: 1,
  });

  assert.equal(box.calls.length, 0, "the check ran for an attempt with no write-up");
  const delivery = await foreman.deliveryOf(task.id);
  assert.equal(delivery?.outcome, "failure-report");
  assert.equal(delivery?.summary, "write-up invalid: the worker returned no write-up");
  assert.equal(commitsOn(project, base, delivery!.branch).length, 1);
});
