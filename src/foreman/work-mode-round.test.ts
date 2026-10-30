// Work mode wired into a round (issue #316). Three settings, and what
// each one actually changes about the round: Inspector is chosen for a
// repository carrying none of its files, the handoff makes none of the
// in-repo config checks, the terms folder gets its own refusal, and the
// pull request body is the repository's own template while the commit
// message is not.
//
// Layered like src/foreman/inspector-config.test.ts: the gates and the
// renderers have their own unit tests (src/inspector/terms.test.ts,
// src/foreman/pr-template.test.ts), and these prove the wiring - where
// an unwired setting would be a feature that tests green and does
// nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { makeTestHome } from "../config/helpers/test-home.ts";
import { INSPECTOR_DOCKERFILE } from "../inspector/index.ts";
import type { Inspection, Inspector } from "../inspector/index.ts";
import { readEventsForTask } from "../record/index.ts";
import { ForemanError } from "./errors.ts";
import { prepareRound, withPullRequestMessage } from "./judge.ts";
import { finalMessageFor } from "./pr-body.ts";
import { PULL_REQUEST_TEMPLATE_PATH } from "./pr-template.ts";
import type { ProductionLine } from "../../contract/surface.ts";
import type { WorkerWriteup } from "../brain/index.ts";

const WRITEUP: WorkerWriteup = {
  title: "Add retries",
  why: "The push kept dropping.",
  what: "Retried the push three times.",
  how: "A loop in push.ts, plus a test.",
  outsideChanges: "None.",
  confidence: 85,
  assumptions: "Three retries is enough.",
  expectedOutcomes: "No more dropped pushes.",
  deviations: "None.",
  quiz: [
    { question: "What changed?", answer: "The push retries." },
    { question: "Why?", answer: "It kept dropping." },
    { question: "What should the owner watch?", answer: "The retry count." },
  ],
};

/** An Inspector that records the whole request, so a test can prove
 * what the handoff asked for - not just which branch. */
function recordingInspector(verdict: Inspection["verdict"] = "green"): {
  inspector: Inspector;
  calls: { branch: string; prTitle?: string; prBody?: string }[];
} {
  const calls: { branch: string; prTitle?: string; prBody?: string }[] = [];
  return {
    calls,
    inspector: {
      installed: () => true,
      async inspect(request) {
        calls.push({
          branch: request.branch,
          ...(request.prTitle === undefined ? {} : { prTitle: request.prTitle }),
          ...(request.prBody === undefined ? {} : { prBody: request.prBody }),
        });
        return { verdict, report: `fake Inspector: ${verdict}` };
      },
    },
  };
}

/** A terms folder Inspector would accept, outside any repository. */
function termsFolder(config = '{"check":"./check.sh"}\n'): string {
  const terms = mkdtempSync(join(tmpdir(), "fabrica-work-terms-"));
  writeFileSync(join(terms, ".inspector.json"), config);
  writeFileSync(join(terms, INSPECTOR_DOCKERFILE), "FROM alpine\n");
  writeFileSync(join(terms, "check.sh"), "#!/bin/sh\nexit 0\n");
  return terms;
}

/** The repository work mode is for: nothing of Fabrica's in it, not even
 * a check script. */
function companyRepo(): { project: string; baseCommit: string } {
  const project = makeFixtureRepo("exit 0", { inspector: false });
  execFileSync("rm", ["-f", join(project, "check.sh")]);
  execFileSync("git", ["add", "-A"], { cwd: project });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "no fabrica files"], {
    cwd: project,
  });
  return { project, baseCommit: head(project) };
}

function head(dir: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
}

function commitTemplate(project: string, template: string): string {
  mkdirSync(join(project, dirname(PULL_REQUEST_TEMPLATE_PATH)), { recursive: true });
  writeFileSync(join(project, PULL_REQUEST_TEMPLATE_PATH), template);
  execFileSync("git", ["add", "-A"], { cwd: project });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "template"], { cwd: project });
  return head(project);
}

function workModeHome(project: string, settings: string): string {
  return makeTestHome(`
    [projects.dayjob]
    path = ${JSON.stringify(project)}
    check = "bin/ci"
    ${settings}
  `);
}

function lineAt(project: string, recordHome: string): ProductionLine {
  return { workdir: project, branch: "fabrica/task-1", project, taskId: "task-1", recordHome };
}

/** Puts an executable named `inspector` on this process's PATH so
 * `defaultInspector().installed()` answers true and `prepareRound` takes
 * the Inspector branch with no caller-supplied fake - which is the only
 * way the terms-folder gate is reached at all. Never run by these
 * tests: the gate refuses, or `prepare()` does, before any handoff. */
function installFakeInspectorBinary(): void {
  const bin = join(makeTestHome(""), "bin");
  mkdirSync(bin, { recursive: true });
  const path = join(bin, "inspector");
  writeFileSync(path, "#!/bin/sh\nexit 2\n");
  chmodSync(path, 0o755);
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
}

test("prepareRound: a project whose terms live outside its repository is an Inspector project", () => {
  const { project, baseCommit } = companyRepo();
  const recordHome = workModeHome(project, `terms = ${JSON.stringify(termsFolder())}`);

  const { mode } = prepareRound(recordHome, "task-1", lineAt(project, recordHome), baseCommit, {
    inspector: recordingInspector().inspector,
  });

  // Without the setting this same repository is self-tested, and would
  // then be refused for having no check script to run.
  assert.equal(mode.mode, "inspector");
});

test("prepareRound: the same repository with no terms setting is self-tested, exactly as before", () => {
  const { project, baseCommit } = companyRepo();
  const recordHome = workModeHome(project, "");

  const { mode } = prepareRound(recordHome, "task-1", lineAt(project, recordHome), baseCommit, {
    inspector: recordingInspector().inspector,
    checkBox: async () => ({ ran: true, exitCode: 0, output: "" }),
  });

  assert.equal(mode.mode, "self-test");
  assert.equal(mode.mode === "self-test" ? mode.reason : "", "no .inspector.json at the task base commit");
});

test("the handoff makes none of the in-repo .inspector.json checks for an outside-terms project", async () => {
  const { project, baseCommit } = companyRepo();
  const recordHome = workModeHome(project, `terms = ${JSON.stringify(termsFolder())}`);
  const { inspector, calls } = recordingInspector();

  const { judge } = prepareRound(recordHome, "task-1", lineAt(project, recordHome), baseCommit, { inspector });
  const judgement = await judge(1, undefined, finalMessageFor(WRITEUP, "fabrica: task-1"));

  assert.equal(calls.length, 1, "Inspector must actually have been called");
  assert.equal(judgement.kind, "verdict");
  const names = readEventsForTask(recordHome, "task-1").map((event) => event.name);
  assert.ok(names.includes("inspector-called"));
  assert.ok(!names.includes("inspection-skipped"), "nothing may be skipped for a config that is not in the repo");
});

test("the record says this handoff took its terms from outside the repository", async () => {
  const { project, baseCommit } = companyRepo();
  const recordHome = workModeHome(project, `terms = ${JSON.stringify(termsFolder())}`);

  const { judge } = prepareRound(recordHome, "task-1", lineAt(project, recordHome), baseCommit, {
    inspector: recordingInspector().inspector,
  });
  await judge(1, undefined, finalMessageFor(WRITEUP, "fabrica: task-1"));

  const called = readEventsForTask(recordHome, "task-1").find((event) => event.name === "inspector-called");
  assert.deepEqual(called?.details, { branch: "fabrica/task-1", outsideTerms: true });
});

test("prepareRound: a terms folder Inspector would refuse stops the round before any worker", () => {
  installFakeInspectorBinary();
  const { project, baseCommit } = companyRepo();
  const missing = join(mkdtempSync(join(tmpdir(), "fabrica-work-no-terms-")), "nope");
  const recordHome = workModeHome(project, `terms = ${JSON.stringify(missing)}`);

  assert.throws(
    () => prepareRound(recordHome, "task-1", lineAt(project, recordHome), baseCommit, {}),
    (err: unknown) => {
      assert.ok(err instanceof ForemanError);
      assert.equal(err.code, "inspector-config-refused");
      assert.match(err.message, /names a folder that is not there/);
      assert.match(err.message, /Nothing was started/);
      return true;
    }
  );
});

test("prepareRound: a usable terms folder clears the configuration gate", () => {
  installFakeInspectorBinary();
  const { project, baseCommit } = companyRepo();
  const recordHome = workModeHome(project, `terms = ${JSON.stringify(termsFolder())}`);

  // This fixture's origin is a local bare mirror, so the publishing
  // token's own gate refuses it (`inspector-not-ready`, no github.com
  // repository to mint for) exactly as it would for any fixture - which
  // is itself the proof that the configuration gate before it let this
  // project through.
  assert.throws(
    () => prepareRound(recordHome, "task-1", lineAt(project, recordHome), baseCommit, {}),
    (err: unknown) => {
      assert.ok(err instanceof ForemanError);
      assert.equal(err.code, "inspector-not-ready");
      return true;
    }
  );
});

test("the pull request body is the repository's own template, while the commit message is not", async () => {
  const { project } = companyRepo();
  const baseCommit = commitTemplate(project, "## Motivation\n\n<!-- why -->\n\n## Changes\n");
  const recordHome = workModeHome(project, `terms = ${JSON.stringify(termsFolder())}\npullRequestTemplate = true`);
  const { inspector, calls } = recordingInspector();

  const message = finalMessageFor(WRITEUP, "fabrica: task-1");
  const { judge } = prepareRound(recordHome, "task-1", lineAt(project, recordHome), baseCommit, { inspector });
  await judge(1, undefined, message);

  // Under the template's own headings, after whatever the template had
  // there - an instruction to the author is not thrown away.
  assert.match(calls[0].prBody!, /^## Motivation\n\n<!-- why -->\n\nThe push kept dropping\./);
  assert.match(calls[0].prBody!, /## Changes\n\nA loop in push\.ts, plus a test\./);
  assert.match(calls[0].prBody!, /## Notes\n/);
  assert.equal(calls[0].prTitle, "Add retries");
  // The commit message this round already wrote is untouched by any of
  // it - the four-section rendering, on every project.
  assert.match(message.body, /^## Context \(Why\)\n/);
});

test("a project that asks for its repository's template and has none publishes the ordinary body", async () => {
  const { project, baseCommit } = companyRepo();
  const recordHome = workModeHome(project, `terms = ${JSON.stringify(termsFolder())}\npullRequestTemplate = true`);
  const { inspector, calls } = recordingInspector();

  const { judge } = prepareRound(recordHome, "task-1", lineAt(project, recordHome), baseCommit, { inspector });
  await judge(1, undefined, finalMessageFor(WRITEUP, "fabrica: task-1"));

  assert.match(calls[0].prBody!, /^## Context \(Why\)\n/);
});

test("a project that does not ask for its template gets the ordinary body even when it has one", async () => {
  const { project } = companyRepo();
  const baseCommit = commitTemplate(project, "## Motivation\n");
  const recordHome = workModeHome(project, `terms = ${JSON.stringify(termsFolder())}`);
  const { inspector, calls } = recordingInspector();

  const { judge } = prepareRound(recordHome, "task-1", lineAt(project, recordHome), baseCommit, { inspector });
  await judge(1, undefined, finalMessageFor(WRITEUP, "fabrica: task-1"));

  assert.match(calls[0].prBody!, /^## Context \(Why\)\n/);
  assert.doesNotMatch(calls[0].prBody!, /## Notes/);
});

// A rebase-only fix round's pull request text is this round's one
// section appended to the body the pull request already had
// (rebase-only.ts), which is not a rendering of any write-up - so the
// template has nothing to re-render and the mapped body must stand.
test("a judge wrapper's own pull request body wins over the project's template", async () => {
  const { project } = companyRepo();
  const baseCommit = commitTemplate(project, "## Motivation\n");
  const recordHome = workModeHome(project, `terms = ${JSON.stringify(termsFolder())}\npullRequestTemplate = true`);
  const { inspector, calls } = recordingInspector();

  const { judge } = prepareRound(recordHome, "task-1", lineAt(project, recordHome), baseCommit, { inspector });
  const wrapped = withPullRequestMessage(judge, (message) => ({
    title: message.title,
    body: "the body this pull request already had\n\n### Rebase round",
  }));
  await wrapped(1, undefined, finalMessageFor(WRITEUP, "fabrica: task-1"));

  assert.equal(calls[0].prBody, "the body this pull request already had\n\n### Rebase round");
});
