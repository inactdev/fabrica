// Runs everywhere, Docker or not, and never touches a real daemon:
// helpers/fake-docker.mjs goes on PATH as `docker` instead (see that
// file, and notes/20261017-fix-the-relay-s-failure-path-cleanup-in-ph.md
// for why this is the pattern). The network names below are ones no
// real daemon could own, so a shim that failed to take effect fails
// these tests loudly instead of quietly driving real Docker.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDocker } from "./helpers/install-fake-docker.ts";
import { listWorkerNetworks, networkAlreadyGone, networkLabelArgs, removeTaskNetworks, TASK_LABEL } from "./task-networks.ts";

test("only docker's own 'this network is not here' wording counts as already gone", () => {
  // Docker's wording for a network it cannot find: `network rm`'s, then
  // `network inspect`'s.
  assert.equal(networkAlreadyGone("Error response from daemon: network fabrica-worker-abc not found"), true);
  assert.equal(networkAlreadyGone("Error: No such network: fabrica-worker-abc"), true);

  // The two that must never be read as a network that went away: one is
  // still there with something on it, and the other is nobody having
  // answered at all.
  assert.equal(
    networkAlreadyGone("error while removing network: network fabrica-worker-abc has active endpoints"),
    false
  );
  assert.equal(networkAlreadyGone("Cannot connect to the Docker daemon at unix:///var/run/docker.sock"), false);
});

test("a network is labelled with its role, and with its task when there is one", () => {
  assert.deepEqual(networkLabelArgs("worker", "t1"), [
    "--label",
    "fabrica.role=worker",
    "--label",
    "fabrica.task=t1",
  ]);
  assert.deepEqual(networkLabelArgs("relay-egress", undefined), ["--label", "fabrica.role=relay-egress"]);
  // An empty task id is no task at all - never a label matching "".
  assert.deepEqual(networkLabelArgs("worker", ""), ["--label", "fabrica.role=worker"]);
});

test("removeTaskNetworks removes exactly the networks labelled with that task", async (t) => {
  const docker = installFakeDocker(t, {
    networks: [
      { Name: "fabrica-test-worker-mine", Labels: { [TASK_LABEL]: "t1" } },
      { Name: "fabrica-test-egress-mine", Labels: { [TASK_LABEL]: "t1" } },
      { Name: "fabrica-test-worker-theirs", Labels: { [TASK_LABEL]: "t2" } },
      { Name: "fabrica-test-worker-unlabelled" },
    ],
  });

  const sweep = await removeTaskNetworks("t1");

  assert.deepEqual(sweep.removed.sort(), ["fabrica-test-egress-mine", "fabrica-test-worker-mine"]);
  assert.deepEqual(sweep.failed, []);
  assert.equal(sweep.dockerUnreachable, false);
  assert.deepEqual(docker.remaining().sort(), ["fabrica-test-worker-theirs", "fabrica-test-worker-unlabelled"]);
  assert.deepEqual(docker.calls()[0], [
    "network",
    "ls",
    "--filter",
    "label=fabrica.task=t1",
    "--format",
    "{{.Name}}",
  ]);
});

test("a container Docker has not reaped yet is forced off, and the network still goes", async (t) => {
  const docker = installFakeDocker(t, {
    networks: [{ Name: "fabrica-test-worker-held", Labels: { [TASK_LABEL]: "t1" }, Containers: { abc123: {} } }],
  });

  const sweep = await removeTaskNetworks("t1");

  assert.deepEqual(sweep.removed, ["fabrica-test-worker-held"]);
  assert.deepEqual(sweep.failed, []);
  assert.deepEqual(docker.remaining(), []);
  assert.ok(
    docker.calls().some((call) => call.join(" ") === "network disconnect -f fabrica-test-worker-held abc123"),
    "the attached container must be disconnected before the retry"
  );
});

test("a task with no networks of its own sweeps nothing and reports nothing", async (t) => {
  const docker = installFakeDocker(t, { networks: [{ Name: "fabrica-test-worker-theirs", Labels: { [TASK_LABEL]: "t2" } }] });

  const sweep = await removeTaskNetworks("t1");

  assert.deepEqual(sweep, { removed: [], failed: [], dockerUnreachable: false });
  assert.deepEqual(docker.remaining(), ["fabrica-test-worker-theirs"]);
});

test("no daemon to ask is reported as that, not as a clean machine", async (t) => {
  installFakeDocker(t, { failLs: true });

  const sweep = await removeTaskNetworks("t1");

  assert.equal(sweep.dockerUnreachable, true);
  assert.deepEqual(sweep.failed, []);
  assert.equal(await listWorkerNetworks(), null, "listWorkerNetworks must say nobody could answer, not 'none'");
});

test("listWorkerNetworks reports each worker network's task and how many containers are on it", async (t) => {
  installFakeDocker(t, {
    networks: [
      { Name: "fabrica-worker-aaa", Labels: { [TASK_LABEL]: "t1" }, Containers: { c1: {}, c2: {} } },
      { Name: "fabrica-worker-bbb" },
      // Neither of these is a worker network: one is the relay's egress
      // leg, the other is nothing of Fabrica's.
      { Name: "fabrica-relay-egress-aaa", Labels: { [TASK_LABEL]: "t1" } },
      { Name: "bridge" },
    ],
  });

  const networks = await listWorkerNetworks();

  assert.deepEqual(networks, [
    { name: "fabrica-worker-aaa", taskId: "t1", attachedContainers: 2 },
    { name: "fabrica-worker-bbb", taskId: null, attachedContainers: 0 },
  ]);
});
