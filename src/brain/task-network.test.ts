// The side channel a task's network policy reaches an adapter through
// (issue #186). What matters is not that a value round-trips, but the
// two properties that made an AsyncLocalStorage the right mechanism
// rather than a module-level registry: it cannot leak past the call it
// wraps, and two tasks running concurrently in one process never see
// each other's policy.

import { test } from "node:test";
import assert from "node:assert/strict";
import { currentTaskNetwork, withTaskNetwork } from "./task-network.ts";
import type { TaskNetworkPolicy } from "./task-network.ts";

const policy = (taskId: string, hosts: string[] = []): TaskNetworkPolicy => ({
  recordHome: `/tmp/record-${taskId}`,
  taskId,
  hosts,
});

test("an adapter called with no policy around it sees none", () => {
  assert.equal(currentTaskNetwork(), undefined);
});

test("the policy is visible to everything the wrapped call awaits, however deep", async () => {
  const seen = await withTaskNetwork(policy("t1", ["registry.npmjs.org"]), async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    return (async () => currentTaskNetwork())();
  });

  assert.equal(seen?.taskId, "t1");
  assert.deepEqual(seen?.hosts, ["registry.npmjs.org"]);
});

test("the scope ends with the call - nothing has to remember to unregister it", async () => {
  await withTaskNetwork(policy("t1"), async () => {
    assert.equal(currentTaskNetwork()?.taskId, "t1");
  });
  assert.equal(currentTaskNetwork(), undefined);

  await assert.rejects(
    withTaskNetwork(policy("t2"), async () => {
      throw new Error("the worker died");
    })
  );
  assert.equal(currentTaskNetwork(), undefined, "a call that threw must not leave its policy behind");
});

test("two tasks in one process never see each other's policy", async () => {
  const observe = async (taskId: string, delayMs: number) =>
    withTaskNetwork(policy(taskId, [`${taskId}.example`]), async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return currentTaskNetwork();
    });

  // Interleaved on purpose: the one that started first finishes last.
  const [a, b] = await Promise.all([observe("task-a", 10), observe("task-b", 1)]);

  assert.deepEqual(a?.hosts, ["task-a.example"]);
  assert.deepEqual(b?.hosts, ["task-b.example"]);
  assert.equal(a?.recordHome, "/tmp/record-task-a");
  assert.equal(b?.recordHome, "/tmp/record-task-b");
});
