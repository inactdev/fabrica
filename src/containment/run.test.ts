// The real proof (issue #44): runs actual processes through runContained
// and shows, live, that they cannot write outside their workdir, cannot
// read a file that sits elsewhere on the host, and cannot reach the
// network unless network is deliberately allowed - all against the real
// Docker daemon on the real machine, nothing mocked. Skips (never fails)
// when Docker isn't available, since this module needs a real daemon to
// prove anything - see README.md.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
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

async function listenOnHost(): Promise<{ port: number; close: () => void }> {
  const server = createServer((sock) => {
    // `nc -z` (a connectivity probe, used below) closes the socket right
    // after connecting without reading anything - writing to it then
    // resets the connection. That's expected and not a test failure.
    sock.on("error", () => {});
    sock.end("hi\n");
  });
  // 0.0.0.0, not 127.0.0.1: a container reaches the host through Docker
  // Desktop's `host.docker.internal`, a real interface, not loopback.
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a bound TCP address");
  return { port: address.port, close: () => server.close() };
}

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

test("runContained: network is denied by default", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const { workdir } = makeFixture();
  const server = await listenOnHost();

  try {
    const result = await runContained("nc", ["-z", "-w", "2", "host.docker.internal", String(server.port)], {
      workdir,
      network: "denied",
      image: IMAGE,
    });
    assert.notEqual(result.exitCode, 0, "a contained process must not reach the network unless allowed");
  } finally {
    server.close();
  }
});

test("runContained: network reaches out when deliberately allowed", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");
  const { workdir } = makeFixture();
  const server = await listenOnHost();

  try {
    const result = await runContained("nc", ["-z", "-w", "2", "host.docker.internal", String(server.port)], {
      workdir,
      network: "allowed",
      image: IMAGE,
    });
    assert.equal(result.exitCode, 0, 'network: "allowed" must let the process actually reach it');
  } finally {
    server.close();
  }
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
    assert.equal(allowlisted.stdout, "explicitly allowlisted\n");
  } finally {
    delete process.env.FABRICA_TEST_WOULD_BE_LEAKED;
  }
});
