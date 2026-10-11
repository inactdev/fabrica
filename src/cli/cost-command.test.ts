// `fabrica cost <taskId> <usd>` (issue #11, Client ruling 2026-10-08):
// the one way out of a SPEND UNKNOWN block - the owner looks the real
// figure up and records it by hand.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "../index.ts";
import { readEventsForTask } from "../record/index.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { fixtureInspector } from "../../contract/helpers/fake-inspector.ts";
import { main } from "./main.ts";
import { runCostCommand } from "./cost-command.ts";
import { runDoCommand } from "./do-command.ts";
import { runStatusCommand } from "./status-command.ts";

const FAKE_ENTRY = fileURLToPath(new URL("./helpers/fake-run-task-entry.ts", import.meta.url));
const FAST_ASK_WAIT = { askPollMs: 20 };

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) };
}

async function blockedHome(): Promise<{ recordHome: string; project: string; unmeasuredId: string }> {
  const recordHome = mkdtempSync(join(tmpdir(), "fabrica-cli-cost-"));
  writeFileSync(join(recordHome, "projects.toml"), "[caps]\nperDayUsd = 100\n");
  const project = makeFixtureRepo("exit 0");
  const task = await createForeman({ recordHome, caps: { perDayUsd: 100 }, inspector: fixtureInspector() }).do("unmeasured", {
    project,
    brain: fakeBrain({ costUsd: null }),
  });
  return { recordHome, project, unmeasuredId: task.id };
}

test("fabrica cost: recording the cost by hand clears SPEND UNKNOWN and the next task starts", async () => {
  const { recordHome, project, unmeasuredId } = await blockedHome();

  const before = captureIo();
  await runStatusCommand([], { recordHome, ...before });
  assert.ok(before.out.includes("SPEND UNKNOWN - tasks blocked"), "the block was never shown in the first place");

  const io = captureIo();
  const code = await runCostCommand([unmeasuredId, "0.42"], { recordHome, ...io });
  assert.equal(code, 0, io.err.join("\n"));
  const recorded = readEventsForTask(recordHome, unmeasuredId).find((e) => e.name === "cost-recorded");
  assert.deepEqual(recorded?.details, { usd: 0.42, attempts: [1] });

  const after = captureIo();
  await runStatusCommand([], { recordHome, ...after });
  assert.ok(!after.out.includes("SPEND UNKNOWN - tasks blocked"), "the block outlived the recorded cost");

  const doIo = captureIo();
  const doCode = await runDoCommand(["now it may start", "--project", project], {
    recordHome,
    entryScript: FAKE_ENTRY,
    ...FAST_ASK_WAIT,
    ...doIo,
  });
  assert.equal(doCode, 0, doIo.err.join("\n"));
  assert.ok(readEventsForTask(recordHome, doIo.out[0]).some((e) => e.name === "work-started"), "the task never started");
});

test("fabrica cost: refuses without a real figure, and the block stays", async () => {
  const { recordHome, unmeasuredId } = await blockedHome();

  for (const argv of [[unmeasuredId], [unmeasuredId, "abc"], [unmeasuredId, "-1"], [unmeasuredId, "NaN"], []]) {
    const io = captureIo();
    const code = await runCostCommand(argv, { recordHome, ...io });
    assert.equal(code, 1, `"fabrica cost ${argv.join(" ")}" was accepted`);
    assert.ok(io.err.length > 0);
  }
  assert.ok(!readEventsForTask(recordHome, unmeasuredId).some((e) => e.name === "cost-recorded"));

  const status = captureIo();
  await runStatusCommand([], { recordHome, ...status });
  assert.ok(status.out.includes("SPEND UNKNOWN - tasks blocked"));
});

test("fabrica cost: an unknown task id is refused plainly", async () => {
  const { recordHome } = await blockedHome();
  const io = captureIo();
  assert.equal(await runCostCommand(["no-such-task", "1"], { recordHome, ...io }), 1);
  assert.match(io.err.join("\n"), /no-such-task/);
});

test("fabrica cost is dispatched by main", async () => {
  const io = captureIo();
  assert.equal(await main(["cost", "--help"], io), 0);
  assert.match(io.out.join("\n"), /fabrica cost <taskId> <usd>/);
});
