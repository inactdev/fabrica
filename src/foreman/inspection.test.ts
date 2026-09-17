import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "./foreman.ts";
import { ForemanError } from "./errors.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import type { Inspection, Inspector } from "../inspector/index.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { runAnswerCommand } from "../cli/answer-command.ts";
import { runLogCommand } from "../cli/log-command.ts";
import { runVerdictCommand } from "../cli/verdict-command.ts";
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

function fakeInspector(...results: Inspection[]): Inspector & { calls: { branch: string; workdir: string }[] } {
  const calls: { branch: string; workdir: string }[] = [];
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

test("an Inspector red report reaches the Client and a fix returns to the same warm worker and branch", async () => {
  const recordHome = freshHome();
  const inspector = fakeInspector(
    { verdict: "red", report: "lint still fails in app.ts" },
    { verdict: "green", report: "lint repaired" }
  );
  const brain = fakeBrain();
  const foreman = createForeman({ recordHome, inspector });

  const task = await foreman.do("small change", { project: inspectedProject(), brain });
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

  const task = await foreman.do("small change", { project: inspectedProject(), brain });
  assert.equal((await foreman.deliveryOf(task.id))?.outcome, "inspection-red");

  const io = captureIo();
  const code = await runVerdictCommand([task.id, "fix", "-m", "apply the requested fix"], {
    recordHome,
    brain,
    ...io,
  });

  assert.equal(code, 0);
  assert.deepEqual(io.err, []);
  assert.deepEqual(io.out, [
    `fix round 1 recorded: ${task.id} ran again with your note - Inspector refused before reaching a verdict. ` +
      `Read \`fabrica log ${task.id}\` for the reason; no Client verdict is available.`,
  ]);
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
  const io = captureIo();

  const code = await runAnswerCommand([task.id, "-m", "Use Postgres."], {
    recordHome,
    brain: fakeBrain(),
    inspector,
    ...io,
  });

  assert.equal(code, 0);
  assert.deepEqual(io.err, []);
  assert.deepEqual(io.out, [
    `${task.id} resumed with your answer - Inspector refused before reaching a verdict. ` +
      `Read \`fabrica log ${task.id}\` for the reason; no Client verdict is available.`,
  ]);
  assert.equal(await foreman.deliveryOf(task.id), null);
  const second = captureIo();
  assert.equal(
    await runAnswerCommand([task.id, "-m", "Use SQLite instead."], {
      recordHome,
      brain: fakeBrain(),
      inspector,
      ...second,
    }),
    1
  );
  assert.match(second.err[0], /already got its one clarification round/);
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

test("a project without Inspector config keeps Fabrica's existing delivery path", async () => {
  const recordHome = freshHome();
  const inspector = fakeInspector({ verdict: "green", report: "should not be called" });
  const foreman = createForeman({ recordHome, inspector });

  const task = await foreman.do("small change", { project: makeFixtureRepo("exit 0"), brain: fakeBrain() });

  assert.equal(task.state, "delivered");
  const delivery = await foreman.deliveryOf(task.id);
  assert.equal(delivery?.outcome, "done");
  assert.equal(delivery?.inspection, undefined);
  assert.equal(inspector.calls.length, 0);
  assert.ok((await foreman.events(task.id)).some((event) => event.name === "inspection-skipped"));
});
