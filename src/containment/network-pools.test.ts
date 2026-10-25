// Both daemon messages asserted here are moby's own, copied from its
// source rather than invented - see network-pools.ts's header for where
// each one lives and which versions emit it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { NETWORK_PRUNE_COMMAND, networkCreateFailureMessage, poolsExhausted } from "./network-pools.ts";

const MODERN = "all predefined address pools have been fully subnetted";
const OLDER =
  "could not find an available, non-overlapping IPv4 address pool among the defaults to assign to the network";

test("the pool-exhaustion messages both daemons emit are recognised", () => {
  assert.equal(poolsExhausted(`Error response from daemon: ${MODERN}`), true);
  assert.equal(poolsExhausted(`Error response from daemon: ${OLDER}`), true);
  assert.equal(poolsExhausted("Error response from daemon: network with name x already exists"), false);
  assert.equal(poolsExhausted("Cannot connect to the Docker daemon at unix:///var/run/docker.sock"), false);
});

test("exhausted pools are reported with the cause and the prune command, Docker's own words kept", () => {
  const message = networkCreateFailureMessage("isolated", "fabrica-worker-abc", `Error response from daemon: ${MODERN}`);

  assert.match(message, /could not create isolated network "fabrica-worker-abc"/);
  assert.match(message, /no address pool left/);
  assert.match(message, /left behind by earlier tasks/);
  assert.ok(message.includes(NETWORK_PRUNE_COMMAND), "the one command that clears them must be named");
  assert.ok(message.includes(MODERN), "what docker itself said must still be there");
});

test("any other failure is reported as Docker worded it, with nothing added", () => {
  const said = "Error response from daemon: network with name fabrica-worker-abc already exists";

  const message = networkCreateFailureMessage("egress", "fabrica-worker-abc", said);

  assert.equal(message, `could not create egress network "fabrica-worker-abc": ${said}`);
  assert.ok(!message.includes(NETWORK_PRUNE_COMMAND), "pruning is not the fix for a cause we have not recognised");
});
