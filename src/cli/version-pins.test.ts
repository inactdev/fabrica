// A project's terms measured against the versions its repository
// declares, and - for a terms folder outside that repository - brought
// into line (issue #355).
//
// The headline case is the issue's own, in its own numbers: a terms
// folder saying `FROM ruby:3.4.8` while the repository's `.ruby-version`
// says 3.4.13. `fabrica update` converts it and the next image is built
// on 3.4.13 with nothing done by hand - which is what the last test
// here proves, through the real `runUpdateCommand` against a fake
// docker, reading the argv and the generated Dockerfile that build was
// actually handed.
//
// Nothing here runs a real daemon: what is under test is the file
// rewriting, the doctor line and the argv. That a `FROM` carrying a
// build argument really builds on the version the argument carries is a
// different question, proved against a real builder in
// src/buildargs/arg-form-build.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { machineDockerfileFor, machineImageFor, machineImageForProject } from "../index.ts";
import { loadConfig } from "../config/index.ts";
import {
  convertProjectVersionPins,
  describeVersionPinConversions,
  termsOutsideRepo,
  versionPinsCheck,
  versionPinsLabel,
} from "./version-pins.ts";
import { runUpdateCommand } from "./update-command.ts";
import type { CopyInfo } from "./doctor-command.ts";

const HARD_CODED_TERMS = ["# This project's check box.", "FROM ruby:3.4.8", "RUN bundle install --quiet", ""].join("\n");

const TERMS_CONFIG = `${JSON.stringify({ check: "sh /terms/check.sh", protectedPaths: ["check.sh"] }, null, 2)}\n`;

/** A repository declaring ruby 3.4.13 for itself, and - outside it -
 * the terms folder whose Dockerfile still says 3.4.8. The exact fixture
 * issue #355 asks for. */
function workModeFixture(opts: { dockerfile?: string; config?: string | null; rubyVersion?: string | null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "fabrica-version-pins-"));
  const project = join(root, "repo");
  const terms = join(root, "terms");
  const recordHome = join(root, "home");
  for (const dir of [project, terms, recordHome]) mkdirSync(dir, { recursive: true });

  const ruby = opts.rubyVersion === undefined ? "3.4.13\n" : opts.rubyVersion;
  if (ruby !== null) writeFileSync(join(project, ".ruby-version"), ruby);
  writeFileSync(join(terms, "Dockerfile.inspector"), opts.dockerfile ?? HARD_CODED_TERMS);
  const config = opts.config === undefined ? TERMS_CONFIG : opts.config;
  if (config !== null) writeFileSync(join(terms, ".inspector.json"), config);
  writeFileSync(
    join(recordHome, "projects.toml"),
    `[projects.dayjob]\npath = ${JSON.stringify(project)}\nterms = ${JSON.stringify(terms)}\n`
  );
  return { project, terms, recordHome, dockerfile: join(terms, "Dockerfile.inspector"), config: join(terms, ".inspector.json") };
}

/** A repository that commits its own terms at its root - the case
 * Fabrica may never edit. */
function inRepoFixture(opts: { dockerfile?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "fabrica-version-pins-repo-"));
  const project = join(root, "repo");
  const recordHome = join(root, "home");
  mkdirSync(project, { recursive: true });
  mkdirSync(recordHome, { recursive: true });
  writeFileSync(join(project, ".ruby-version"), "3.4.13\n");
  writeFileSync(join(project, "Dockerfile.inspector"), opts.dockerfile ?? HARD_CODED_TERMS);
  writeFileSync(join(project, ".inspector.json"), `${JSON.stringify({ check: "./check.sh" }, null, 2)}\n`);
  writeFileSync(join(recordHome, "projects.toml"), `[projects.own]\npath = ${JSON.stringify(project)}\n`);
  return { project, recordHome, dockerfile: join(project, "Dockerfile.inspector"), config: join(project, ".inspector.json") };
}

function machineFor(recordHome: string, project: string) {
  return machineImageFor(loadConfig(recordHome), project);
}

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) };
}

test("a terms folder outside the repository is one Fabrica may rewrite; committed terms are not", () => {
  const outside = workModeFixture();
  const inside = inRepoFixture();
  assert.equal(termsOutsideRepo(machineFor(outside.recordHome, outside.project)), true);
  assert.equal(termsOutsideRepo(machineFor(inside.recordHome, inside.project)), false);
});

test("doctor names the hard-coded version, what the repository says, and --fix as the fix", () => {
  const fixture = workModeFixture();
  const check = versionPinsCheck(machineFor(fixture.recordHome, fixture.project), versionPinsLabel("dayjob"));

  assert.equal(check.ok, false);
  // A hard-coded version still builds, exactly as it did before any of
  // this - so this must not stop `fabrica up` from starting a session.
  assert.equal(check.blocking, false);
  assert.equal(check.label, "project dayjob versions");
  assert.match(check.detail, /hard-codes ruby 3\.4\.8/);
  assert.match(check.detail, /\.ruby-version says 3\.4\.13/);
  assert.match(check.fix ?? "", /fabrica doctor --fix/);
  assert.match(check.fix ?? "", /Dockerfile\.inspector\.bak/);
});

test("for committed terms the doctor line carries the exact replacement lines instead", () => {
  const fixture = inRepoFixture();
  const check = versionPinsCheck(machineFor(fixture.recordHome, fixture.project), versionPinsLabel("own"));

  assert.equal(check.ok, false);
  assert.equal(check.blocking, false);
  assert.match(check.fix ?? "", /never edits/);
  assert.match(check.fix ?? "", /add "ARG RUBY_VERSION=3\.4\.8" above the first FROM/);
  assert.match(check.fix ?? "", /"FROM ruby:3\.4\.8" -> "FROM ruby:\$\{RUBY_VERSION\}"/);
  assert.match(check.fix ?? "", /buildArgs/);
});

test("doctor passes, naming the versions in force, once a project reads them from its own files", () => {
  const fixture = workModeFixture({
    dockerfile: "ARG RUBY_VERSION=3.4.8\nFROM ruby:${RUBY_VERSION}\n",
    config: `${JSON.stringify({ check: "sh /terms/check.sh", buildArgs: { RUBY_VERSION: { file: ".ruby-version" } } }, null, 2)}\n`,
  });
  const check = versionPinsCheck(machineFor(fixture.recordHome, fixture.project), versionPinsLabel("dayjob"));

  assert.equal(check.ok, true);
  assert.match(check.detail, /RUBY_VERSION=3\.4\.13/);
  assert.match(check.detail, /this repository's own files/);
});

// A declared argument with no value is not a passing project: every
// build silently falls back to the Dockerfile's own default, which is
// the stale version the whole issue is about.
test("doctor FAILs when a declared build argument cannot be valued at all", () => {
  const fixture = workModeFixture({
    dockerfile: "ARG RUBY_VERSION=3.4.8\nFROM ruby:${RUBY_VERSION}\n",
    config: `${JSON.stringify({ check: "sh /terms/check.sh", buildArgs: { RUBY_VERSION: { file: ".ruby-version" } } }, null, 2)}\n`,
    rubyVersion: null,
  });
  const check = versionPinsCheck(machineFor(fixture.recordHome, fixture.project), versionPinsLabel("dayjob"));

  assert.equal(check.ok, false);
  assert.equal(check.blocking, false);
  assert.match(check.detail, /\.ruby-version is not in this project/);
  assert.match(check.detail, /falls back to whatever default/);
});

test("a project on the shared image has nothing to pin and passes", () => {
  const root = mkdtempSync(join(tmpdir(), "fabrica-version-pins-plain-"));
  const project = join(root, "repo");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(root, "projects.toml"), `[projects.plain]\npath = ${JSON.stringify(project)}\n`);
  const check = versionPinsCheck(machineFor(root, project), versionPinsLabel("plain"));

  assert.equal(check.ok, true);
  assert.match(check.detail, /shared image/);
});

test("converting writes both files, keeps each old one as .bak, and prints exactly what changed", () => {
  const fixture = workModeFixture();
  const io = captureIo();

  const reports = convertProjectVersionPins(fixture.recordHome, io);

  assert.deepEqual(
    reports.map((one) => [one.name, one.outcome]),
    [["dayjob", "converted"]]
  );

  const dockerfile = readFileSync(fixture.dockerfile, "utf8");
  assert.ok(dockerfile.includes("ARG RUBY_VERSION=3.4.8"), dockerfile);
  assert.ok(dockerfile.includes("FROM ruby:${RUBY_VERSION}"), dockerfile);
  assert.equal(dockerfile.includes("FROM ruby:3.4.8"), false);
  assert.ok(dockerfile.includes("RUN bundle install --quiet"), "the rest of the file is left alone");

  // The old file is kept, byte for byte - issue #355 asks for it by
  // name, and it is the only copy of what was there.
  assert.equal(readFileSync(`${fixture.dockerfile}.bak`, "utf8"), HARD_CODED_TERMS);
  assert.equal(readFileSync(`${fixture.config}.bak`, "utf8"), TERMS_CONFIG);

  assert.deepEqual(JSON.parse(readFileSync(fixture.config, "utf8")), {
    check: "sh /terms/check.sh",
    protectedPaths: ["check.sh"],
    buildArgs: { RUBY_VERSION: { file: ".ruby-version", pattern: "^(?:ruby-)?([0-9][^\\s]*)$" } },
  });

  const printed = io.out.join("\n");
  assert.match(printed, /- FROM ruby:3\.4\.8/);
  assert.match(printed, /\+ FROM ruby:\$\{RUBY_VERSION\}/);
  assert.match(printed, /\+ ARG RUBY_VERSION=3\.4\.8/);
  assert.match(printed, /kept as .*Dockerfile\.inspector\.bak/);
  assert.match(printed, /RUBY_VERSION now comes from \.ruby-version, which says 3\.4\.13/);
  assert.deepEqual(io.err, []);
});

test("converting twice is harmless: the second run finds nothing to do", () => {
  const fixture = workModeFixture();
  convertProjectVersionPins(fixture.recordHome, {});
  const converted = readFileSync(fixture.dockerfile, "utf8");

  const reports = convertProjectVersionPins(fixture.recordHome, {});

  assert.deepEqual(
    reports.map((one) => one.outcome),
    ["nothing-to-do"]
  );
  assert.equal(readFileSync(fixture.dockerfile, "utf8"), converted, "nothing is rewritten a second time");
});

test("committed terms are never written, and the replacement is printed instead", () => {
  const fixture = inRepoFixture();
  const before = readFileSync(fixture.dockerfile, "utf8");
  const io = captureIo();

  const reports = convertProjectVersionPins(fixture.recordHome, io);

  assert.deepEqual(
    reports.map((one) => one.outcome),
    ["by-hand"]
  );
  assert.equal(readFileSync(fixture.dockerfile, "utf8"), before, "a committed Dockerfile.inspector is never edited");
  assert.equal(existsSync(`${fixture.dockerfile}.bak`), false, "and nothing is left beside it either");
  assert.match(io.out.join("\n"), /committed in the repository, which Fabrica never edits/);
  assert.match(io.out.join("\n"), /ARG RUBY_VERSION=3\.4\.8/);
});

test("a terms folder with no config to declare the argument in fails on its own, naming why", () => {
  const fixture = workModeFixture({ config: null });
  const io = captureIo();

  const reports = convertProjectVersionPins(fixture.recordHome, io);

  assert.deepEqual(
    reports.map((one) => one.outcome),
    ["failed"]
  );
  assert.match(reports[0].detail, /no \.inspector\.json beside it/);
  assert.match(io.err.join("\n"), /could not be converted/);
  // And the Dockerfile is left exactly as it was: the two files are
  // written as a pair or not at all.
  assert.equal(readFileSync(fixture.dockerfile, "utf8"), HARD_CODED_TERMS);
  assert.equal(existsSync(`${fixture.dockerfile}.bak`), false);
});

test("the summary segment says how many were converted, and failures first", () => {
  assert.equal(describeVersionPinConversions([]), "no version pins to convert");
  assert.equal(
    describeVersionPinConversions([{ name: "a", outcome: "converted", changed: [], detail: "" }]),
    "1 project converted to repository version files"
  );
  assert.equal(
    describeVersionPinConversions([
      { name: "a", outcome: "converted", changed: [], detail: "" },
      { name: "b", outcome: "failed", changed: [], detail: "x" },
    ]),
    "1 version pin FAILED to convert, 1 converted"
  );
  assert.equal(
    describeVersionPinConversions([{ name: "a", outcome: "by-hand", changed: [], detail: "" }]),
    "1 project pins a version by hand (committed terms)"
  );
});

// Issue #355's own proof, end to end: terms on 3.4.8, `.ruby-version` on
// 3.4.13, one `fabrica update`, and the next image build is handed
// 3.4.13 - nothing done by hand.
test("fabrica update: terms on 3.4.8 and .ruby-version on 3.4.13 build the next image on 3.4.13", async () => {
  const fixture = workModeFixture();
  const io = captureIo();
  const builds: { image: string; args: string[] }[] = [];
  let listening = false;

  const code = await runUpdateCommand([], {
    recordHome: fixture.recordHome,
    probes: {
      copy: (): CopyInfo => ({ kind: "dev-checkout", root: "/fake/checkout", branch: "master", commit: "before000001", version: "0.0.0" }),
      isDirty: () => false,
      pull: () => ({ ok: true, message: "Fast-forward" }),
      reinstall: () => ({ ok: false, message: "must not be called" }),
      inspector: {
        build: () => null,
        mainCommit: () => null,
        ancestry: () => "unknown",
        directoryOnPath: () => null,
        install: () => ({ ok: false, message: "must not be called" }),
      },
    },
    machineImageIo: {
      // Nothing is built yet, so the one build that follows the
      // conversion is the project's own.
      stamp: () => null,
      baseUser: () => "",
      run: async (cmd) => {
        builds.push({ image: cmd.image, args: cmd.args });
        return { ok: true, detail: "" };
      },
    },
    isLiveViewListening: async () => listening,
    startLiveView: () => {
      listening = true;
    },
    liveViewStartTimeoutMs: 2_000,
    ...io,
  });

  assert.equal(code, 0, io.err.join("\n"));

  // 1. The files were converted, with nobody's hand in it.
  const dockerfile = readFileSync(fixture.dockerfile, "utf8");
  assert.ok(dockerfile.includes("FROM ruby:${RUBY_VERSION}"), dockerfile);
  assert.equal(readFileSync(`${fixture.dockerfile}.bak`, "utf8"), HARD_CODED_TERMS);
  assert.match(io.out.join("\n"), /1 project converted to repository version files/);

  // 2. The build that followed was handed 3.4.13 - the version the
  // repository declares, not the 3.4.8 the file used to carry.
  assert.equal(builds.length, 1, builds.map((one) => one.image).join(", "));
  const [build] = builds;
  const at = build.args.indexOf("RUBY_VERSION=3.4.13");
  assert.ok(at !== -1, `the build has to pass the declared version: ${build.args.join(" ")}`);
  assert.equal(build.args[at - 1], "--build-arg");

  // 3. And the Dockerfile that build was handed resolves its FROM
  // through that argument, with 3.4.8 left only as the default a build
  // passing nothing would get.
  const generated = machineDockerfileFor(machineImageForProject(fixture.recordHome, fixture.project), () => "");
  assert.ok(generated.includes("ARG RUBY_VERSION=3.4.8"), generated);
  assert.ok(generated.includes("FROM ruby:${RUBY_VERSION}"), generated);
  assert.equal(generated.includes("FROM ruby:3.4.8"), false);
});

// The stamp is what makes the box follow a bump at all: with the version
// in an argument rather than in the Dockerfile's text, an image built
// before the bump has to read as out of date afterwards.
test("bumping the version file alone makes the project's image stale", async () => {
  const fixture = workModeFixture();
  convertProjectVersionPins(fixture.recordHome, {});

  const { machineImageCurrency, machineImageStamp } = await import("../index.ts");
  const before = machineImageForProject(fixture.recordHome, fixture.project);
  const stamp = machineImageStamp(machineDockerfileFor(before, () => ""), before.buildArgs);
  assert.equal(machineImageCurrency(before, () => stamp, () => "").state, "current");

  writeFileSync(join(fixture.project, ".ruby-version"), "3.5.0\n");
  const after = machineImageForProject(fixture.recordHome, fixture.project);
  assert.deepEqual(after.buildArgs, { RUBY_VERSION: "3.5.0" });
  assert.equal(
    machineImageCurrency(after, () => stamp, () => "").state,
    "stale",
    "a bumped version file has to make the worker's box stale, not only the check box"
  );
});
