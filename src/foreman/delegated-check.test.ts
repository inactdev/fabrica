// Issue #64's two modes (Client ruling 2026-10-08, built here):
//   a. Inspector installed and .inspector.json at the task's base commit:
//      Fabrica runs no check. Each attempt commits and goes to Inspector;
//      red feeds the next attempt's brief, green stops early, a last red
//      is an inspection-red delivery for the Client.
//   b. Otherwise: the check runs once per attempt inside the worker's own
//      box, never on the host, and the delivery says it was not
//      independently checked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "./foreman.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { fakeInspector } from "../../contract/helpers/fake-inspector.ts";
import { fakeCheckBox } from "../../contract/helpers/fake-check-box.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { inspectorAdapter } from "../inspector/index.ts";
import { readEventsForTask, readTaskFile } from "../record/index.ts";

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-delegated-home-"));
}

/** A check that leaves a mark on the host if anything ever runs it there. */
function markingCheck(): { check: string; marker: string } {
  const marker = join(mkdtempSync(join(tmpdir(), "fabrica-host-marker-")), "check-ran-on-host");
  return { check: `touch "${marker}"\nexit 0`, marker };
}

test("Inspector mode: Fabrica never runs the project's check on the host", async () => {
  const { check, marker } = markingCheck();
  const foreman = createForeman({ recordHome: freshHome(), inspector: fakeInspector("green") });

  const task = await foreman.do("small change", { project: makeFixtureRepo(check), brain: fakeBrain() });

  assert.equal(task.state, "delivered");
  assert.equal(existsSync(marker), false, "the project's check ran on the host");
});

test("self-test mode: the check runs once in the worker's box and never on the host", async () => {
  const { check, marker } = markingCheck();
  const box = fakeCheckBox();
  const foreman = createForeman({ recordHome: freshHome(), checkBox: box.box });

  const task = await foreman.do("small change", {
    project: makeFixtureRepo(check, { inspector: false }),
    brain: fakeBrain(),
  });

  assert.equal(task.state, "delivered");
  assert.equal(existsSync(marker), false, "the project's check ran on the host");
  assert.equal(box.calls.length, 1);
  assert.equal(box.calls[0].command, "./check.sh");
});

test("Inspector mode: every attempt goes to Inspector on fabrica/<taskId>, and red feeds the next brief", async () => {
  const inspector = fakeInspector(["red", "green"], (verdict, call) =>
    verdict === "red" ? `lint fails in app.ts (call ${call})` : "all green"
  );
  const brain = fakeBrain();
  const foreman = createForeman({ recordHome: freshHome(), inspector });

  const task = await foreman.do("small change", { project: makeFixtureRepo("exit 0"), brain });

  assert.equal(brain.calls, 2, "the counted budget (2 by default) was not used for Inspector's red");
  assert.deepEqual(
    inspector.calls.map((c) => c.branch),
    [`fabrica/${task.id}`, `fabrica/${task.id}`]
  );
  const briefs = [...brain.historyBySession.values()].flat();
  assert.match(briefs[1], /lint fails in app\.ts \(call 1\)/, "Inspector's report did not reach the next attempt's brief");
  assert.equal((await foreman.deliveryOf(task.id))?.outcome, "done");
});

test("Inspector mode: green on the first attempt stops early, as today", async () => {
  const brain = fakeBrain();
  const foreman = createForeman({ recordHome: freshHome(), inspector: fakeInspector("green") });

  await foreman.do("small change", { project: makeFixtureRepo("exit 0"), brain });

  assert.equal(brain.calls, 1);
});

test("Inspector mode: a last-attempt red is an inspection-red delivery for the Client's verdict", async () => {
  const foreman = createForeman({ recordHome: freshHome(), inspector: fakeInspector("red") });

  const task = await foreman.do("small change", { project: makeFixtureRepo("exit 0"), brain: fakeBrain() });

  assert.equal(task.state, "delivered");
  assert.equal((await foreman.deliveryOf(task.id))?.outcome, "inspection-red");
});

test("Inspector mode: the record and delivery say the check was delegated, and no Fabrica check-run is recorded", async () => {
  const recordHome = freshHome();
  const foreman = createForeman({ recordHome, inspector: fakeInspector("green") });

  const task = await foreman.do("small change", { project: makeFixtureRepo("exit 0"), brain: fakeBrain() });

  for (const receipt of await foreman.receiptsOf(task.id)) {
    assert.match(receipt.checks?.output ?? "", /^check: delegated to Inspector/);
  }
  assert.ok(!readEventsForTask(recordHome, task.id).some((e) => e.name === "check-run"), "a Fabrica check run was recorded");
  assert.match((await foreman.deliveryOf(task.id))?.evidence ?? "", /check: delegated to Inspector/);
});

test("Inspector mode: a fix verdict goes back through Inspector on the same branch", async () => {
  const inspector = fakeInspector(["red", "red", "green"]);
  const foreman = createForeman({ recordHome: freshHome(), inspector });
  const task = await foreman.do("small change", { project: makeFixtureRepo("exit 0"), brain: fakeBrain() });
  assert.equal((await foreman.deliveryOf(task.id))?.outcome, "inspection-red");

  await foreman.verdict(task.id, "fix", "make the linter happy");

  assert.equal(inspector.calls.length, 3);
  assert.equal(inspector.calls[2].branch, `fabrica/${task.id}`);
  assert.equal((await foreman.deliveryOf(task.id))?.outcome, "done");
});

test("Inspector not installed: no refusal - the task self-tests in the worker's box", async () => {
  const box = fakeCheckBox();
  const foreman = createForeman({
    recordHome: freshHome(),
    inspector: inspectorAdapter(join(tmpdir(), "no-such-inspector-binary")),
    checkBox: box.box,
  });

  const task = await foreman.do("small change", { project: makeFixtureRepo("exit 0"), brain: fakeBrain() });

  assert.equal(task.state, "delivered");
  assert.equal(box.calls.length, 1);
  assert.equal((await foreman.deliveryOf(task.id))?.outcome, "done");
});

test("self-test mode: the delivery says it was not independently checked and offers the push as the Client's choice", async () => {
  const recordHome = freshHome();
  const foreman = createForeman({ recordHome, checkBox: fakeCheckBox().box });

  const task = await foreman.do("small change", {
    project: makeFixtureRepo("exit 0", { inspector: false }),
    brain: fakeBrain(),
  });

  const delivery = await foreman.deliveryOf(task.id);
  assert.equal(delivery?.outcome, "done");
  const text = `${delivery?.evidence}\n${delivery?.gaps}`;
  assert.match(text, /self-tested in the worker's box; no Inspector; not independently checked/);
  assert.match(text, new RegExp(`git push origin fabrica/${task.id}`));
  assert.match(readTaskFile(recordHome, task.id, "delivery.md") ?? "", /not independently checked/);
});

test("self-test mode: a box that cannot run the check is a not-verified report, never a fake red", async () => {
  for (const result of [
    { ran: true as const, exitCode: 127, output: "sh: npm: not found" },
    { ran: false as const, reason: "Docker is not running" },
  ]) {
    const foreman = createForeman({ recordHome: freshHome(), checkBox: fakeCheckBox(result).box });

    const task = await foreman.do("small change", {
      project: makeFixtureRepo("exit 0", { inspector: false }),
      brain: fakeBrain(),
    });

    const delivery = await foreman.deliveryOf(task.id);
    assert.equal(delivery?.outcome, "not-verified", `got ${delivery?.outcome} for ${JSON.stringify(result)}`);
    assert.notEqual(delivery?.outcome, "failure-report");
    assert.match(delivery?.summary ?? "", /could not run the check/);
    assert.match(`${delivery?.summary} ${delivery?.evidence}`, result.ran ? /npm: not found/ : /Docker is not running/);
  }
});
