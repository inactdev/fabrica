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
import type { DoctorCheck, DoctorProbes } from "./doctor-command.ts";
import { runUpCommand } from "./up-command.ts";
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
    workerToken: () => ok("worker token"),
    githubToken: () => ok("GitHub token"),
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
