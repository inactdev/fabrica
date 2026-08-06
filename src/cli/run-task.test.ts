import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { createForeman } from "../index.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { runTask } from "./run-task.ts";

test("runTask: runs a task to completion through createForeman, same as a direct do() call", async () => {
  const recordHome = mkdtempSync(join(tmpdir(), "fabrica-cli-run-task-"));
  const project = makeFixtureRepo("exit 0");
  const brain = fakeBrain();

  await runTask(recordHome, project, "make a small change", brain);

  assert.ok(brain.calls >= 1);
  // There is exactly one task in this fresh recordHome - find it and
  // confirm a real delivery landed on the record.
  const [taskId] = readdirSync(join(recordHome, "tasks"));
  const delivery = await createForeman({ recordHome }).deliveryOf(taskId);
  assert.ok(delivery);
  assert.equal(delivery?.outcome, "done");
});
