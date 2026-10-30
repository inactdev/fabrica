// `fabrica register` exactly as main.ts/bin.mjs calls it - real
// argument parsing, real config loading, real git - with only the
// outside-this-machine things faked (see
// src/register/helpers/fake-register-tools.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { fakeRegisterTools } from "../register/helpers/fake-register-tools.ts";
import { loadConfig, projectsTomlPath } from "../index.ts";
import { registerSummary, runRegisterCommand } from "./register-command.ts";
import { main } from "./main.ts";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-cli-register-"));
}

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) };
}

function project(opts: { inspector?: boolean } = {}): string {
  const dir = makeFixtureRepo("exit 0", opts);
  execFileSync("git", ["config", "user.email", "client@example.test"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "The Client"], { cwd: dir });
  return dir;
}

test("runRegisterCommand: sets a project up and reports the pull request and the registry entry", async () => {
  const recordHome = tempHome();
  const dir = project({ inspector: false });
  const io = captureIo();

  const code = await runRegisterCommand(
    [dir, "--check", "exit 0", "--image", "cimg/node:24.18.0"],
    { recordHome, tools: fakeRegisterTools(), ...io }
  );

  assert.equal(code, 0);
  const stdout = io.out.join("\n");
  assert.ok(stdout.includes("https://github.com/fake/repo/pull/1"), stdout);
  assert.ok(stdout.includes("[projects."), stdout);
  assert.ok(stdout.includes("Merge that pull request"), stdout);
  assert.ok(Object.values(loadConfig(recordHome).projects).some((p) => p.path === dir));
});

test("runRegisterCommand: --protected reaches .inspector.json, and --name the registry", async () => {
  const recordHome = tempHome();
  const dir = project({ inspector: false });
  const tools = fakeRegisterTools();

  const code = await runRegisterCommand(
    [dir, "--check", "exit 0", "--image", "node:24", "--protected", "*.test.ts,docs/**", "--name", "spending-app"],
    { recordHome, tools, ...captureIo() }
  );

  assert.equal(code, 0);
  assert.ok(Object.hasOwn(loadConfig(recordHome).projects, "spending-app"));
  const config = JSON.parse(
    execFileSync("git", ["show", "fabrica/register:.inspector.json"], { cwd: dir, encoding: "utf8" })
  );
  assert.deepEqual(config.protectedPaths, [
    "check.sh",
    ".inspector.json",
    "Dockerfile.inspector",
    "*.test.ts",
    "docs/**",
  ]);
});

test("runRegisterCommand: --timeout reaches .inspector.json, and --image the Dockerfile's FROM", async () => {
  const recordHome = tempHome();
  const dir = project({ inspector: false });

  const code = await runRegisterCommand(
    [dir, "--check", "exit 0", "--image", "node:24", "--timeout", "900"],
    { recordHome, tools: fakeRegisterTools(), ...captureIo() }
  );

  assert.equal(code, 0);
  const config = JSON.parse(
    execFileSync("git", ["show", "fabrica/register:.inspector.json"], { cwd: dir, encoding: "utf8" })
  );
  assert.equal(config.timeoutSeconds, 900);
  assert.equal(Object.hasOwn(config, "image"), false, "inspector#47 retired the image key");
  const dockerfile = execFileSync("git", ["show", "fabrica/register:Dockerfile.inspector"], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.ok(dockerfile.includes("FROM node:24"), dockerfile);
});

// The flag it used to take is gone, and the refusal has to say what
// replaced it rather than only that it is unknown.
test("runRegisterCommand: --network refuses, naming Dockerfile.inspector, having touched nothing", async () => {
  const recordHome = tempHome();
  const dir = project({ inspector: false });
  const io = captureIo();

  const code = await runRegisterCommand(
    [dir, "--check", "exit 0", "--image", "node:24", "--network"],
    { recordHome, tools: fakeRegisterTools(), ...io }
  );

  assert.equal(code, 1);
  assert.deepEqual(io.out, []);
  assert.ok(io.err.join("\n").includes("Dockerfile.inspector"), io.err.join("\n"));
  assert.equal(existsSync(projectsTomlPath(recordHome)), false);
});

// `fabrica register .` has to mean this directory, and the registry has
// to record it absolutely - a relative path there would mean something
// different to every later caller.
test("runRegisterCommand: a relative path is resolved against cwd and recorded absolutely", async () => {
  const recordHome = tempHome();
  const dir = project({ inspector: false });
  const io = captureIo();

  const code = await runRegisterCommand(
    [".", "--check", "exit 0", "--image", "node:24"],
    { recordHome, cwd: dir, tools: fakeRegisterTools(), ...io }
  );

  assert.equal(code, 0);
  const registered = Object.values(loadConfig(recordHome).projects)[0];
  assert.equal(registered.path, dir);
  assert.equal(relative(dir, registered.path), "");
});

test("runRegisterCommand: a refusal exits 1 with the message on stderr and nothing on stdout", async () => {
  const recordHome = tempHome();
  const io = captureIo();

  const code = await runRegisterCommand(
    [mkdtempSync(join(tmpdir(), "fabrica-register-plain-")), "--check", "exit 0", "--image", "node:24"],
    { recordHome, tools: fakeRegisterTools(), ...io }
  );

  assert.equal(code, 1);
  assert.deepEqual(io.out, []);
  assert.ok(io.err.join("\n").includes("fabrica register:"));
  assert.equal(existsSync(projectsTomlPath(recordHome)), false);
});

// Issue #114: without --check and --image, a repository that needs
// setting up gets a proposed .inspector.json instead. The two streams
// are the contract - the document alone on stdout, so it can be piped
// into the file, and every field's reasoning on stderr, where JSON has
// nowhere to put a comment.
test("runRegisterCommand: a repository needing setup prints a proposal, JSON alone on stdout", async () => {
  const recordHome = tempHome();
  const dir = project({ inspector: false });
  const io = captureIo();

  const code = await runRegisterCommand([dir], { recordHome, tools: fakeRegisterTools(), ...io });

  // Still a refusal: nothing was written, nothing was registered, so
  // `fabrica register <path> && fabrica do ...` must not continue.
  assert.equal(code, 1);
  assert.equal(existsSync(projectsTomlPath(recordHome)), false);
  assert.equal(existsSync(join(dir, ".inspector.json")), false, "it prints the file, it never writes it");

  // stdout is exactly one JSON document and nothing else.
  assert.equal(io.out.length, 1, io.out.join("\n"));
  const config = JSON.parse(io.out[0]) as Record<string, unknown>;
  assert.equal(config.check, "./check.sh");

  // ...and every field's reasoning is on stderr instead, along with the
  // Dockerfile.inspector to commit next to it - the config names no
  // image since inspector#47, so the proposal is two files.
  const stderr = io.err.join("\n");
  for (const key of [
    "check:",
    "timeoutSeconds:",
    "protectedPaths:",
    "Dockerfile.inspector FROM:",
    "Dockerfile.inspector dependencies:",
  ]) {
    assert.ok(stderr.includes(key), `${key} should be explained on stderr: ${stderr}`);
  }
  assert.ok(stderr.includes("FROM "), "the Dockerfile itself belongs on stderr too");
  assert.ok(stderr.includes("Nothing was written"), stderr);
});

test("runRegisterCommand: a bad invocation refuses with the usage line, touching nothing", async () => {
  const io = captureIo();
  const code = await runRegisterCommand(["--check", "exit 0"], { recordHome: tempHome(), ...io });

  assert.equal(code, 1);
  assert.deepEqual(io.out, []);
  assert.ok(io.err.join("\n").includes("fabrica register <path>"));
});

test("registerSummary: the shortcut case says the project is ready now, not that something must be merged", () => {
  const lines = registerSummary({
    kind: "registry-only",
    name: "spending-app",
    path: "/srv/spending-app",
    check: "./check.sh",
    defaultBranch: "main",
    tomlPath: "/home/c/.fabrica/projects.toml",
    tomlEntry: '[projects.spending-app]\npath = "/srv/spending-app"\ncheck = "./check.sh"\n',
  }).join("\n");

  assert.ok(lines.includes("already set up on origin/main"));
  assert.ok(lines.includes('Ready: fabrica do "<task text>" --project spending-app'));
  assert.ok(!lines.includes("Merge"));
});

// The two things about the new third file the Client has to see on his
// own screen, not only in the pull request: that a Dockerfile.inspector
// he already had was left alone, and anything worth a look before he
// merges.
test("registerSummary: a left-alone Dockerfile.inspector and a warning both reach the screen", () => {
  const lines = registerSummary({
    kind: "full",
    name: "spending-app",
    path: "/srv/spending-app",
    check: "./check.sh",
    defaultBranch: "main",
    tomlPath: "/home/c/.fabrica/projects.toml",
    tomlEntry: '[projects.spending-app]\npath = "/srv/spending-app"\n',
    branch: "fabrica/register",
    pullRequestUrl: "https://github.com/c/spending-app/pull/7",
    dockerfile: "already-committed",
    warnings: ["the check command runs `npm ci`, and the check box has no network at all"],
  }).join("\n");

  assert.ok(lines.includes("already committed there - left exactly as it is"), lines);
  assert.ok(!lines.includes("check.sh and Dockerfile.inspector"), "it does not claim to have written that file");
  assert.ok(lines.includes("worth a look: the check command runs `npm ci`"), lines);
});

test("registerSummary: a written Dockerfile.inspector is named among the files, with no warnings line", () => {
  const lines = registerSummary({
    kind: "full",
    name: "spending-app",
    path: "/srv/spending-app",
    check: "./check.sh",
    defaultBranch: "main",
    tomlPath: "/home/c/.fabrica/projects.toml",
    tomlEntry: '[projects.spending-app]\npath = "/srv/spending-app"\n',
    branch: "fabrica/register",
    pullRequestUrl: "https://github.com/c/spending-app/pull/7",
    dockerfile: "written",
  }).join("\n");

  assert.ok(lines.includes("check.sh and Dockerfile.inspector"), lines);
  assert.ok(!lines.includes("left exactly as it is"), lines);
  assert.ok(!lines.includes("worth a look"), lines);
});

// Work mode. Three things the Client has to read on his own screen: what
// landed where, that nothing was proven, and what the two recorded
// settings then do on every round.
test("registerSummary: the work-mode case says what landed, that nothing was proven, and what the settings do", () => {
  const lines = registerSummary({
    kind: "terms",
    name: "dayjob",
    path: "/home/ari/work/widgets",
    check: "./check.sh",
    defaultBranch: "main",
    tomlPath: "/home/c/.fabrica/projects.toml",
    tomlEntry: '[projects.dayjob]\npath = "/home/ari/work/widgets"\nnoStamp = true\n',
    terms: "/home/ari/fabrica-terms/widgets",
    termsFiles: [
      { file: ".inspector.json", outcome: "written", detail: "asks Inspector to judge work on this repository" },
      { file: "check.sh", outcome: "kept", detail: "was already in this folder - left exactly as it is" },
      {
        file: "Dockerfile.inspector",
        outcome: "written",
        detail: "the image that command runs in, built from REPLACE-ME-with-the-image-this-check-runs-in",
      },
    ],
  }).join("\n");

  assert.ok(lines.includes("/home/ari/fabrica-terms/widgets"), lines);
  assert.ok(lines.includes("the repository itself was not touched"), lines);
  assert.ok(lines.includes("check.sh: was already in this folder"), lines);
  assert.ok(lines.includes("nothing was proven"), lines);
  assert.ok(lines.includes("is handed to Inspector instead of the repository"), lines);
  assert.ok(lines.includes("REPLACE-ME-with-... left in one of them refuses the task"), lines);
  assert.ok(lines.includes("githubTokenVar"), "a repository Fabrica cannot commit to needs its own token too");
  assert.ok(!lines.includes('Ready: fabrica do'), "this route proved nothing, so it must not read as proven");
  assert.ok(!lines.includes("Merge"), lines);
});

test("runRegisterCommand: --terms writes the three files beside the repository and registers it", async () => {
  const recordHome = tempHome();
  const dir = project({ inspector: false });
  const terms = mkdtempSync(join(tmpdir(), "fabrica-cli-terms-"));
  const tools = fakeRegisterTools();
  const io = captureIo();

  const code = await runRegisterCommand([dir, "--terms", terms], { recordHome, tools, ...io });

  assert.equal(code, 0);
  const stdout = io.out.join("\n");
  assert.ok(stdout.includes(terms), stdout);
  assert.ok(stdout.includes("noStamp = true"), stdout);
  assert.ok(existsSync(join(terms, ".inspector.json")), "the config lands in the folder, not the repository");
  assert.ok(!existsSync(join(dir, ".inspector.json")));
  assert.equal(tools.pullRequestCalls.length, 0, "nothing is pushed and nothing is opened on this route");
  assert.equal(loadConfig(recordHome).projects.dayjob ?? undefined, undefined);
  assert.ok(Object.values(loadConfig(recordHome).projects).some((p) => p.terms === terms));
});

// A relative --terms is resolved against cwd and recorded absolute, for
// the same reason <path> is: a relative folder in the registry would
// mean something different to every later caller.
test("runRegisterCommand: a relative --terms is resolved against cwd and recorded absolutely", async () => {
  const recordHome = tempHome();
  const dir = project({ inspector: false });
  const parent = mkdtempSync(join(tmpdir(), "fabrica-cli-terms-rel-"));
  mkdirSync(join(parent, "widgets"));

  const code = await runRegisterCommand([dir, "--terms", "widgets"], {
    recordHome,
    cwd: parent,
    tools: fakeRegisterTools(),
    ...captureIo(),
  });

  assert.equal(code, 0);
  const recorded = Object.values(loadConfig(recordHome).projects)[0].terms;
  assert.equal(recorded, realpathSync(join(parent, "widgets")));
});

test("runRegisterCommand: --terms with --check refuses, naming both, having written nothing", async () => {
  const recordHome = tempHome();
  const dir = project({ inspector: false });
  const terms = mkdtempSync(join(tmpdir(), "fabrica-cli-terms-clash-"));
  const io = captureIo();

  const code = await runRegisterCommand([dir, "--terms", terms, "--check", "npm test"], {
    recordHome,
    tools: fakeRegisterTools(),
    ...io,
  });

  assert.equal(code, 1);
  assert.deepEqual(io.out, [], "a refusal says nothing on stdout");
  assert.ok(io.err.join("\n").includes("--terms cannot be combined with --check"), io.err.join("\n"));
  assert.equal(existsSync(join(terms, ".inspector.json")), false);
  assert.equal(existsSync(projectsTomlPath(recordHome)), false);
});

test("main: `fabrica register --help` prints its usage and exits 0", async () => {
  const io = captureIo();
  assert.equal(await main(["register", "--help"], io), 0);
  assert.ok(io.out.join("\n").includes("fabrica register <path>"));
  assert.ok(io.out.join("\n").includes("the one Fabrica command that pushes"));
  // Every flag it accepts has to be findable from its own help - and
  // the one it no longer accepts must not be there to find.
  for (const flag of ["--check", "--image", "--timeout", "--protected", "--name"]) {
    assert.ok(io.out.join("\n").includes(flag), `${flag} should be documented in the help`);
  }
  assert.ok(!io.out.join("\n").includes("--network"), "--network is retired, not documented");
});

test("main: `fabrica --help` lists register", async () => {
  const io = captureIo();
  assert.equal(await main(["--help"], io), 0);
  assert.ok(io.out.join("\n").includes("register <path>"));
});
