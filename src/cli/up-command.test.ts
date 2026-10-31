// `fabrica up`: doctor's checks, then the live view (started detached,
// reused if already listening), then the harness itself. All three
// steps are exercised against injected test seams - the real network
// probe is only exercised against a real, throwaway TCP server, never
// the documented 7777 itself (nothing here ever binds that literal
// port, so this suite can run concurrently with a real live view on
// this machine without colliding).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { installFakeDocker } from "../containment/helpers/install-fake-docker.ts";
import { relayImagePull, relayImageStatus, workerImageBuild, workerImageStatus } from "../index.ts";
import type { DoctorCheck, DoctorProbes } from "./doctor-command.ts";
import { openAtMostOnce, runUpCommand } from "./up-command.ts";
import { runUpdateCommand, type UpdateProbes } from "./update-command.ts";
import { findLiveViewProcess } from "./live-view-process.ts";
import { ownProcessesOnly } from "./helpers/own-processes-only.ts";

function tempRecordHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-up-home-"));
}

function tempCwd(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-up-cwd-"));
}

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) };
}

const ok = (label: string): DoctorCheck => ({ ok: true, label, detail: "fine" });

function okProbes(overrides: Partial<DoctorProbes> = {}): DoctorProbes {
  return {
    node: () => ok("node"),
    checkout: () => ok("checkout"),
    npmLink: () => ok("npm link"),
    docker: () => ok("docker"),
    workerImage: () => ok("worker image"),
    workerCli: () => ok("worker CLI"),
    relayImage: () => ok("relay image"),
    // Issue #322: the image a project's own machine works in - injected
    // like every other docker-dependent line, so no test here depends on
    // this machine's images.
    projectImage: (_machine, label) => ok(label),
    workerNetworks: async () => ok("worker networks"),
    workerToken: () => ok("worker token"),
    githubApp: async () => ok("github app"),
    inspector: () => ok("inspector"),
    live: async () => ok("worker token (live)"),
    ...overrides,
  };
}

/** A recordHome whose projects.toml makes every one of doctor's
 * config-derived checks (project, caps, spend) pass too - the same
 * shape doctor-command.test.ts's healthyHome() builds. */
function healthyRecordHome(): string {
  const project = makeFixtureRepo("exit 0", { origin: false });
  execFileSync("git", ["remote", "add", "origin", "https://example.invalid/demo.git"], { cwd: project });
  // Issue #306: a project line now reports a config the installed
  // Inspector would refuse, and the shared fixture still writes the
  // retired `image` key with no Dockerfile.inspector beside it - so a
  // project meant to pass has to say so, the same way
  // doctor-command.test.ts's own healthyProject() does.
  writeFileSync(join(project, ".inspector.json"), '{"check":"./check.sh"}\n');
  writeFileSync(join(project, "Dockerfile.inspector"), "FROM alpine\n");
  execFileSync("git", ["add", "-A"], { cwd: project });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "a box Inspector can build"], {
    cwd: project,
  });
  const home = tempRecordHome();
  writeFileSync(
    join(home, "projects.toml"),
    `[caps]\nperTaskUsd = 5\nperDayUsd = 25\n\n[projects.demo]\npath = "${project}"\ncheck = "./check.sh"\n`
  );
  return home;
}

/** A skill/<harness>/ fixture with both a launch.ts (used only to prove
 * discovery finds the harness dir real tests don't override `launcher`
 * for) and a settings.json (whose path runUpCommand must pass through
 * to launch() verbatim). */
function fixtureSkillDir(harnessName = "working-harness", settingsContent = '{"ok":true}'): string {
  const skillDir = mkdtempSync(join(tmpdir(), "fabrica-up-skill-"));
  mkdirSync(join(skillDir, harnessName));
  writeFileSync(
    join(skillDir, harnessName, "launch.ts"),
    "export function harnessAvailable(){ return true; }\n" +
      "export function launch(){ throw new Error('must not be called - the test overrides launcher'); }\n"
  );
  writeFileSync(join(skillDir, harnessName, "settings.json"), settingsContent);
  return skillDir;
}

function fixtureHandbookPath(content = "HANDBOOK CONTENT XYZ\n"): string {
  const dir = mkdtempSync(join(tmpdir(), "fabrica-up-handbook-"));
  const path = join(dir, "HANDBOOK.md");
  writeFileSync(path, content);
  return path;
}

/** A throwaway integrations/<name>/up-hook.ts fixture - deliberately
 * named nothing real, the same way fixtureSkillDir's harness is called
 * "working-harness" rather than any real one - that records its own
 * invocation (opts included) by writing to a file under the record
 * home, since the test has no other way to observe a module dynamically
 * imported inside runUpCommand. */
function fixtureIntegrationsDir(): string {
  const integrationsDir = mkdtempSync(join(tmpdir(), "fabrica-up-integrations-"));
  mkdirSync(join(integrationsDir, "demo-integration"));
  writeFileSync(
    join(integrationsDir, "demo-integration", "up-hook.ts"),
    [
      "import { writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "export async function maybeStart(opts) {",
      "  writeFileSync(join(opts.recordHome, 'up-hook-called.json'), JSON.stringify({ sawFlag: opts.env.DEMO_FLAG === '1' }));",
      "}",
      "",
    ].join("\n")
  );
  return integrationsDir;
}

function neverStarted() {
  return () => {
    throw new Error("must not start a second live view when one is already listening");
  };
}

function neverOpened() {
  return () => {
    throw new Error("must not open a browser when reusing an already-running live view");
  };
}

/** fetchLiveViewVersion + getRunningCommit overrides that make Step 2
 * treat an already-listening live view as running this exact commit,
 * for tests that aren't themselves about the version check but still
 * need to get past it to reach the harness - without depending on this
 * machine's real git state or a real /api/version response. */
function sameCommitSeams(commit = "same-commit") {
  return { fetchLiveViewVersion: async () => commit, getRunningCommit: () => commit };
}

test("runUpCommand: an unknown flag is refused with exact instructions, not ignored", async () => {
  const io = captureIo();
  const code = await runUpCommand(["--json"], { recordHome: tempRecordHome(), ...io });

  assert.equal(code, 1);
  assert.deepEqual(io.out, []);
  assert.match(io.err[0], /unknown flag "--json"/);
  assert.match(io.err[0], /Usage: fabrica up/);
});

test("runUpCommand: a stray positional is refused, not silently ignored", async () => {
  const io = captureIo();
  const code = await runUpCommand(["oops"], { recordHome: tempRecordHome(), ...io });

  assert.equal(code, 1);
  assert.match(io.err[0], /unexpected argument "oops"/);
  assert.match(io.err[0], /up takes none/);
});

test("runUpCommand: refuses when a doctor check fails, printing the doctor output, before touching the live view or the harness", async () => {
  const io = captureIo();
  let liveViewTouched = false;
  let launchTouched = false;

  const code = await runUpCommand([], {
    recordHome: healthyRecordHome(),
    cwd: tempCwd(),
    doctorProbes: okProbes({
      docker: () => ({ ok: false, label: "docker", detail: "not reachable", fix: "start Docker, then try again" }),
    }),
    isLiveViewListening: async () => {
      liveViewTouched = true;
      return true;
    },
    launcher: {
      harnessAvailable: () => {
        launchTouched = true;
        return true;
      },
      launch: async () => {
        launchTouched = true;
        return { exitCode: 0 };
      },
    },
    skillDir: fixtureSkillDir(),
    handbookPath: fixtureHandbookPath(),
    ...io,
  });

  assert.equal(code, 1);
  assert.match(io.out.join("\n"), /FAIL docker: not reachable - fix: start Docker, then try again/);
  assert.match(io.err.join("\n"), /doctor checks failed/i);
  assert.equal(liveViewTouched, false, "must stop before even checking the live view");
  assert.equal(launchTouched, false, "must never reach the harness launch step");
});

// Client ruling 2026-10-23: a finding that stops no task from running
// is a warning above the session, never a refusal. The two the ruling
// names are both the checkout check's (a missing or commit-less
// build-info.json, and being behind origin); the mechanism is per-check
// severity, so these tests drive it through injected checks rather than
// through whatever this machine's own copy of fabrica happens to be.
test("runUpCommand: a failing check that stops no task is a warning above the session, not a refusal", async () => {
  const io = captureIo();
  let launched = false;

  const code = await runUpCommand([], {
    recordHome: healthyRecordHome(),
    cwd: tempCwd(),
    doctorProbes: okProbes({
      checkout: () => ({
        ok: false,
        blocking: false,
        label: "checkout",
        detail: "installed copy at /usr/local/lib/node_modules/fabrica has no build-info.json, so its commit is unknown",
        fix: "reinstall with: npm install -g github:inactdev/fabrica",
      }),
    }),
    isLiveViewListening: async () => true,
    ...sameCommitSeams(),
    skillDir: fixtureSkillDir(),
    handbookPath: fixtureHandbookPath(),
    launcher: {
      harnessAvailable: () => true,
      launch: async () => {
        launched = true;
        return { exitCode: 0 };
      },
    },
    ...io,
  });

  assert.equal(code, 0, io.err.join("\n"));
  assert.ok(launched, "the session must start - no build-info.json makes no task impossible");
  assert.match(io.err.join("\n"), /WARN checkout: .*no build-info\.json/);
  assert.match(io.err.join("\n"), /reinstall with: npm install -g github:inactdev\/fabrica/, "the fix is still printed, just not enforced");
  assert.match(io.err.join("\n"), /none of the above stops a task from running/);
});

test("runUpCommand: a passing check's own note (being behind origin) is printed above the session too", async () => {
  const io = captureIo();

  const code = await runUpCommand([], {
    recordHome: healthyRecordHome(),
    cwd: tempCwd(),
    doctorProbes: okProbes({
      checkout: () => ({
        ok: true,
        label: "checkout",
        detail: "installed copy v1.2.3, commit aaa111 (behind origin/master, latest is zzz999)",
        note: "behind origin/master, latest is zzz999 - bring it up to date with: fabrica update",
      }),
    }),
    isLiveViewListening: async () => true,
    ...sameCommitSeams(),
    skillDir: fixtureSkillDir(),
    handbookPath: fixtureHandbookPath(),
    launcher: { harnessAvailable: () => true, launch: async () => ({ exitCode: 0 }) },
    ...io,
  });

  assert.equal(code, 0, io.err.join("\n"));
  assert.match(io.err.join("\n"), /WARN checkout: behind origin\/master, latest is zzz999 - bring it up to date with: fabrica update/);
});

test("runUpCommand: a healthy machine prints no warnings at all", async () => {
  const io = captureIo();

  const code = await runUpCommand([], {
    recordHome: healthyRecordHome(),
    cwd: tempCwd(),
    doctorProbes: okProbes(),
    isLiveViewListening: async () => true,
    ...sameCommitSeams(),
    skillDir: fixtureSkillDir(),
    handbookPath: fixtureHandbookPath(),
    launcher: { harnessAvailable: () => true, launch: async () => ({ exitCode: 0 }) },
    ...io,
  });

  assert.equal(code, 0, io.err.join("\n"));
  assert.equal(io.err.join("\n"), "", "nothing to warn about must print nothing");
});

test("runUpCommand: one blocking finding still refuses even alongside findings that stop no task", async () => {
  const io = captureIo();

  const code = await runUpCommand([], {
    recordHome: healthyRecordHome(),
    cwd: tempCwd(),
    doctorProbes: okProbes({
      checkout: () => ({ ok: false, blocking: false, label: "checkout", detail: "no build-info.json" }),
      // A blocker nothing above could have supplied - deliberately not
      // the worker image, which `up` now builds itself rather than
      // refusing over (src/cli/image-repair.ts).
      workerToken: () => ({ ok: false, label: "worker token", detail: "not usable", fix: "put a token in brain.env" }),
    }),
    isLiveViewListening: async () => {
      throw new Error("must stop before the live view");
    },
    skillDir: fixtureSkillDir(),
    handbookPath: fixtureHandbookPath(),
    ...io,
  });

  assert.equal(code, 1);
  // The whole doctor report, rendered exactly as doctor renders it -
  // both failures included, the advisory one as the FAIL it still is.
  assert.match(io.out.join("\n"), /FAIL worker token: not usable - fix: put a token in brain\.env/);
  assert.match(io.out.join("\n"), /FAIL checkout: no build-info\.json/);
  // And the refusal names which of those two lines is actually in the way.
  assert.match(io.err.join("\n"), /doctor checks failed - worker token must be fixed/);
  assert.doesNotMatch(io.err.join("\n"), /checkout must be fixed/);
});

// The images a task needs are supplied by `fabrica up` itself rather
// than reported for the Client to go and fix (Client ruling
// 2026-10-30). Driven against the shared fake docker on PATH, with the
// two image probes answered for real through it - so these prove the
// wiring end to end without a daemon anywhere. The repair step's own
// behaviour is proven in src/cli/image-repair.test.ts.
test("runUpCommand: a missing worker image and relay image are built and pulled here, and the session starts", async (t) => {
  const docker = installFakeDocker(t, {});
  const build = workerImageBuild();
  const pull = relayImagePull();
  const io = captureIo();
  let launched = false;

  const code = await runUpCommand([], {
    recordHome: healthyRecordHome(),
    cwd: tempCwd(),
    doctorProbes: okProbes({ workerImage: () => workerImageStatus(), relayImage: () => relayImageStatus() }),
    isLiveViewListening: async () => true,
    ...sameCommitSeams(),
    skillDir: fixtureSkillDir(),
    handbookPath: fixtureHandbookPath(),
    launcher: {
      harnessAvailable: () => true,
      launch: async () => {
        launched = true;
        return { exitCode: 0 };
      },
    },
    ...io,
  });

  assert.equal(code, 0, io.out.concat(io.err).join("\n"));
  assert.ok(launched, "a session must start - both images are things `up` can supply");
  assert.deepEqual(
    docker.calls().filter((call) => call[0] === "build" || call[0] === "pull"),
    [build.args, pull.args]
  );
  // Reported, so the Client knows what the wait was for.
  assert.ok(io.out.includes(`worker image: built ${build.image}.`), io.out.join("\n"));
  assert.ok(io.out.includes(`relay image: pulled ${pull.image}.`), io.out.join("\n"));
  // And the report afterwards is the machine as it is now, so nothing
  // is warned about either.
  assert.doesNotMatch(io.err.join("\n"), /worker image|relay image/);
});

test("runUpCommand: an image that genuinely could not be built still refuses the session", async (t) => {
  installFakeDocker(t, { buildFailure: "no space left on device" });
  const io = captureIo();
  let launched = false;

  const code = await runUpCommand([], {
    recordHome: healthyRecordHome(),
    cwd: tempCwd(),
    doctorProbes: okProbes({ workerImage: () => workerImageStatus() }),
    isLiveViewListening: async () => {
      throw new Error("must stop before the live view");
    },
    skillDir: fixtureSkillDir(),
    handbookPath: fixtureHandbookPath(),
    launcher: {
      harnessAvailable: () => true,
      launch: async () => {
        launched = true;
        return { exitCode: 0 };
      },
    },
    ...io,
  });

  assert.equal(code, 1);
  assert.equal(launched, false);
  assert.match(io.err.join("\n"), /worker image: could not be built - .*no space left on device/);
  assert.match(io.err.join("\n"), /doctor checks failed - worker image must be fixed/);
  assert.match(io.out.join("\n"), /FAIL worker image: /);
});

test("runUpCommand: nothing is built when both image lines already pass", async (t) => {
  const docker = installFakeDocker(t, {});
  const io = captureIo();

  const code = await runUpCommand([], {
    recordHome: healthyRecordHome(),
    cwd: tempCwd(),
    doctorProbes: okProbes(),
    isLiveViewListening: async () => true,
    ...sameCommitSeams(),
    skillDir: fixtureSkillDir(),
    handbookPath: fixtureHandbookPath(),
    launcher: { harnessAvailable: () => true, launch: async () => ({ exitCode: 0 }) },
    ...io,
  });

  assert.equal(code, 0, io.err.join("\n"));
  assert.deepEqual(docker.calls(), [], "a healthy machine must not be touched at all");
});

test("runUpCommand: Docker is started before anything asks whether it is reachable", async () => {
  const io = captureIo();
  const order: string[] = [];

  const code = await runUpCommand([], {
    recordHome: healthyRecordHome(),
    cwd: tempCwd(),
    dockerDaemonOptions: {
      platform: "darwin",
      daemonUp: (() => {
        let up = false;
        return () => {
          const answer = up;
          up = true; // the app this "started" brings the daemon up
          return answer;
        };
      })(),
      startDockerApp: () => {
        order.push("docker started");
        return { ok: true, detail: "" };
      },
      pollIntervalMs: 1,
      timeoutMs: 2_000,
    },
    doctorProbes: okProbes({
      docker: () => {
        order.push("docker checked");
        return ok("docker");
      },
    }),
    isLiveViewListening: async () => true,
    ...sameCommitSeams(),
    skillDir: fixtureSkillDir(),
    handbookPath: fixtureHandbookPath(),
    launcher: { harnessAvailable: () => true, launch: async () => ({ exitCode: 0 }) },
    ...io,
  });

  assert.equal(code, 0, io.err.join("\n"));
  assert.deepEqual(order, ["docker started", "docker checked"]);
  assert.match(io.out.join("\n"), /starting it with `open -a Docker`/);
});

test("runUpCommand: a Docker that never comes up doesn't fail the command itself - the docker check does", async () => {
  const io = captureIo();

  const code = await runUpCommand([], {
    recordHome: healthyRecordHome(),
    cwd: tempCwd(),
    dockerDaemonOptions: {
      platform: "darwin",
      daemonUp: () => false,
      startDockerApp: () => ({ ok: false, detail: "Unable to find application named 'Docker'" }),
      pollIntervalMs: 1,
      timeoutMs: 50,
    },
    doctorProbes: okProbes({
      docker: () => ({ ok: false, label: "docker", detail: "not reachable", fix: "start Docker (e.g. open -a Docker), then try again" }),
    }),
    isLiveViewListening: async () => {
      throw new Error("must stop at the docker check");
    },
    skillDir: fixtureSkillDir(),
    handbookPath: fixtureHandbookPath(),
    ...io,
  });

  assert.equal(code, 1);
  assert.match(io.err.join("\n"), /could not start Docker/);
  assert.match(io.out.join("\n"), /FAIL docker: not reachable/, "the finding that stops the session is still doctor's own");
});

test("runUpCommand: nothing about Docker is started or printed on a machine that isn't a Mac", async () => {
  const io = captureIo();

  const code = await runUpCommand([], {
    recordHome: healthyRecordHome(),
    cwd: tempCwd(),
    dockerDaemonOptions: {
      platform: "linux",
      daemonUp: () => {
        throw new Error("must not ask about the daemon off a Mac");
      },
      startDockerApp: () => {
        throw new Error("must not try to start Docker off a Mac");
      },
    },
    doctorProbes: okProbes(),
    isLiveViewListening: async () => true,
    ...sameCommitSeams(),
    skillDir: fixtureSkillDir(),
    handbookPath: fixtureHandbookPath(),
    launcher: { harnessAvailable: () => true, launch: async () => ({ exitCode: 0 }) },
    ...io,
  });

  assert.equal(code, 0, io.err.join("\n"));
  assert.doesNotMatch(io.out.join("\n"), /Docker/);
});

test("runUpCommand: a live view already listening and running this exact commit is reused, not stopped or started twice, and no browser is opened", async () => {
  const io = captureIo();
  let captured: unknown;
  let stopped = false;

  const code = await runUpCommand([], {
    recordHome: healthyRecordHome(),
    cwd: tempCwd(),
    doctorProbes: okProbes(),
    isLiveViewListening: async () => true,
    ...sameCommitSeams(),
    findLiveViewProcess: () => {
      throw new Error("must never even look for the process - the commits already matched");
    },
    stopLiveViewProcess: () => {
      stopped = true;
    },
    startLiveView: neverStarted(),
    openBrowser: neverOpened(),
    skillDir: fixtureSkillDir(),
    handbookPath: fixtureHandbookPath(),
    launcher: {
      harnessAvailable: () => true,
      launch: async (opts) => {
        captured = opts;
        return { exitCode: 0 };
      },
    },
    ...io,
  });

  assert.equal(code, 0, io.err.join("\n"));
  assert.match(io.out.join("\n"), /already running - http:\/\/localhost:7777/);
  assert.ok(captured, "launch was never called");
  assert.equal(stopped, false, "must never stop a live view running the same commit");
});

test("runUpCommand: a live view already listening but running a different commit is stopped and replaced with a fresh one", async () => {
  const io = captureIo();
  let listening = true;
  let stoppedPid: number | null = null;
  let startCalls = 0;
  const opened: string[] = [];

  const code = await runUpCommand([], {
    recordHome: healthyRecordHome(),
    cwd: tempCwd(),
    doctorProbes: okProbes(),
    isLiveViewListening: async () => listening,
    fetchLiveViewVersion: async () => "old-commit",
    getRunningCommit: () => "new-commit",
    findLiveViewProcess: () => ({ pid: 99_999 }),
    stopLiveViewProcess: (pid) => {
      stoppedPid = pid;
      listening = false; // the stopped process actually goes away
    },
    startLiveView: () => {
      startCalls += 1;
      listening = true; // the fresh one binds
    },
    openBrowser: (url) => opened.push(url),
    liveViewStartTimeoutMs: 3_000,
    skillDir: fixtureSkillDir(),
    handbookPath: fixtureHandbookPath(),
    launcher: { harnessAvailable: () => true, launch: async () => ({ exitCode: 0 }) },
    ...io,
  });

  assert.equal(code, 0, io.err.join("\n"));
  assert.equal(stoppedPid, 99_999, "must stop exactly the process findLiveViewProcess identified");
  assert.equal(startCalls, 1, "must start exactly one fresh live view after stopping the stale one");
  assert.deepEqual(opened, ["http://localhost:7777"]);
  assert.match(io.out.join("\n"), /Live view started - http:\/\/localhost:7777/);
});

test("runUpCommand: a live view that doesn't answer /api/version at all is treated the same as a different commit", async () => {
  const io = captureIo();
  let listening = true;
  let stoppedPid: number | null = null;

  const code = await runUpCommand([], {
    recordHome: healthyRecordHome(),
    cwd: tempCwd(),
    doctorProbes: okProbes(),
    isLiveViewListening: async () => listening,
    fetchLiveViewVersion: async () => null,
    getRunningCommit: () => "whatever-this-copy-is",
    findLiveViewProcess: () => ({ pid: 12_345 }),
    stopLiveViewProcess: (pid) => {
      stoppedPid = pid;
      listening = false; // the stopped process goes away; this fixture never rebinds
    },
    startLiveView: () => {},
    openBrowser: () => {},
    liveViewStartTimeoutMs: 500,
    skillDir: fixtureSkillDir(),
    handbookPath: fixtureHandbookPath(),
    launcher: { harnessAvailable: () => true, launch: async () => ({ exitCode: 0 }) },
    ...io,
  });

  assert.equal(code, 0, io.err.join("\n"));
  assert.equal(stoppedPid, 12_345);
});

test("runUpCommand: starts the live view and opens the browser when nothing is listening yet", async () => {
  const io = captureIo();
  let startCalls = 0;
  let opened: string[] = [];
  let listeningAfterStart = false;

  const code = await runUpCommand([], {
    recordHome: healthyRecordHome(),
    cwd: tempCwd(),
    doctorProbes: okProbes(),
    isLiveViewListening: async () => listeningAfterStart,
    startLiveView: () => {
      startCalls += 1;
      listeningAfterStart = true;
    },
    openBrowser: (url) => opened.push(url),
    liveViewStartTimeoutMs: 3_000,
    skillDir: fixtureSkillDir(),
    handbookPath: fixtureHandbookPath(),
    launcher: { harnessAvailable: () => true, launch: async () => ({ exitCode: 0 }) },
    ...io,
  });

  assert.equal(code, 0, io.err.join("\n"));
  assert.equal(startCalls, 1, "the live view must be started exactly once");
  assert.deepEqual(opened, ["http://localhost:7777"]);
  assert.match(io.out.join("\n"), /Live view started - http:\/\/localhost:7777/);
});

test("runUpCommand: a live view that never starts listening in time still lets the harness launch", async () => {
  const io = captureIo();
  let opened = 0;

  const code = await runUpCommand([], {
    recordHome: healthyRecordHome(),
    cwd: tempCwd(),
    doctorProbes: okProbes(),
    isLiveViewListening: async () => false,
    startLiveView: () => {},
    openBrowser: () => {
      opened += 1;
    },
    liveViewStartTimeoutMs: 200,
    skillDir: fixtureSkillDir(),
    handbookPath: fixtureHandbookPath(),
    launcher: { harnessAvailable: () => true, launch: async () => ({ exitCode: 0 }) },
    ...io,
  });

  assert.equal(code, 0, io.err.join("\n"));
  assert.equal(opened, 0, "must not open a browser for a live view that never confirmed it started");
  assert.match(io.err.join("\n"), /did not start listening/i);
  assert.match(io.out.join("\n"), /may still be starting/i);
});

test("runUpCommand: a real listener on the probed port that isn't the live view (no /api/version, no matching process) is reported as an error, never killed", async () => {
  // A bare TCP server, not an HTTP one - real /api/version calls
  // against it never get a real answer, the same "didn't answer that
  // endpoint" case an unrelated process on 7777 would be. Every
  // connection is dropped the instant it's accepted (rather than left
  // open with no response, which would make the real fetch wait out
  // its own timeout, and would then make this server's own close()
  // hang forever afterward waiting for that still-open connection to
  // end - net.Server.close() only resolves once every connection it
  // ever accepted has ended). findLiveViewProcess is the real
  // pid-file-or-command-line lookup (live-view-process.ts) against the
  // real process table, minus any live view already running on this
  // machine before the tests started - it must find nothing to blame
  // for holding this port.
  const server = createServer();
  server.on("connection", (socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  try {
    const io = captureIo();
    const code = await runUpCommand([], {
      recordHome: healthyRecordHome(),
      cwd: tempCwd(),
      doctorProbes: okProbes(),
      liveViewPort: port,
      startLiveView: neverStarted(),
      openBrowser: neverOpened(),
      findLiveViewProcess: (home) => findLiveViewProcess(home, ownProcessesOnly),
      stopLiveViewProcess: () => {
        throw new Error("must never stop a process that was never identified as the live view");
      },
      skillDir: fixtureSkillDir(),
      handbookPath: fixtureHandbookPath(),
      launcher: {
        harnessAvailable: () => {
          throw new Error("must never reach the harness once the live view step errors out");
        },
        launch: async () => {
          throw new Error("must never reach the harness once the live view step errors out");
        },
      },
      ...io,
    });

    assert.equal(code, 1);
    assert.match(io.err.join("\n"), /doesn't look like the live view/i);
    assert.match(io.err.join("\n"), new RegExp(`127\\.0\\.0\\.1:${port}`));

    // The bare TCP server is still exactly as it was - nothing here
    // ever touched it.
    assert.equal(server.listening, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("runUpCommand: launch is called with the handbook text and this harness's settings file path", async () => {
  const io = captureIo();
  const skillDir = fixtureSkillDir("working-harness", '{"permissions":{}}');
  const handbookPath = fixtureHandbookPath("Load it, then act on it.\n");
  let captured: { cwd: string; settingsPath: string; appendSystemPrompt: string } | undefined;

  const code = await runUpCommand([], {
    recordHome: healthyRecordHome(),
    cwd: tempCwd(),
    doctorProbes: okProbes(),
    isLiveViewListening: async () => true,
    ...sameCommitSeams(),
    skillDir,
    handbookPath,
    launcher: {
      harnessAvailable: () => true,
      launch: async (opts) => {
        captured = opts;
        return { exitCode: 0 };
      },
    },
    ...io,
  });

  assert.equal(code, 0, io.err.join("\n"));
  assert.ok(captured, "launch was never called");
  assert.equal(captured!.appendSystemPrompt, "Load it, then act on it.\n");
  assert.equal(captured!.settingsPath, join(skillDir, "working-harness", "settings.json"));
});

test("runUpCommand: --continue is passed through to the harness launcher", async () => {
  const io = captureIo();
  let captured: { continueSession?: boolean } | undefined;

  const code = await runUpCommand(["--continue"], {
    recordHome: healthyRecordHome(),
    cwd: tempCwd(),
    doctorProbes: okProbes(),
    isLiveViewListening: async () => true,
    ...sameCommitSeams(),
    skillDir: fixtureSkillDir(),
    handbookPath: fixtureHandbookPath(),
    launcher: {
      harnessAvailable: () => true,
      launch: async (opts) => {
        captured = opts;
        return { exitCode: 0 };
      },
    },
    ...io,
  });

  assert.equal(code, 0, io.err.join("\n"));
  assert.equal(captured?.continueSession, true);
});

test("runUpCommand: -c is accepted as the short form of --continue", async () => {
  const io = captureIo();
  let captured: { continueSession?: boolean } | undefined;

  const code = await runUpCommand(["-c"], {
    recordHome: healthyRecordHome(),
    cwd: tempCwd(),
    doctorProbes: okProbes(),
    isLiveViewListening: async () => true,
    ...sameCommitSeams(),
    skillDir: fixtureSkillDir(),
    handbookPath: fixtureHandbookPath(),
    launcher: {
      harnessAvailable: () => true,
      launch: async (opts) => {
        captured = opts;
        return { exitCode: 0 };
      },
    },
    ...io,
  });

  assert.equal(code, 0, io.err.join("\n"));
  assert.equal(captured?.continueSession, true);
});

test("runUpCommand: without --continue, the harness launcher gets continueSession: false", async () => {
  const io = captureIo();
  let captured: { continueSession?: boolean } | undefined;

  const code = await runUpCommand([], {
    recordHome: healthyRecordHome(),
    cwd: tempCwd(),
    doctorProbes: okProbes(),
    isLiveViewListening: async () => true,
    ...sameCommitSeams(),
    skillDir: fixtureSkillDir(),
    handbookPath: fixtureHandbookPath(),
    launcher: {
      harnessAvailable: () => true,
      launch: async (opts) => {
        captured = opts;
        return { exitCode: 0 };
      },
    },
    ...io,
  });

  assert.equal(code, 0, io.err.join("\n"));
  assert.equal(captured?.continueSession, false);
});

test("runUpCommand: an unknown flag alongside --continue is still refused", async () => {
  const io = captureIo();
  const code = await runUpCommand(["--continue", "--json"], { recordHome: tempRecordHome(), ...io });

  assert.equal(code, 1);
  assert.match(io.err[0], /unknown flag "--json"/);
});

test("runUpCommand: the project folder is never created in, written to, or otherwise changed", async () => {
  const projectDir = tempCwd();
  writeFileSync(join(projectDir, "existing.txt"), "hello\n");
  const before = readdirSync(projectDir).sort();
  const beforeContent = readFileSync(join(projectDir, "existing.txt"), "utf8");

  const io = captureIo();
  const code = await runUpCommand([], {
    recordHome: healthyRecordHome(),
    cwd: projectDir,
    doctorProbes: okProbes(),
    isLiveViewListening: async () => true,
    ...sameCommitSeams(),
    skillDir: fixtureSkillDir(),
    handbookPath: fixtureHandbookPath(),
    launcher: {
      harnessAvailable: () => true,
      launch: async (opts) => {
        assert.equal(opts.cwd, projectDir);
        return { exitCode: 0 };
      },
    },
    ...io,
  });

  assert.equal(code, 0, io.err.join("\n"));
  assert.deepEqual(readdirSync(projectDir).sort(), before);
  assert.equal(readFileSync(join(projectDir, "existing.txt"), "utf8"), beforeContent);
});

test("runUpCommand: no usable per-harness launch script under skill/ refuses", async () => {
  const io = captureIo();
  const code = await runUpCommand([], {
    recordHome: healthyRecordHome(),
    cwd: tempCwd(),
    doctorProbes: okProbes(),
    isLiveViewListening: async () => true,
    ...sameCommitSeams(),
    skillDir: mkdtempSync(join(tmpdir(), "fabrica-up-empty-skill-")),
    ...io,
  });

  assert.equal(code, 1);
  assert.match(io.err.join("\n"), /no usable per-harness launch script/i);
});

test("runUpCommand: an unavailable harness refuses without ever launching", async () => {
  const io = captureIo();
  const code = await runUpCommand([], {
    recordHome: healthyRecordHome(),
    cwd: tempCwd(),
    doctorProbes: okProbes(),
    isLiveViewListening: async () => true,
    ...sameCommitSeams(),
    skillDir: fixtureSkillDir(),
    handbookPath: fixtureHandbookPath(),
    launcher: {
      harnessAvailable: () => false,
      launch: async () => {
        throw new Error("must not be called when the harness is unavailable");
      },
    },
    ...io,
  });

  assert.equal(code, 1);
  assert.match(io.err.join("\n"), /could not find or run your chat agent/i);
});

test("runUpCommand: discovers and calls every integrations/<name>/up-hook.ts, passing recordHome and env", async () => {
  const io = captureIo();
  const recordHome = healthyRecordHome();

  const code = await runUpCommand([], {
    recordHome,
    cwd: tempCwd(),
    doctorProbes: okProbes(),
    isLiveViewListening: async () => true,
    ...sameCommitSeams(),
    skillDir: fixtureSkillDir(),
    handbookPath: fixtureHandbookPath(),
    integrationsDir: fixtureIntegrationsDir(),
    env: { DEMO_FLAG: "1" },
    launcher: { harnessAvailable: () => true, launch: async () => ({ exitCode: 0 }) },
    ...io,
  });

  assert.equal(code, 0, io.err.join("\n"));
  const marker = JSON.parse(readFileSync(join(recordHome, "up-hook-called.json"), "utf8"));
  assert.equal(marker.sawFlag, true, "the hook should have been handed the env this call passed in");
});

test("runUpCommand: an up-hook that throws is reported but never stops the harness from launching", async () => {
  const io = captureIo();
  let launched = false;

  const code = await runUpCommand([], {
    recordHome: healthyRecordHome(),
    cwd: tempCwd(),
    doctorProbes: okProbes(),
    isLiveViewListening: async () => true,
    ...sameCommitSeams(),
    skillDir: fixtureSkillDir(),
    handbookPath: fixtureHandbookPath(),
    upHooks: [
      {
        maybeStart: async () => {
          throw new Error("boom");
        },
      },
    ],
    launcher: {
      harnessAvailable: () => true,
      launch: async () => {
        launched = true;
        return { exitCode: 0 };
      },
    },
    ...io,
  });

  assert.equal(code, 0);
  assert.ok(launched, "the harness must still launch even when an up-hook fails");
  assert.match(io.err.join("\n"), /integration hook failed to start/i);
});

test("runUpCommand: propagates the harness session's own exit code", async () => {
  const io = captureIo();
  const code = await runUpCommand([], {
    recordHome: healthyRecordHome(),
    cwd: tempCwd(),
    doctorProbes: okProbes(),
    isLiveViewListening: async () => true,
    ...sameCommitSeams(),
    skillDir: fixtureSkillDir(),
    handbookPath: fixtureHandbookPath(),
    launcher: { harnessAvailable: () => true, launch: async () => ({ exitCode: 7 }) },
    ...io,
  });

  assert.equal(code, 7);
  assert.match(io.out.join("\n"), /still running at http:\/\/localhost:7777/);
  assert.match(io.out.join("\n"), /stop it with:/);
});

// --- One browser tab, across a whole sequence of commands ----------

/** Real-shaped commits: 40 hex characters, which is what `git rev-parse
 * HEAD` reports, what a build-info.json carries and what /api/version
 * answers with. Nothing in the comparison cares about the shape - it is
 * a string equality either side of a process boundary - but a fixture
 * that hands both halves of a sequence a value no machine would ever
 * produce proves less than one that doesn't. */
const COMMIT_A = "4a9f0c1d2b3e4f5061728394a5b6c7d8e9f00112";
const COMMIT_B = "b17c2d3e4f5061728394a5b6c7d8e9f001122334";

/** A live view the way a command can actually see one from outside: a
 * port that is either bound or not, plus the commit the bound process
 * answers `/api/version` with - the commit the copy on disk was at when
 * THAT process started, never re-read afterwards
 * (integrations/live-view/server.ts). One world shared by every command
 * in a sequence, so `fabrica update` followed by `fabrica up` is
 * observed exactly as the machine would see it, browser tabs included.
 *
 * `diskCommit` is what the copy of fabrica on disk reads as - what a
 * freshly started live view captures, and what each command compares an
 * already-running one against. Setting it to null is the real,
 * reachable state of an installed copy with no readable
 * build-info.json: `fabrica doctor` reports it, and deliberately lets a
 * session start anyway (UP_HELP step 2).
 *
 * Every fact this fixture models is one the real component it stands in
 * for is separately tested on, so a reviewer can check the
 * correspondence rather than take it on trust:
 *   - `/api/version` answers the commit captured when THAT process
 *     started and never re-reads the checkout -
 *     integrations/live-view/server.test.ts, "keeps reporting the
 *     startup commit after the checkout moves under it".
 *   - it answers null rather than crashing when the commit is
 *     unreadable - same file, "reports null ... when the commit
 *     override itself returns null".
 *   - the commit each command compares that against is
 *     `runningCopyCommit`, which is null for exactly that copy -
 *     doctor-command.test.ts's own test for it.
 * What it deliberately does not model, because no tab count can turn on
 * it: the OS taking a moment to bind and free the port (here both are
 * instant; the real waits are waitUntilListening/waitUntilNotListening),
 * and something other than a live view holding the port, which has its
 * own test above.
 */
function liveViewWorld(initial: { listening: boolean; diskCommit: string | null }) {
  let listening = initial.listening;
  let startupCommit = initial.diskCommit;
  const world = {
    opens: [] as string[],
    starts: 0,
    stops: 0,
    diskCommit: initial.diskCommit,
    /** Everything but the browser opener: these seams exist on both
     * `fabrica up` and `fabrica update`, under the same names. */
    seams() {
      return {
        isLiveViewListening: async () => listening,
        fetchLiveViewVersion: async () => (listening ? startupCommit : null),
        findLiveViewProcess: () => (listening ? { pid: 4_242 } : null),
        stopLiveViewProcess: () => {
          world.stops += 1;
          listening = false;
        },
        startLiveView: () => {
          world.starts += 1;
          listening = true;
          startupCommit = world.diskCommit;
        },
        liveViewStartTimeoutMs: 2_000,
      };
    },
    openBrowser: (url: string) => world.opens.push(url),
  };
  return world;
}

/** The `fabrica up` half of a sequence, with every live-view seam wired
 * to one shared world and the harness/doctor steps stubbed out. */
function upAgainst(world: ReturnType<typeof liveViewWorld>, io: ReturnType<typeof captureIo>) {
  return runUpCommand(["--continue"], {
    recordHome: healthyRecordHome(),
    cwd: tempCwd(),
    doctorProbes: okProbes(),
    ...world.seams(),
    openBrowser: world.openBrowser,
    getRunningCommit: () => world.diskCommit,
    skillDir: fixtureSkillDir(),
    handbookPath: fixtureHandbookPath(),
    launcher: { harnessAvailable: () => true, launch: async () => ({ exitCode: 0 }) },
    ...io,
  });
}

/** A dev checkout `fabrica update` moves from one commit to another -
 * the same shape update-command.test.ts's own fixture builds, inline
 * here so this sequence test owns the commits it hands to both halves. */
function updateProbesMoving(world: ReturnType<typeof liveViewWorld>, to: string | null): UpdateProbes {
  return {
    copy: () => ({ kind: "dev-checkout", root: "/fake/checkout", branch: "master", commit: world.diskCommit, version: "0.0.0" }),
    isDirty: () => false,
    pull: () => {
      world.diskCommit = to;
      return { ok: true, message: "Fast-forward" };
    },
    reinstall: () => {
      throw new Error("must not reinstall a dev checkout");
    },
    inspector: {
      build: () => null,
      mainCommit: () => null,
      ancestry: () => "unknown",
      install: () => {
        throw new Error("must not install an Inspector in a live-view test");
      },
    },
  };
}

test("fabrica update then fabrica up --continue costs no browser tab at all - the one already open is still the live view's", async () => {
  const world = liveViewWorld({ listening: true, diskCommit: COMMIT_A });
  const updateIo = captureIo();

  const updateCode = await runUpdateCommand([], {
    recordHome: "/fake/home",
    probes: updateProbesMoving(world, COMMIT_B),
    ...world.seams(),
    ...updateIo,
  });

  assert.equal(updateCode, 0, updateIo.err.join("\n"));
  assert.match(updateIo.out.join("\n"), /live view restarted/);
  assert.deepEqual(world.opens, [], "fabrica update must open no browser tab of its own");

  const upIo = captureIo();
  const upCode = await upAgainst(world, upIo);

  assert.equal(upCode, 0, upIo.err.join("\n"));
  assert.deepEqual(world.opens, [], "nothing in the sequence may open a tab: the live view is current by the time up runs");
  assert.match(upIo.out.join("\n"), /already running - http:\/\/localhost:7777/);
  assert.equal(world.starts, 1, "only update's own restart - up must reuse what it found");
});

test("fabrica update then fabrica up --continue opens one tab in total even when neither side can name its commit", async () => {
  // The state that opened two tabs: an installed copy with no readable
  // build-info.json, so `runningCopyCommit` is null and the live view's
  // own /api/version answers null too. The comparison is inconclusive,
  // which both commands treat as stale on purpose - so both of them
  // restart the live view, and before this fix both opened a tab for it.
  const world = liveViewWorld({ listening: true, diskCommit: null });
  const updateIo = captureIo();

  const updateCode = await runUpdateCommand([], {
    recordHome: "/fake/home",
    probes: updateProbesMoving(world, null),
    ...world.seams(),
    ...updateIo,
  });

  assert.equal(updateCode, 0, updateIo.err.join("\n"));
  assert.deepEqual(world.opens, [], "fabrica update must open no browser tab of its own");

  const upIo = captureIo();
  const upCode = await upAgainst(world, upIo);

  assert.equal(upCode, 0, upIo.err.join("\n"));
  assert.ok(world.starts >= 2, "this fixture is only meaningful if both commands really did restart the live view");
  assert.deepEqual(world.opens, ["http://localhost:7777"], "exactly one tab, opened by the run that is starting a session");
});

test("one fabrica up opens exactly one browser tab, whatever it had to do to the live view", async () => {
  /** A live view running older code: started while the checkout was on
   * one commit, which has since moved under it. */
  const stale = () => {
    const world = liveViewWorld({ listening: true, diskCommit: COMMIT_A });
    world.diskCommit = COMMIT_B;
    return world;
  };

  const cases = [
    { label: "nothing listening yet", world: liveViewWorld({ listening: false, diskCommit: COMMIT_A }) },
    { label: "a live view running older code", world: stale() },
    { label: "a live view that can't name its commit", world: liveViewWorld({ listening: true, diskCommit: null }) },
  ];

  for (const { label, world } of cases) {
    const io = captureIo();

    const code = await upAgainst(world, io);

    assert.equal(code, 0, `${label}: ${io.err.join("\n")}`);
    assert.deepEqual(world.opens, ["http://localhost:7777"], `${label}: expected exactly one tab`);
  }
});

test("fabrica up opens no tab at all for a live view already running this exact commit", async () => {
  const world = liveViewWorld({ listening: true, diskCommit: COMMIT_A });
  const io = captureIo();

  const code = await upAgainst(world, io);

  assert.equal(code, 0, io.err.join("\n"));
  assert.deepEqual(world.opens, []);
  assert.equal(world.starts, 0, "must not start a second live view");
  assert.equal(world.stops, 0, "must not stop a live view running this exact commit");
});

test("refreshStaleLiveView has exactly two callers, and a third would inherit 'no tab' without saying so", () => {
  // What the two counting tests above rest on, checked rather than
  // assumed: a sequence totals one tab because `fabrica up` is the one
  // caller that hands refreshStaleLiveView a ready-callback. That is a
  // property of who calls it - nothing either test can observe from
  // outside the commands it runs. The callback now defaults to opening
  // nothing, which is the right default for a caller that says nothing,
  // but it also means a third caller gets "no tab" silently. This fails
  // the moment one appears, so whoever adds it decides about the tab on
  // purpose and adds their own sequence to the counts above. Reading the
  // source is the same approach inspector-stamp-workflow.test.ts takes
  // for a fact with no code of its own to exercise.
  const roots = [
    { label: "src", dir: join(import.meta.dirname, "..") },
    { label: "integrations", dir: join(import.meta.dirname, "..", "..", "integrations") },
  ];

  const callers: string[] = [];
  for (const { label, dir } of roots) {
    for (const entry of readdirSync(dir, { recursive: true })) {
      const rel = String(entry);
      // Tests are excluded on purpose: calling this function directly is
      // exactly what a test of it should do, and says nothing about
      // which command opens a tab.
      if (!rel.endsWith(".ts") || rel.endsWith(".test.ts")) continue;
      if (readFileSync(join(dir, rel), "utf8").includes("refreshStaleLiveView(")) callers.push(`${label}/${rel}`);
    }
  }

  assert.deepEqual(
    callers.sort(),
    ["src/cli/up-command.ts", "src/cli/update-command.ts"],
    "a new caller of refreshStaleLiveView must decide for itself whether it owes the Client a browser tab " +
      "(RefreshStaleLiveViewOptions.onLiveViewReady, which opens nothing unless passed) and be counted in the " +
      "one-tab-per-sequence tests above"
  );
});

test("openAtMostOnce forwards the first url and drops every one after it", () => {
  const opened: string[] = [];
  const open = openAtMostOnce((url) => opened.push(url));

  open("http://localhost:7777");
  open("http://localhost:7777");
  open("http://localhost:9999");

  assert.deepEqual(opened, ["http://localhost:7777"]);
});
