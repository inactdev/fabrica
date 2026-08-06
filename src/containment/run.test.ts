// The real proof (issue #44): runs actual processes through runContained
// and shows, live, that they cannot write outside their workdir, cannot
// read a file that sits elsewhere on the host, and cannot reach the
// network unless network is deliberately allowed - all against the real
// Docker daemon on the real machine, nothing mocked. Skips (never fails)
// when Docker isn't available, since this module needs a real daemon to
// prove anything - see README.md.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ContainmentError } from "./errors.ts";
import { runContained } from "./run.ts";

const IMAGE = "alpine";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// workdir plus a decoy that sits entirely outside it on the host -
// standing in for something real like the Client's actual project
// files or ~/.ssh/id_rsa. Unlike a host-process sandbox, nothing here
// needs to look like Fabrica's real directory shape (recordHome nesting,
// etc.) - a container never sees the host filesystem at all except
// what's explicitly mounted, so any two host directories prove the
// point equally well.
function makeFixture() {
  const workdir = mkdtempSync(join(tmpdir(), "fabrica-containment-workdir-"));
  writeFileSync(join(workdir, "inside.txt"), "inside workdir\n");
  const outsideDir = mkdtempSync(join(tmpdir(), "fabrica-containment-outside-"));
  writeFileSync(join(outsideDir, "secret.txt"), "should never be readable from workdir\n");
  return { workdir, outsideDir };
}

// The network probe below targets a well-known public IP:port directly
// (no DNS, no Docker Desktop-only names like `host.docker.internal`), so
// it behaves identically on Docker Desktop and native Linux Docker Engine.
const NETWORK_PROBE_ARGS = ["-z", "-w", "3", "1.1.1.1", "443"];

test("runContained: writes land inside workdir, and nowhere outside it", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const { workdir, outsideDir } = makeFixture();

  const inside = await runContained("sh", ["-c", "echo written > written.txt"], {
    workdir,
    network: "denied",
    image: IMAGE,
  });
  assert.equal(inside.exitCode, 0);
  assert.equal(readFileSync(join(workdir, "written.txt"), "utf8"), "written\n");

  // The exact host path outside workdir doesn't exist inside the
  // container at all - not merely write-protected, genuinely absent -
  // because nothing outside the one bind mount is ever visible.
  const outside = await runContained("sh", ["-c", `echo hack > ${join(outsideDir, "hack.txt")}`], {
    workdir,
    network: "denied",
    image: IMAGE,
  });
  assert.notEqual(outside.exitCode, 0);
  assert.equal(existsSync(join(outsideDir, "hack.txt")), false, "a write outside workdir must never land");
});

test("runContained: reads work inside workdir, but a file elsewhere on the host is invisible", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const { workdir, outsideDir } = makeFixture();

  const readInside = await runContained("cat", ["inside.txt"], { workdir, network: "denied", image: IMAGE });
  assert.equal(readInside.exitCode, 0);
  assert.equal(readInside.stdout, "inside workdir\n");

  const readOutside = await runContained("cat", [join(outsideDir, "secret.txt")], {
    workdir,
    network: "denied",
    image: IMAGE,
  });
  assert.notEqual(readOutside.exitCode, 0, "a file outside workdir must not be readable by its host path");
  assert.match(readOutside.stderr, /no such file or directory/i);
});

test("runContained: a nonexistent workdir is refused with a typed error, not a raw ENOENT", async (t) => {
  const { workdir } = makeFixture();
  const missing = join(workdir, "does-not-exist");

  await assert.rejects(
    runContained("sh", ["-c", "true"], { workdir: missing, network: "denied", image: IMAGE }),
    (err: unknown) => err instanceof ContainmentError && err.code === "invalid-path" && err.message.includes("workdir")
  );
});

test("runContained: a path containing a comma is refused with a clear typed error, not a raw docker parse failure", async () => {
  const base = mkdtempSync(join(tmpdir(), "fabrica-containment-comma-"));
  const commaDir = join(base, "with,comma");
  mkdirSync(commaDir);

  await assert.rejects(
    runContained("sh", ["-c", "true"], { workdir: commaDir, network: "denied", image: IMAGE }),
    (err: unknown) =>
      err instanceof ContainmentError &&
      err.code === "invalid-path" &&
      err.message.includes("with,comma") &&
      err.message.includes("comma")
  );
});

test("runContained: network: \"denied\" cannot reach the network", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const { workdir } = makeFixture();

  const result = await runContained("nc", NETWORK_PROBE_ARGS, {
    workdir,
    network: "denied",
    image: IMAGE,
  });
  assert.notEqual(result.exitCode, 0, "a contained process must not reach the network unless allowed");
});

test("runContained: network reaches out when deliberately allowed", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const { workdir } = makeFixture();

  const result = await runContained("nc", NETWORK_PROBE_ARGS, {
    workdir,
    network: "allowed",
    image: IMAGE,
  });
  assert.equal(result.exitCode, 0, 'network: "allowed" must let the process actually reach it');
});

test("runContained: the host's environment never leaks in - only the explicit env allowlist", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const { workdir } = makeFixture();

  process.env.FABRICA_TEST_WOULD_BE_LEAKED = "a secret the child must never inherit";
  try {
    const byDefault = await runContained("sh", ["-c", 'echo "${FABRICA_TEST_WOULD_BE_LEAKED-unset}"'], {
      workdir,
      network: "denied",
      image: IMAGE,
    });
    assert.equal(byDefault.exitCode, 0);
    assert.equal(byDefault.stdout, "unset\n", "a host env var must never reach the contained process by default");

    const allowlisted = await runContained("sh", ["-c", 'echo "${FABRICA_TEST_WOULD_BE_LEAKED-unset}"'], {
      workdir,
      network: "denied",
      image: IMAGE,
      env: { FABRICA_TEST_WOULD_BE_LEAKED: "explicitly allowlisted" },
    });
    assert.equal(allowlisted.exitCode, 0);
    // The allowlist's own value won, not the host's - proving the value
    // rode the throwaway --env-file, never the host's environment, since
    // both were set and only one can come out.
    assert.equal(allowlisted.stdout, "explicitly allowlisted\n");

    // A key the host doesn't have at all still arrives, comma and all -
    // the value travels as an environment value, never argv or CSV.
    const injected = await runContained("sh", ["-c", 'echo "${FABRICA_TEST_ONLY_ALLOWLISTED-unset}"'], {
      workdir,
      network: "denied",
      image: IMAGE,
      env: { FABRICA_TEST_ONLY_ALLOWLISTED: "reaches the container, commas included" },
    });
    assert.equal(injected.exitCode, 0);
    assert.equal(injected.stdout, "reaches the container, commas included\n");
  } finally {
    delete process.env.FABRICA_TEST_WOULD_BE_LEAKED;
  }
});

test("runContained: an env value containing a newline is refused, not silently truncated and injected", async () => {
  const { workdir } = makeFixture();

  // Docker's --env-file format has no escaping: a newline in a value
  // would truncate it there and hand the remaining lines to the
  // container as extra variables. A typed refusal, never corruption.
  await assert.rejects(
    runContained("sh", ["-c", "true"], {
      workdir,
      network: "denied",
      image: IMAGE,
      env: { FABRICA_TEST_MULTILINE: "line one\nINJECTED_KEY=injected value" },
    }),
    (err: unknown) =>
      err instanceof ContainmentError &&
      err.code === "invalid-path" &&
      err.message.includes("FABRICA_TEST_MULTILINE") &&
      err.message.includes("newline")
  );

  await assert.rejects(
    runContained("sh", ["-c", "true"], {
      workdir,
      network: "denied",
      image: IMAGE,
      env: { "BAD=KEY": "value" },
    }),
    (err: unknown) =>
      err instanceof ContainmentError && err.code === "invalid-path" && err.message.includes("BAD=KEY")
  );
});

test("runContained: readOnlyMounts are visible read-only at their own path, not remapped under /workdir", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const { workdir } = makeFixture();
  // Resolved, same reason workdir is elsewhere in this file: the mount
  // target is this exact path, not a fixed rewrite like /workdir is, so
  // an unresolved macOS /var -> /private/var path here would have the
  // command look in a different place than what actually got mounted.
  const readOnlyDir = realpathSync(mkdtempSync(join(tmpdir(), "fabrica-containment-readonly-")));
  writeFileSync(join(readOnlyDir, "shared.txt"), "read me\n");

  const read = await runContained("cat", [join(readOnlyDir, "shared.txt")], {
    workdir,
    network: "denied",
    image: IMAGE,
    readOnlyMounts: [readOnlyDir],
  });
  assert.equal(read.exitCode, 0);
  assert.equal(read.stdout, "read me\n");

  const write = await runContained("sh", ["-c", `echo no > ${join(readOnlyDir, "hack.txt")}`], {
    workdir,
    network: "denied",
    image: IMAGE,
    readOnlyMounts: [readOnlyDir],
  });
  assert.notEqual(write.exitCode, 0, "a readOnlyMounts path must not be writable");
  assert.equal(existsSync(join(readOnlyDir, "hack.txt")), false);
});

test("runContained: resource caps are genuinely enforced, not just documented", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const { workdir } = makeFixture();

  const memory = await runContained(
    "sh",
    ["-c", "cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes"],
    { workdir, network: "denied", image: IMAGE, memory: "256m" }
  );
  assert.equal(memory.exitCode, 0);
  assert.equal(memory.stdout.trim(), String(256 * 1024 * 1024), "the cgroup must reflect the requested memory cap");

  const cpu = await runContained(
    "sh",
    [
      "-c",
      'cat /sys/fs/cgroup/cpu.max 2>/dev/null || echo "$(cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us) $(cat /sys/fs/cgroup/cpu/cpu.cfs_period_us)"',
    ],
    { workdir, network: "denied", image: IMAGE, cpus: "1.5" }
  );
  assert.equal(cpu.exitCode, 0);
  const [quota, period] = cpu.stdout.trim().split(/\s+/).map(Number);
  assert.equal(quota / period, 1.5, "the cgroup must reflect the requested cpu cap");

  const forkBomb = await runContained(
    "sh",
    ["-c", "for i in $(seq 1 20); do sleep 5 & done; wait"],
    { workdir, network: "denied", image: IMAGE, pidsLimit: 5 }
  );
  assert.notEqual(forkBomb.exitCode, 0, "forking past pidsLimit must fail, not silently succeed");
  assert.match(forkBomb.stderr, /can't fork|resource temporarily unavailable/i);
});

test("runContained: homeDir persists across separate calls, and is writable under --user", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const { workdir } = makeFixture();
  const homeDir = mkdtempSync(join(tmpdir(), "fabrica-containment-home-"));

  const write = await runContained("sh", ["-c", 'echo "warm state" > "$HOME/state.txt"'], {
    workdir,
    network: "denied",
    image: IMAGE,
    homeDir,
  });
  assert.equal(write.exitCode, 0);

  // A second, entirely separate --rm container - the whole point of
  // homeDir is that state survives even though nothing else does.
  const read = await runContained("sh", ["-c", 'cat "$HOME/state.txt"'], {
    workdir,
    network: "denied",
    image: IMAGE,
    homeDir,
  });
  assert.equal(read.exitCode, 0);
  assert.equal(read.stdout, "warm state\n");
});
