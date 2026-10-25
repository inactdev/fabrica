// `fabrica shadow-report` (issue #204, shadow mode): the read-only
// report, and the one count line `fabrica status` shows alongside it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createForeman, SKIP_RULES_PATH } from "../index.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { makeFixtureRepo, pushToOrigin } from "../../contract/helpers/fixture.ts";
import { fakeInspector } from "../../contract/helpers/fake-inspector.ts";
import { main } from "./main.ts";
import { runShadowReportCommand, SHADOW_REPORT_HELP, SHADOW_REPORT_USAGE } from "./shadow-report-command.ts";
import { runStatusCommand } from "./status-command.ts";

const DOCS_ONLY = `version = 1

[kinds.docs-only]
description = "A documentation-only change under docs/"
mode = "shadow"
allowedFolders = ["docs"]
maxFiles = 3
inspectorGreen = true
`;

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) };
}

function projectWithRules(rules = DOCS_ONLY): string {
  const project = makeFixtureRepo("exit 0");
  mkdirSync(dirname(join(project, SKIP_RULES_PATH)), { recursive: true });
  writeFileSync(join(project, SKIP_RULES_PATH), rules);
  execFileSync("git", ["add", "-A"], { cwd: project });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "skip rules"], { cwd: project });
  pushToOrigin(project);
  return project;
}

/** A record home holding one accepted task that a skip rule would have
 * closed. */
async function homeWithOneWouldClose(rules = DOCS_ONLY): Promise<{ recordHome: string; project: string; taskId: string }> {
  const recordHome = mkdtempSync(join(tmpdir(), "fabrica-cli-shadow-"));
  const project = projectWithRules(rules);
  const foreman = createForeman({ recordHome, inspector: fakeInspector("green") });
  const task = await foreman.do("tidy the intro", {
    project,
    // src/brain's own fake hands onWork the brief first, then the
    // workdir - unlike contract/helpers/fake-brain.ts, whose onWork takes
    // the workdir alone.
    brain: fakeBrain({
      onWork: (_brief, workdir) => {
        mkdirSync(join(workdir, "docs"), { recursive: true });
        writeFileSync(join(workdir, "docs", "intro.md"), "tidier\n");
      },
    }),
  });
  await foreman.verdict(task.id, "accept", "good");
  return { recordHome, project, taskId: task.id };
}

test("fabrica shadow-report: a would-close the Client accepted is reported per project and kind", async () => {
  const { recordHome, project } = await homeWithOneWouldClose();

  const io = captureIo();
  const code = await runShadowReportCommand([], { recordHome, ...io });
  assert.equal(code, 0, io.err.join("\n"));

  const text = io.out.join("\n");
  assert.match(text, /nothing closes by rule/);
  assert.match(text, /Every task still waits on your verdict/);
  assert.ok(text.includes(project), `the project was not named:\n${text}`);
  assert.match(text, /docs-only - A documentation-only change under docs\//);
  assert.match(text, /would-close 1, accepted 1, disagreed 0, running 0 days/);
});

test("fabrica shadow-report: a record home with no skip rules anywhere says so, and still exits 0", async () => {
  const recordHome = mkdtempSync(join(tmpdir(), "fabrica-cli-shadow-none-"));
  const io = captureIo();
  assert.equal(await runShadowReportCommand([], { recordHome, ...io }), 0);
  assert.match(io.out.join("\n"), /No task has been evaluated against a skip rule yet/);
});

test('fabrica shadow-report: a mode = "live" rules file is reported as unusable, naming CONTRACT rule 6', async () => {
  const { recordHome } = await homeWithOneWouldClose(DOCS_ONLY.replace('mode = "shadow"', 'mode = "live"'));

  const io = captureIo();
  assert.equal(await runShadowReportCommand([], { recordHome, ...io }), 0);
  const text = io.out.join("\n");
  assert.match(text, /Rules files that could not be used/);
  assert.match(text, /CONTRACT rule 6/);
});

test("fabrica status opens with the same shadow counts, and says plainly that nothing closes", async () => {
  const { recordHome } = await homeWithOneWouldClose();
  const io = captureIo();
  assert.equal(await runStatusCommand([], { recordHome, ...io }), 0);
  const line = io.out.find((l) => l.startsWith("skip rules"));
  assert.ok(line, `no shadow line on fabrica status:\n${io.out.join("\n")}`);
  assert.match(line, /shadow, nothing closes/);
  assert.match(line, /1 would have closed, 1 you accepted, 0 you did not/);
});

test("fabrica status says nothing about skip rules for a record home that has none", async () => {
  const recordHome = mkdtempSync(join(tmpdir(), "fabrica-cli-shadow-none-"));
  const io = captureIo();
  await runStatusCommand([], { recordHome, ...io });
  assert.equal(
    io.out.find((l) => l.startsWith("skip rules")),
    undefined,
    "a record home with no rules file still got a skip-rules line"
  );
});

test("fabrica shadow-report refuses an argument or a flag rather than ignoring it", async () => {
  const recordHome = mkdtempSync(join(tmpdir(), "fabrica-cli-shadow-args-"));
  for (const argv of [["--json"], ["some-project"]]) {
    const io = captureIo();
    assert.equal(await runShadowReportCommand(argv, { recordHome, ...io }), 1);
    assert.match(io.err.join("\n"), new RegExp(SHADOW_REPORT_USAGE));
  }
});

test("fabrica shadow-report --help prints its own usage and exits 0", async () => {
  const io = captureIo();
  assert.equal(await main(["shadow-report", "--help"], io), 0);
  assert.equal(io.out.join("\n"), SHADOW_REPORT_HELP);
  assert.match(SHADOW_REPORT_HELP, /CONTRACT\s+rule 6/);
});
