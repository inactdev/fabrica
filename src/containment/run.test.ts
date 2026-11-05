// The real proof (issue #44): runs actual processes through runContained
// and shows, live, that they cannot write outside their workdir, cannot
// read a file that sits elsewhere on the host, and cannot reach the
// network unless network is deliberately allowed - all against the real
// Docker daemon on the real machine, nothing mocked. Skips (never fails)
// when Docker isn't available, since this module needs a real daemon to
// prove anything - see README.md.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { ContainmentError } from "./errors.ts";
import { GRACEFUL_STOP_SECONDS, runContained } from "./run.ts";
import type { ContainedRunResult } from "./types.ts";

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

// helpers/fake-docker-stop.mjs on PATH as `docker` for the duration of
// one test, with a reader for the argv the code under test really used -
// the same shim-on-PATH mechanism install-fake-docker.ts uses for the
// network commands, kept local to this file because this is the one
// suite that drives a container's start-and-stop. Its whole point is
// that the reissued stop below is proven everywhere this suite runs,
// not only on a machine with a Docker daemon.
function installFakeDockerStop(
  t: { after: (fn: () => void) => void },
  config: { missedStops: number; runCeilingMs: number }
): { calls: () => string[][] } {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "fabrica-fake-docker-stop-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const state = join(root, "state");
  for (const dir of [bin, state]) mkdirSync(dir);
  writeFileSync(join(state, "config.json"), JSON.stringify(config));

  const shim = join(bin, "docker");
  copyFileSync(join(dirname(fileURLToPath(import.meta.url)), "helpers", "fake-docker-stop.mjs"), shim);
  chmodSync(shim, 0o755);

  // `dirname(process.execPath)` too, so the shim's own `#!/usr/bin/env
  // node` resolves to the runtime running this test rather than
  // depending on `node` being on the ambient PATH.
  const priorPath = process.env.PATH;
  const priorState = process.env.FABRICA_FAKE_DOCKER_STOP;
  process.env.PATH = [bin, dirname(process.execPath), priorPath ?? ""].join(delimiter);
  process.env.FABRICA_FAKE_DOCKER_STOP = state;
  t.after(() => {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    if (priorState === undefined) delete process.env.FABRICA_FAKE_DOCKER_STOP;
    else process.env.FABRICA_FAKE_DOCKER_STOP = priorState;
  });

  const callsFile = join(state, "calls.jsonl");
  return {
    calls: () =>
      existsSync(callsFile)
        ? readFileSync(callsFile, "utf8")
            .split("\n")
            .filter((line) => line.trim() !== "")
            .map((line) => JSON.parse(line) as string[])
        : [],
  };
}

// The commands these tests stop would otherwise run for ten minutes, so
// a regression must fail in seconds rather than hang the suite out to
// that length: the run is raced against a deadline, and a run that
// misses it has its container force-removed here before the failure is
// reported, so nothing is left behind for the rest of the file (a
// leftover container keeps the networks it is on undeletable).
async function endsWithin(
  deadlineMs: number,
  run: Promise<ContainedRunResult>,
  containerName: string
): Promise<ContainedRunResult> {
  let timer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    run.then((result) => ({ result })),
    new Promise<"missed">((resolve) => {
      timer = setTimeout(() => resolve("missed"), deadlineMs);
    }),
  ]);
  clearTimeout(timer);
  if (outcome === "missed") {
    try {
      execFileSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
    } catch {
      // Nothing to remove, or docker would not say - the assertion
      // below is the real report either way.
    }
    await run.catch(() => {});
    assert.fail(`the run must end within ${deadlineMs}ms of the abort, not run its course`);
  }
  return outcome.result;
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

test("runContained: aborting stopSignal stops the container instead of waiting the command out", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const { workdir } = makeFixture();

  // A worker box whose relay has died is exactly this shape: a command
  // that will not finish on its own anywhere near soon enough
  // (2026-10-18: the real one spent four minutes failing).
  const name = `fabrica-test-stop-${process.pid}`;
  const stop = new AbortController();
  const startedAt = Date.now();
  setTimeout(() => stop.abort(), 500);

  const result = await runContained("sh", ["-c", "sleep 600"], {
    workdir,
    network: "denied",
    image: IMAGE,
    containerName: name,
    stopSignal: stop.signal,
  });

  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 60_000, `the run should end on the abort, not run its course - took ${elapsed}ms`);
  assert.notEqual(result.exitCode, 0, "a container removed under it is not a successful run");

  // Removed, not merely detached from: a container left behind keeps its
  // networks undeletable (src/relay/container/launch.ts's own note).
  const listed = execFileSync("docker", ["ps", "-a", "--filter", `name=${name}`, "--format", "{{.Names}}"], {
    encoding: "utf8",
  });
  assert.equal(listed.trim(), "", `the box must be gone, got: ${listed}`);
});

test("runContained: aborting gracefulStopSignal stops the container with SIGTERM first, then SIGKILL", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const { workdir } = makeFixture();

  // Issue #189: a subscription meter past its stop threshold stops an
  // attempt "gracefully, at the next safe point, the same
  // SIGTERM-then-SIGKILL path the owner's stop uses" (Client's
  // clarification) - as opposed to stopSignal's immediate force-remove
  // above. The command below traps SIGTERM and says so, which is what
  // proves a signal was really delivered rather than the container
  // simply being torn out from under it.
  const name = `fabrica-test-graceful-${process.pid}`;
  const pause = new AbortController();
  const startedAt = Date.now();
  setTimeout(() => pause.abort(), 500);

  const result = await runContained("sh", ["-c", "trap 'echo stopping; exit 0' TERM; sleep 600 & wait"], {
    workdir,
    network: "denied",
    image: IMAGE,
    containerName: name,
    gracefulStopSignal: pause.signal,
  });

  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 60_000, `the run should end on the abort, not run its course - took ${elapsed}ms`);
  assert.match(result.stdout, /stopping/, "the container got a real SIGTERM, not just a removal");

  // `docker run --rm` reaps a container that exits, so nothing is left
  // behind to keep this run's networks undeletable either.
  const listed = execFileSync("docker", ["ps", "-a", "--filter", `name=${name}`, "--format", "{{.Names}}"], {
    encoding: "utf8",
  });
  assert.equal(listed.trim(), "", `the box must be gone, got: ${listed}`);
});

// The two tests below need no daemon, so they run everywhere - which
// matters because every Docker-gated test in this file skips on a
// machine without one, and the reissue is the whole of issue #346's
// fix. The stand-in docker answers the first two stops the way the real
// one answers a stop for a container it has not created yet, so a
// single-shot stop leaves the command running its full course and the
// run comes back 99 instead of 137.
test("runContained: a stop that finds no container yet is reissued until the run ends", async (t) => {
  const fake = installFakeDockerStop(t, { missedStops: 2, runCeilingMs: 20_000 });
  const { workdir } = makeFixture();

  const stop = new AbortController();
  stop.abort();
  const startedAt = Date.now();

  const result = await runContained("sh", ["-c", "sleep 600"], {
    workdir,
    network: "denied",
    image: IMAGE,
    containerName: "fabrica-fake-box",
    stopSignal: stop.signal,
  });

  assert.equal(result.exitCode, 137, `the run must end on the stop, not run its course: ${result.stderr}`);
  const stops = fake.calls().filter((argv) => argv[0] === "rm");
  assert.deepEqual(stops[0], ["rm", "-f", "fabrica-fake-box"], "a force-remove, unchanged in shape");
  assert.equal(stops.length >= 3, true, `the stop must be reissued, not tried once - got ${stops.length}`);
  // Three stops at STOP_RETRY_INTERVAL_MS apart, not a wait on anything
  // the command itself does.
  assert.equal(Date.now() - startedAt < 10_000, true, "reissuing must take about a second, not the run's length");
});

test("runContained: a graceful stop that finds no container yet is reissued the same way", async (t) => {
  const fake = installFakeDockerStop(t, { missedStops: 2, runCeilingMs: 20_000 });
  const { workdir } = makeFixture();

  const pause = new AbortController();
  pause.abort();

  const result = await runContained("sh", ["-c", "sleep 600"], {
    workdir,
    network: "denied",
    image: IMAGE,
    containerName: "fabrica-fake-box",
    gracefulStopSignal: pause.signal,
  });

  assert.equal(result.exitCode, 137, `the run must end on the stop, not run its course: ${result.stderr}`);
  const stops = fake.calls().filter((argv) => argv[0] === "stop");
  assert.deepEqual(
    stops[0],
    ["stop", "--time", String(GRACEFUL_STOP_SECONDS), "fabrica-fake-box"],
    "SIGTERM-then-SIGKILL with its own grace period, unchanged in shape"
  );
  assert.equal(stops.length >= 3, true, `the graceful stop must be reissued too - got ${stops.length}`);
});

// Issue #346: the abort used to be acted on exactly once, so one that
// landed before `docker run` had created the container found nothing to
// stop - the container then started anyway and ran its full length.
// Aborting before the call even begins is that race at its widest, and
// is the shape a loaded CI runner kept hitting with a 500ms abort.
test("runContained: an abort that lands before the container exists still stops the run", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const { workdir } = makeFixture();

  const name = `fabrica-test-stop-early-${process.pid}`;
  const stop = new AbortController();
  stop.abort();

  const startedAt = Date.now();
  const result = await endsWithin(
    30_000,
    runContained("sh", ["-c", "sleep 600"], {
      workdir,
      network: "denied",
      image: IMAGE,
      containerName: name,
      stopSignal: stop.signal,
    }),
    name
  );

  assert.ok(Date.now() - startedAt < 30_000);
  assert.notEqual(result.exitCode, 0, "a container removed under it is not a successful run");

  const listed = execFileSync("docker", ["ps", "-a", "--filter", `name=${name}`, "--format", "{{.Names}}"], {
    encoding: "utf8",
  });
  assert.equal(listed.trim(), "", `the box must be gone, got: ${listed}`);
});

test("runContained: a gracefulStopSignal abort that lands before the container exists still stops the run", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const { workdir } = makeFixture();

  const name = `fabrica-test-graceful-early-${process.pid}`;
  const pause = new AbortController();
  pause.abort();

  const startedAt = Date.now();
  // Nothing here asserts the trap ran: a stop reissued this early can
  // reach the container before its shell has installed one, in which
  // case the grace period runs out and SIGKILL ends it instead. That
  // SIGTERM comes first is what the test above this one proves; what
  // this one proves is that the run ends at all.
  await endsWithin(
    30_000,
    runContained("sh", ["-c", "trap 'echo stopping; exit 0' TERM; sleep 600 & wait"], {
      workdir,
      network: "denied",
      image: IMAGE,
      containerName: name,
      gracefulStopSignal: pause.signal,
    }),
    name
  );

  assert.ok(Date.now() - startedAt < 30_000);

  const listed = execFileSync("docker", ["ps", "-a", "--filter", `name=${name}`, "--format", "{{.Names}}"], {
    encoding: "utf8",
  });
  assert.equal(listed.trim(), "", `the box must be gone, got: ${listed}`);
});

test("runContained: onStdout delivers the first chunk while the process is still running, not batched at close", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const { workdir } = makeFixture();

  const chunks: string[] = [];
  let firstChunkAt: number | undefined;
  const started = Date.now();
  const resultPromise = runContained("sh", ["-c", "echo first; sleep 1; echo second"], {
    workdir,
    network: "denied",
    image: IMAGE,
    onStdout: (chunk) => {
      if (chunks.length === 0) firstChunkAt = Date.now();
      chunks.push(chunk);
    },
  });

  const result = await resultPromise;
  const totalMs = Date.now() - started;

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "first\nsecond\n");
  assert.equal(chunks.join(""), "first\nsecond\n", "onStdout must see exactly what ends up in stdout, nothing more");
  assert.ok(firstChunkAt !== undefined, "onStdout must fire at least once");
  // "first" is written well under the 1s sleep that separates it from
  // "second" - if onStdout only fired once the whole call closed, its
  // first call would land at totalMs, not well before it.
  assert.ok(
    firstChunkAt! - started < totalMs - 500,
    `expected the first chunk to arrive well before the process closed (first chunk at +${firstChunkAt! - started}ms, total ${totalMs}ms)`
  );
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
