// Pure checks on the generated `docker run` argument list - the real
// proof that these flags actually confine a process is run.test.ts,
// which hands this exact output to the real Docker daemon. This file
// only checks that buildDockerArgs emits the flags its own reasoning
// depends on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDockerArgs, DEFAULT_CPUS, DEFAULT_MEMORY, DEFAULT_PIDS_LIMIT } from "./docker-args.ts";

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

test("buildDockerArgs passes the env allowlist as name-only -e flags, never values", () => {
  const args = buildDockerArgs({
    workdir: "/w",
    network: "denied",
    image: "alpine",
    env: { FOO: "bar", BAZ: "qux" },
  });

  assert.deepEqual(
    args.filter((_, i) => args[i - 1] === "-e"),
    ["FOO", "BAZ"]
  );
  assert.ok(
    !args.some((a) => a.includes("bar") || a.includes("qux")),
    "an env value must never appear in the docker argument list"
  );
});

test("buildDockerArgs ends with the image name, ready for the command and args to follow", () => {
  const args = buildDockerArgs({ workdir: "/w", network: "denied", image: "alpine" });

  assert.equal(args.at(-1), "alpine");
});

test("buildDockerArgs mounts readOnlyMounts entries read-only at their own path, not under /workdir", () => {
  const args = buildDockerArgs({
    workdir: "/w",
    network: "denied",
    image: "alpine",
    readOnlyMounts: ["/Users/ari/project/.git"],
  });

  assert.ok(args.includes("type=bind,source=/Users/ari/project/.git,target=/Users/ari/project/.git,readonly"));
});

test("buildDockerArgs applies resource cap defaults, overridable per call", () => {
  const defaults = buildDockerArgs({ workdir: "/w", network: "denied", image: "alpine" });
  assert.equal(defaults[defaults.indexOf("--memory") + 1], DEFAULT_MEMORY);
  assert.equal(defaults[defaults.indexOf("--cpus") + 1], DEFAULT_CPUS);
  assert.equal(defaults[defaults.indexOf("--pids-limit") + 1], String(DEFAULT_PIDS_LIMIT));

  const overridden = buildDockerArgs({
    workdir: "/w",
    network: "denied",
    image: "alpine",
    memory: "512m",
    cpus: "1",
    pidsLimit: 64,
  });
  assert.equal(overridden[overridden.indexOf("--memory") + 1], "512m");
  assert.equal(overridden[overridden.indexOf("--cpus") + 1], "1");
  assert.equal(overridden[overridden.indexOf("--pids-limit") + 1], "64");
});

test("buildDockerArgs mounts homeDir read-write and sets HOME to match, only when given", () => {
  const withHome = buildDockerArgs({ workdir: "/w", network: "denied", image: "alpine", homeDir: "/h" });
  const without = buildDockerArgs({ workdir: "/w", network: "denied", image: "alpine" });

  assert.ok(withHome.includes("type=bind,source=/h,target=/home/worker"));
  assert.equal(withHome[withHome.indexOf("HOME=/home/worker") - 1], "-e");
  assert.ok(!without.some((a) => a.startsWith("HOME=")));
  assert.ok(!without.includes("/home/worker"));
});
