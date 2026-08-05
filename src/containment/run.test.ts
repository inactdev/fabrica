// The real proof (issue #44): runs actual processes through runContained
// and shows, live, that they cannot write outside their workdir, cannot
// read a file that sits elsewhere under the home directory, and cannot
// reach the network unless network is deliberately allowed - all against
// the real `sandbox-exec` on the real machine, nothing mocked. Skips
// (never fails) on a non-macOS machine, since this module only implements
// the macOS mechanism - see README.md.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runContained } from "./run.ts";

function sandboxAvailable(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    execFileSync("sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// A fixture "home": workdir nested inside it (matching Fabrica's real
// shape - recordHome defaults to ~/.fabrica, workdir lives under that),
// plus a decoy file that sits under the fixture home but outside workdir,
// standing in for something real like ~/.ssh/id_rsa.
function makeFixture() {
  const homeDir = mkdtempSync(join(tmpdir(), "fabrica-containment-home-"));
  const workdir = join(homeDir, "tasks", "t1", "worktree");
  mkdirSync(workdir, { recursive: true });
  writeFileSync(join(workdir, "inside.txt"), "inside workdir\n");
  const decoyDir = join(homeDir, "not-the-workdir");
  mkdirSync(decoyDir, { recursive: true });
  writeFileSync(join(decoyDir, "secret.txt"), "should never be readable from workdir\n");
  return { homeDir, workdir, decoyDir };
}

async function listenOnLoopback(): Promise<{ port: number; close: () => void }> {
  const server = createServer((sock) => {
    // `nc -z` (a connectivity probe, used below) closes the socket right
    // after connecting without reading anything - writing to it then
    // resets the connection. That's expected and not a test failure.
    sock.on("error", () => {});
    sock.end("hi\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a bound TCP address");
  return { port: address.port, close: () => server.close() };
}

test("runContained: writes land inside workdir, and nowhere outside it", async (t) => {
  if (!sandboxAvailable()) return t.skip("sandbox-exec is not available on this machine");
  const { homeDir, workdir, decoyDir } = makeFixture();

  const inside = await runContained("/bin/sh", ["-c", "echo written > written.txt"], {
    workdir,
    homeDir,
    network: "denied",
  });
  assert.equal(inside.exitCode, 0);
  assert.equal(readFileSync(join(workdir, "written.txt"), "utf8"), "written\n");

  const outside = await runContained("/bin/sh", ["-c", `echo hack > ${join(decoyDir, "hack.txt")}`], {
    workdir,
    homeDir,
    network: "denied",
  });
  assert.notEqual(outside.exitCode, 0);
  assert.equal(existsSync(join(decoyDir, "hack.txt")), false, "a write outside workdir must never land");
});

test("runContained: reads work inside workdir and outside the home dir, but not elsewhere under the home dir", async (t) => {
  if (!sandboxAvailable()) return t.skip("sandbox-exec is not available on this machine");
  const { homeDir, workdir, decoyDir } = makeFixture();

  const readInside = await runContained("/bin/cat", [join(workdir, "inside.txt")], { workdir, homeDir, network: "denied" });
  assert.equal(readInside.exitCode, 0);
  assert.equal(readInside.stdout, "inside workdir\n");

  const readDecoy = await runContained("/bin/cat", [join(decoyDir, "secret.txt")], { workdir, homeDir, network: "denied" });
  assert.notEqual(readDecoy.exitCode, 0, "a file elsewhere under the home dir must not be readable");
  assert.equal(readDecoy.stdout, "");

  // Something outside the excluded home dir entirely - proves the profile
  // isn't just denying everything, only the home dir minus workdir.
  const readSystemFile = await runContained("/bin/cat", ["/private/etc/hosts"], { workdir, homeDir, network: "denied" });
  assert.equal(readSystemFile.exitCode, 0);
});

test("runContained: network is denied by default", async (t) => {
  if (!sandboxAvailable()) return t.skip("sandbox-exec is not available on this machine");
  const { homeDir, workdir } = makeFixture();
  const server = await listenOnLoopback();

  try {
    const result = await runContained("/usr/bin/nc", ["-z", "-w", "2", "127.0.0.1", String(server.port)], {
      workdir,
      homeDir,
      network: "denied",
    });
    assert.notEqual(result.exitCode, 0, "a contained process must not reach the network unless allowed");
  } finally {
    server.close();
  }
});

test("runContained: network reaches out when deliberately allowed", async (t) => {
  if (!sandboxAvailable()) return t.skip("sandbox-exec is not available on this machine");
  const { homeDir, workdir } = makeFixture();
  const server = await listenOnLoopback();

  try {
    const result = await runContained("/usr/bin/nc", ["-z", "-w", "2", "127.0.0.1", String(server.port)], {
      workdir,
      homeDir,
      network: "allowed",
    });
    assert.equal(result.exitCode, 0, "network: \"allowed\" must let the process actually reach it");
  } finally {
    server.close();
  }
});
