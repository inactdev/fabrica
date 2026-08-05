// Pure checks on the generated `docker run` argument list - the real
// proof that these flags actually confine a process is run.test.ts,
// which hands this exact output to the real Docker daemon. This file
// only checks that buildDockerArgs emits the flags its own reasoning
// depends on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDockerArgs } from "./docker-args.ts";

test("buildDockerArgs mounts workdir at /workdir and sets it as the working directory", () => {
  const args = buildDockerArgs({ workdir: "/Users/ari/.fabrica/tasks/t1/worktree", network: "denied", image: "alpine" });

  assert.deepEqual(args.slice(0, 6), [
    "run",
    "--rm",
    "--mount",
    "type=bind,source=/Users/ari/.fabrica/tasks/t1/worktree,target=/workdir",
    "-w",
    "/workdir",
  ]);
});

test("buildDockerArgs adds --user when given one, omits it otherwise", () => {
  const withUser = buildDockerArgs({ workdir: "/w", network: "denied", image: "alpine", user: "501:20" });
  const without = buildDockerArgs({ workdir: "/w", network: "denied", image: "alpine" });

  assert.equal(withUser[withUser.indexOf("--user") + 1], "501:20");
  assert.ok(!without.includes("--user"));
});

test("buildDockerArgs adds --network none when denied, omits it when allowed", () => {
  const denied = buildDockerArgs({ workdir: "/w", network: "denied", image: "alpine" });
  const allowed = buildDockerArgs({ workdir: "/w", network: "allowed", image: "alpine" });

  assert.ok(denied.includes("--network") && denied.includes("none"));
  assert.ok(!allowed.includes("--network"));
});

test("buildDockerArgs passes only the explicit env allowlist as -e flags", () => {
  const args = buildDockerArgs({
    workdir: "/w",
    network: "denied",
    image: "alpine",
    env: { FOO: "bar", BAZ: "qux" },
  });

  assert.deepEqual(
    args.filter((_, i) => args[i - 1] === "-e"),
    ["FOO=bar", "BAZ=qux"]
  );
});

test("buildDockerArgs ends with the image name, ready for the command and args to follow", () => {
  const args = buildDockerArgs({ workdir: "/w", network: "denied", image: "alpine" });

  assert.equal(args.at(-1), "alpine");
});
