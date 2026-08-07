// End-to-end proof for issue #13's own bar: "a manual edit triggers the
// event." A separate file from main.test.ts on purpose — it exercises the
// same `main()`, just the off-the-books check this file wires in, so it
// never touches main.test.ts's existing assertions.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { readEvents } from "../record/index.ts";
import { main } from "./main.ts";

function tempRecordHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-main-offbooks-"));
}

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) };
}

function registerProject(recordHome: string, name: string, path: string): void {
  writeFileSync(join(recordHome, "projects.toml"), `[projects.${name}]\npath = "${path}"\n`);
}

test("main: a hand edit to a registered project is caught and recorded by the next command run", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo();
  registerProject(recordHome, "spending-app", project);

  // First run just establishes the baseline — nothing to compare against yet.
  await main(["--help"], captureIo(), { recordHome });
  assert.deepEqual(readEvents(recordHome).filter((e) => e.name === "unattributed-change"), []);

  // The Client (or an agent bypassing Fabrica) edits a file by hand — no
  // task, no fabrica command, just a direct write to the checkout.
  writeFileSync(join(project, "app.txt"), "edited by hand, outside any fabrica task\n");

  // The very next fabrica command run — any command — notices it.
  const code = await main(["--help"], captureIo(), { recordHome });
  assert.equal(code, 0);

  const events = readEvents(recordHome).filter((e) => e.name === "unattributed-change");
  assert.equal(events.length, 1);
  const details = events[0].details as { project: string; files: string[] };
  assert.equal(details.project, "spending-app");
  assert.deepEqual(details.files, ["app.txt"]);
});

test("main: an untouched registered project stays quiet across repeated command runs", async () => {
  const recordHome = tempRecordHome();
  const project = makeFixtureRepo();
  registerProject(recordHome, "spending-app", project);

  await main(["--help"], captureIo(), { recordHome });
  await main(["--help"], captureIo(), { recordHome });
  await main(["--help"], captureIo(), { recordHome });

  assert.deepEqual(readEvents(recordHome).filter((e) => e.name === "unattributed-change"), []);
});

test("main: no registered projects at all never throws and never fires", async () => {
  const recordHome = tempRecordHome();
  const code = await main(["--help"], captureIo(), { recordHome });
  assert.equal(code, 0);
  assert.deepEqual(readEvents(recordHome), []);
});
