// Every place Fabrica branches on "is Inspector here?", tested both ways
// (Client rule, PR #108 review). "Here" is only ever what the configured
// Inspector adapter's installed() says - a fake reporting installed, or a
// fake reporting not installed - never whether a real `inspector` happens
// to be on this machine's PATH. Each pair asserts what that mode promises:
//   installed      -> Inspector judges; Fabrica runs no check of its own.
//   not installed  -> the check runs in the worker's box; no refusal, and
//                     the delivery says it was not independently checked.
// The one source of the answer is src/foreman/judge.ts's chooseCheckMode,
// reached from the first round, the answer/resume round, and the fix round;
// delivery text, `fabrica log` and `fabrica status` render its result.
// Two more branches hang off the same answer: whether a missing check.sh
// refuses the task (only the self-test needs one), and rule 9's check.sh
// comparison.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "./foreman.ts";
import { ForemanError } from "./errors.ts";
import { SELF_TESTED } from "./judge.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { fakeInspector } from "../../contract/helpers/fake-inspector.ts";
import { fakeCheckBox } from "../../contract/helpers/fake-check-box.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { runLogCommand } from "../cli/log-command.ts";
import { runStatusCommand } from "../cli/status-command.ts";

function setup(installed: boolean, verdict: "green" | "red" = "green", boxExit = 0) {
  const recordHome = mkdtempSync(join(tmpdir(), "fabrica-presence-home-"));
  const inspector = fakeInspector(verdict, undefined, { installed });
  const box = fakeCheckBox({ ran: true, exitCode: boxExit, output: `fake box: exit ${boxExit}` });
  const foreman = createForeman({ recordHome, inspector, checkBox: box.box });
  return { recordHome, inspector, box, foreman, project: makeFixtureRepo("exit 0") };
}

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) };
}

// --- 1. First round ---

test("first round, Inspector installed: Inspector judges it and the worker's box never runs", async () => {
  const { foreman, inspector, box, project } = setup(true);
  const task = await foreman.do("small change", { project, brain: fakeBrain() });
  assert.equal(inspector.calls.length, 1);
  assert.equal(box.calls.length, 0);
  assert.equal((await foreman.deliveryOf(task.id))?.outcome, "done");
});

test("first round, Inspector not installed: no refusal - the worker's box judges it and Inspector is never called", async () => {
  const { foreman, inspector, box, project } = setup(false);
  const task = await foreman.do("small change", { project, brain: fakeBrain() });
  assert.equal(inspector.calls.length, 0);
  assert.equal(box.calls.length, 1);
  assert.equal((await foreman.deliveryOf(task.id))?.outcome, "done");
});

// --- 2. Answer / resume round ---

async function askedTask(installed: boolean) {
  const ctx = setup(installed);
  const asked = await ctx.foreman.do("build me an app", {
    project: ctx.project,
    brain: fakeBrain({ askQuestions: ["Which database?"] }),
  });
  assert.equal(asked.state, "asking");
  return { ...ctx, taskId: asked.id };
}

test("answer round, Inspector installed: the resumed round is judged by Inspector", async () => {
  const { foreman, inspector, box, taskId } = await askedTask(true);
  await foreman.answer(taskId, "Use Postgres.");
  assert.equal(inspector.calls.length, 1);
  assert.equal(box.calls.length, 0);
  assert.equal((await foreman.deliveryOf(taskId))?.outcome, "done");
});

test("answer round, Inspector not installed: the resumed round is self-tested in the worker's box", async () => {
  const { foreman, inspector, box, taskId } = await askedTask(false);
  await foreman.answer(taskId, "Use Postgres.");
  assert.equal(inspector.calls.length, 0);
  assert.equal(box.calls.length, 1);
  assert.equal((await foreman.deliveryOf(taskId))?.outcome, "done");
});

// --- 3. Fix round ---

test("fix round, Inspector installed: the fix is judged by Inspector on the same branch", async () => {
  const { foreman, inspector, box, project } = setup(true);
  const task = await foreman.do("small change", { project, brain: fakeBrain() });
  await foreman.verdict(task.id, "fix", "one more thing");
  assert.equal(inspector.calls.length, 2);
  assert.equal(inspector.calls[1].branch, `fabrica/${task.id}`);
  assert.equal(box.calls.length, 0);
});

test("fix round, Inspector not installed: the fix is self-tested in the worker's box, never refused", async () => {
  const { foreman, inspector, box, project } = setup(false);
  const task = await foreman.do("small change", { project, brain: fakeBrain() });
  await foreman.verdict(task.id, "fix", "one more thing");
  assert.equal(inspector.calls.length, 0);
  assert.equal(box.calls.length, 2);
  assert.equal((await foreman.deliveryOf(task.id))?.outcome, "done");
});

// --- 4. Delivery text ---

test("delivery text, Inspector installed: says the check was delegated to Inspector, never self-tested", async () => {
  const { foreman, project } = setup(true);
  const task = await foreman.do("small change", { project, brain: fakeBrain() });
  const delivery = await foreman.deliveryOf(task.id);
  assert.match(delivery?.evidence ?? "", /check: delegated to Inspector/);
  assert.ok(!`${delivery?.evidence}${delivery?.gaps}`.includes(SELF_TESTED));
});

test("delivery text, Inspector not installed: says self-tested and not independently checked, and offers the push", async () => {
  const { foreman, project } = setup(false);
  const task = await foreman.do("small change", { project, brain: fakeBrain() });
  const delivery = await foreman.deliveryOf(task.id);
  assert.ok(`${delivery?.evidence}\n${delivery?.gaps}`.includes(SELF_TESTED));
  assert.match(delivery?.gaps ?? "", new RegExp(`git push origin fabrica/${task.id}`));
  assert.doesNotMatch(delivery?.evidence ?? "", /delegated to Inspector/);
});

// --- 5. `fabrica log` rendering ---

test("fabrica log, Inspector installed: shows Inspector's call and verdict, and no Fabrica check run", async () => {
  const { recordHome, foreman, project } = setup(true);
  const task = await foreman.do("small change", { project, brain: fakeBrain() });
  const io = captureIo();
  assert.equal(await runLogCommand([task.id], { recordHome, ...io }), 0);
  assert.ok(io.out.some((l) => l.includes(`Inspector called for fabrica/${task.id}`)));
  assert.ok(io.out.some((l) => l.includes("Inspector green")));
  assert.ok(!io.out.some((l) => l.includes("check started")));
});

test("fabrica log, Inspector not installed: says why Inspector was skipped and that the box ran the check", async () => {
  const { recordHome, foreman, project } = setup(false);
  const task = await foreman.do("small change", { project, brain: fakeBrain() });
  const io = captureIo();
  assert.equal(await runLogCommand([task.id], { recordHome, ...io }), 0);
  assert.ok(io.out.some((l) => l.includes("Inspector skipped: Inspector is not installed")));
  assert.ok(io.out.some((l) => l.includes("check started in the worker's box")));
  assert.ok(!io.out.some((l) => l.includes("Inspector called")));
});

// --- 6. `fabrica status` rendering ---
// The mode changes what a red result is: Inspector red is a delivery for
// the Client's verdict; a red self-test is a failure report.

test("fabrica status, Inspector installed: a red result awaits the Client's verdict", async () => {
  const { recordHome, foreman, project } = setup(true, "red");
  const task = await foreman.do("small change", { project, brain: fakeBrain() });
  const io = captureIo();
  assert.equal(await runStatusCommand([], { recordHome, ...io }), 0);
  const line = io.out.find((l) => l.startsWith(task.id)) ?? "";
  assert.equal((await foreman.deliveryOf(task.id))?.outcome, "inspection-red");
  assert.match(line, /delivered/);
  assert.match(line, /AWAITING YOUR VERDICT/);
});

test("fabrica status, Inspector not installed: a red self-test shows failed, with no verdict flag", async () => {
  const { recordHome, foreman, project } = setup(false, "green", 1);
  const task = await foreman.do("small change", { project, brain: fakeBrain() });
  const io = captureIo();
  assert.equal(await runStatusCommand([], { recordHome, ...io }), 0);
  const line = io.out.find((l) => l.startsWith(task.id)) ?? "";
  assert.equal((await foreman.deliveryOf(task.id))?.outcome, "failure-report");
  assert.match(line, /failed/);
  assert.doesNotMatch(line, /AWAITING YOUR VERDICT/);
});

// --- 7. A project with no check.sh ---

function projectWithoutCheckSh(): string {
  const project = makeFixtureRepo("exit 0");
  rmSync(join(project, "check.sh"));
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "no check.sh"], { cwd: project });
  return project;
}

test("no check.sh, Inspector installed: the task runs - Inspector has its own check, Fabrica needs none", async () => {
  const { foreman, inspector } = setup(true);
  const brain = fakeBrain();
  const task = await foreman.do("small change", { project: projectWithoutCheckSh(), brain });
  assert.equal(brain.calls, 1);
  assert.equal(inspector.calls.length, 1);
  assert.equal((await foreman.deliveryOf(task.id))?.outcome, "done");
});

test("no check.sh, Inspector not installed: refused before any worker runs - there is nothing to self-test with", async () => {
  const { foreman, inspector, box } = setup(false);
  const brain = fakeBrain();
  await assert.rejects(
    () => foreman.do("small change", { project: projectWithoutCheckSh(), brain }),
    (err: unknown) => err instanceof ForemanError && err.code === "missing-check"
  );
  assert.equal(brain.calls, 0);
  assert.equal(inspector.calls.length, 0);
  assert.equal(box.calls.length, 0);
});

// --- 8. Rule 9's check.sh comparison ---

const undeclaredCheckEdit = () =>
  fakeBrain({ onWork: (_brief, workdir) => writeFileSync(join(workdir, "check.sh"), "#!/bin/sh\nexit 0 # tampered\n") });

test("rule 9, Inspector installed: an undeclared check.sh edit is still recorded as discarded-protected-path", async () => {
  const { foreman, project } = setup(true);
  const task = await foreman.do("small change", { project, brain: undeclaredCheckEdit() });
  assert.equal((await foreman.deliveryOf(task.id))?.outcome, "discarded-protected-path");
});

test("rule 9, Inspector not installed: an undeclared check.sh edit is still recorded as discarded-protected-path", async () => {
  const { foreman, project } = setup(false);
  const task = await foreman.do("small change", { project, brain: undeclaredCheckEdit() });
  assert.equal((await foreman.deliveryOf(task.id))?.outcome, "discarded-protected-path");
});
