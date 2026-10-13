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
    docker: () => ok("docker"),
    workerImage: () => ok("worker image"),
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
  const project = makeFixtureRepo("exit 0");
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

test("runUpCommand: a live view already listening is reused, not started twice, and no browser is opened", async () => {
  const io = captureIo();
  let captured: unknown;

  const code = await runUpCommand([], {
    recordHome: healthyRecordHome(),
    cwd: tempCwd(),
    doctorProbes: okProbes(),
    isLiveViewListening: async () => true,
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

test("runUpCommand: a real listener on the probed port is detected without starting a second one", async () => {
  const server = createServer();
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
      skillDir: fixtureSkillDir(),
      handbookPath: fixtureHandbookPath(),
      launcher: { harnessAvailable: () => true, launch: async () => ({ exitCode: 0 }) },
      ...io,
    });

    assert.equal(code, 0, io.err.join("\n"));
    assert.match(io.out.join("\n"), new RegExp(`already running - http://localhost:${port}`));
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

test("runUpCommand: propagates the harness session's own exit code", async () => {
  const io = captureIo();
  const code = await runUpCommand([], {
    recordHome: healthyRecordHome(),
    cwd: tempCwd(),
    doctorProbes: okProbes(),
    isLiveViewListening: async () => true,
    skillDir: fixtureSkillDir(),
    handbookPath: fixtureHandbookPath(),
    launcher: { harnessAvailable: () => true, launch: async () => ({ exitCode: 7 }) },
    ...io,
  });

  assert.equal(code, 7);
  assert.match(io.out.join("\n"), /still running at http:\/\/localhost:7777/);
  assert.match(io.out.join("\n"), /stop it with:/);
});
