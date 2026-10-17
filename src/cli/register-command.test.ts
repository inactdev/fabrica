// `fabrica register` exactly as main.ts/bin.mjs calls it - real
// argument parsing, real config loading, real git - with only the
// outside-this-machine things faked (see
// src/register/helpers/fake-register-tools.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
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
  assert.deepEqual(config.protectedPaths, ["check.sh", ".inspector.json", "*.test.ts", "docs/**"]);
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

test("main: `fabrica register --help` prints its usage and exits 0", async () => {
  const io = captureIo();
  assert.equal(await main(["register", "--help"], io), 0);
  assert.ok(io.out.join("\n").includes("fabrica register <path>"));
  assert.ok(io.out.join("\n").includes("the one Fabrica command that pushes"));
});

test("main: `fabrica --help` lists register", async () => {
  const io = captureIo();
  assert.equal(await main(["--help"], io), 0);
  assert.ok(io.out.join("\n").includes("register <path>"));
});
