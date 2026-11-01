// A task handed files (`fabrica do --file <path>`, issue #325): the
// copies really are in the workstation when the machine runs, the brief
// names them, nothing of them ever reaches the branch, and a file that
// has gone missing fails the round before any ProductionLine exists.
//
// Two layers, the same shape task-knowledge.test.ts has: what the record
// holds and what it refuses, then real rounds proving the files and the
// brief reach a worker - on the clarifying step, a first round, an
// answered round and a fix round, since those are the four places words
// are put in front of a brain. src/attached/ owns the placing, the git
// exclusion and the refusals themselves.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "./foreman.ts";
import { ForemanError } from "./errors.ts";
import { STANDING_QUESTION } from "./standing-question.ts";
import { attachedFilesFor, storedAttachedFiles } from "./task-files.ts";
import { ATTACHED_BRIEF_HEADER, ATTACHED_FOLDER } from "../attached/index.ts";
import { readEventsForTask, readTaskFile, writeTaskFile } from "../record/index.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { fixtureInspector } from "../../contract/helpers/fake-inspector.ts";

const POTS = "Trim at 18% moisture. Never above 1240C.\n";
const DATA = "kiln,temp\n1,1240\n";

/** A throwaway folder holding the two documents a task is handed. */
function makeDocuments(files: Record<string, string> = { "pots.md": POTS, "data.csv": DATA }): string {
  const dir = mkdtempSync(join(tmpdir(), "fabrica-task-files-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-task-files-home-"));
}

/** Collects every brief a round's worker is handed, and what it could
 * read out of the workstation's fixed subfolder at the time. */
function recordingBrain(opts: Parameters<typeof fakeBrain>[0] = {}) {
  const briefs: string[] = [];
  const seen: Record<string, string>[] = [];
  const brain = fakeBrain({
    ...opts,
    onWork: (brief, workdir) => {
      briefs.push(brief);
      seen.push(readPlaced(workdir));
      opts.onWork?.(brief, workdir);
    },
  });
  return { brain, briefs, seen };
}

/** Every file the fixed subfolder holds, by name, as the machine would
 * read them. The `.gitignore` is Fabrica's own and left out. */
function readPlaced(workdir: string): Record<string, string> {
  const folder = join(workdir, ATTACHED_FOLDER);
  const found: Record<string, string> = {};
  for (const name of ["pots.md", "data.csv", "spec.md"]) {
    const path = join(folder, name);
    if (existsSync(path)) found[name] = readFileSync(path, "utf8");
  }
  return found;
}

function git(project: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: project, encoding: "utf8" });
}

// ------------------------------------------------------------ the record

test("storedAttachedFiles: empty for a task registered before this existed", () => {
  const recordHome = freshHome();
  mkdirSync(join(recordHome, "tasks", "task-1"), { recursive: true });
  assert.deepEqual(storedAttachedFiles(recordHome, "task-1"), []);
});

test("storedAttachedFiles: a files.json nothing can parse is a ForemanError, never a quiet empty list", () => {
  const recordHome = freshHome();
  writeTaskFile(recordHome, "task-1", "files.json", "{not json");

  assert.throws(
    () => storedAttachedFiles(recordHome, "task-1"),
    (err: unknown) => {
      assert.ok(err instanceof ForemanError);
      assert.equal(err.code, "attached-unavailable");
      assert.match(err.message, /files\.json/);
      return true;
    }
  );

  writeTaskFile(recordHome, "task-1", "files.json", JSON.stringify([{ name: "pots.md" }]));
  assert.throws(
    () => storedAttachedFiles(recordHome, "task-1"),
    (err: unknown) => err instanceof ForemanError && err.code === "attached-unavailable"
  );
});

test("attachedFilesFor: a file that has gone since registration is a ForemanError naming it", () => {
  const recordHome = freshHome();
  const docs = makeDocuments({ "pots.md": POTS });
  writeTaskFile(
    recordHome,
    "task-1",
    "files.json",
    JSON.stringify([{ path: join(docs, "pots.md"), name: "pots.md", bytes: POTS.length }])
  );
  rmSync(join(docs, "pots.md"));

  assert.throws(
    () => attachedFilesFor(recordHome, "task-1"),
    (err: unknown) => {
      assert.ok(err instanceof ForemanError);
      assert.equal(err.code, "attached-unavailable");
      assert.ok(err.message.includes(join(docs, "pots.md")), `did not name the file: ${err.message}`);
      return true;
    }
  );
});

// ------------------------------------------------------------ end to end

test("every task records what it was handed, an empty list included", async () => {
  const project = makeFixtureRepo("exit 0");
  const recordHome = freshHome();
  const docs = makeDocuments();
  const { brain } = recordingBrain();
  const foreman = createForeman({ recordHome, inspector: fixtureInspector() });

  const plain = await foreman.do("rework the kiln table", { project, brain });
  assert.deepEqual(storedAttachedFiles(recordHome, plain.id), [], "a task handed nothing records an empty list");
  assert.equal(readTaskFile(recordHome, plain.id, "files.json"), "[]", "it recorded nothing at all");

  const handed = await foreman.do("rework the kiln table from the note", {
    project,
    brain,
    files: [join(docs, "pots.md"), join(docs, "data.csv")],
  });
  assert.deepEqual(storedAttachedFiles(recordHome, handed.id), [
    { path: join(docs, "pots.md"), name: "pots.md", bytes: POTS.length },
    { path: join(docs, "data.csv"), name: "data.csv", bytes: DATA.length },
  ]);
});

test("the files reach the workstation and the brief on every round, and the brief names them once", async () => {
  const project = makeFixtureRepo("exit 0");
  const recordHome = freshHome();
  const docs = makeDocuments();
  const { brain, briefs, seen } = recordingBrain({
    askQuestion: { question: "Which kiln?", options: ["The old one", "The new one"] },
    onWork: (_brief, workdir) => writeFileSync(join(workdir, "work.txt"), "a change\n"),
  });
  const foreman = createForeman({ recordHome, inspector: fixtureInspector() });

  const asked = await foreman.do("rework the kiln table from the note", {
    project,
    brain,
    files: [join(docs, "pots.md"), join(docs, "data.csv")],
  });
  assert.equal(asked.state, "asking");
  await foreman.answer(asked.id, "The new one.");
  await foreman.verdict(asked.id, "fix", "also round the temperatures");

  assert.equal(brain.askCalls.length, 1, "the clarifying step ran once");
  assert.equal(briefs.length, 2, "one answered round, one fix round");

  for (const [which, text] of [
    ["clarifying step", brain.askCalls[0]],
    ["answered round", briefs[0]],
    ["fix round", briefs[1]],
  ] as const) {
    assert.ok(text.includes(ATTACHED_BRIEF_HEADER), `the ${which} named no files`);
    assert.equal(text.split(ATTACHED_BRIEF_HEADER).length - 1, 1, `the ${which} doubled the section`);
    assert.ok(text.includes(`\`${ATTACHED_FOLDER}/pots.md\` (${POTS.length} bytes)`), `the ${which} lost pots.md`);
    assert.ok(text.includes(`\`${ATTACHED_FOLDER}/data.csv\` (${DATA.length} bytes)`), `the ${which} lost data.csv`);
    // Names and sizes, never contents: that is what the folder is for.
    assert.ok(!text.includes("1240C"), `the ${which} carried a file's contents into the brief`);
  }

  // The clarifying step has no workstation at all, so its own wording is
  // the one that must differ.
  assert.ok(brain.askCalls[0].includes("cannot read them yet"), brain.askCalls[0]);
  assert.ok(briefs[0].includes("in your working folder already"), briefs[0]);

  for (const [round, placed] of seen.entries()) {
    assert.deepEqual(placed, { "pots.md": POTS, "data.csv": DATA }, `round ${round + 1} could not read its files`);
  }
});

test("the files section sits after the task's own words and inside the standing prefix", async () => {
  const project = makeFixtureRepo("exit 0");
  const docs = makeDocuments({ "pots.md": POTS });
  const { brain, briefs } = recordingBrain();

  await createForeman({ recordHome: freshHome(), inspector: fixtureInspector() }).do("rework the kiln table", {
    project,
    brain,
    files: [join(docs, "pots.md")],
  });

  const brief = briefs[0];
  assert.ok(brief.startsWith(STANDING_QUESTION), "rule 11: every brief still opens with the standing question");
  assert.ok(
    brief.indexOf("rework the kiln table") < brief.indexOf(ATTACHED_BRIEF_HEADER),
    "the files must be named after the task's own words"
  );
});

test("nothing of the files reaches the branch, and the folder is gone before the commit", async () => {
  const project = makeFixtureRepo("exit 0");
  const recordHome = freshHome();
  const docs = makeDocuments();
  let workdirDuringWork: string | undefined;
  const { brain } = recordingBrain({
    onWork: (_brief, workdir) => {
      workdirDuringWork = workdir;
      writeFileSync(join(workdir, "work.txt"), "a change\n");
    },
  });

  const task = await createForeman({ recordHome, inspector: fixtureInspector() }).do("rework the kiln table", {
    project,
    brain,
    files: [join(docs, "pots.md"), join(docs, "data.csv")],
  });

  // The branch outlives the worktree, so it is where the proof has to be
  // read: whatever is committed there is what a reviewer and Inspector
  // see, and what a merge would carry.
  const committed = git(project, "ls-tree", "-r", "--name-only", `fabrica/${task.id}`).trim().split("\n");
  assert.ok(committed.includes("work.txt"), `the machine's own change is missing: ${committed.join(", ")}`);
  for (const name of committed) {
    assert.ok(!name.startsWith(`${ATTACHED_FOLDER}/`), `a handed file reached the branch: ${name}`);
  }
  assert.ok(!committed.includes(`${ATTACHED_FOLDER}/.gitignore`), "the exclusion file itself was committed");

  // And the worktree the files sat in is torn down at the end of a round
  // either way, so "removed before the commit" is read off the delivery's
  // own file list rather than off a folder that no longer exists.
  const delivery = await createForeman({ recordHome }).deliveryOf(task.id);
  assert.ok(delivery !== null, "no delivery was recorded");
  for (const file of delivery!.files) {
    assert.ok(!file.startsWith(`${ATTACHED_FOLDER}/`), `the delivery reports a handed file as changed: ${file}`);
  }
  assert.equal(existsSync(workdirDuringWork!), false, "the workstation outlived the round");
});

test("a file that cannot be read fails the task at registration, before anything spends", async () => {
  const project = makeFixtureRepo("exit 0");
  const recordHome = freshHome();
  const docs = makeDocuments({ "pots.md": POTS });
  const missing = join(docs, "no-such-note.md");
  const { brain, briefs } = recordingBrain();
  let taskId: string | undefined;

  const foreman = createForeman({
    recordHome,
    inspector: fixtureInspector(),
    onTaskRegistered: (id) => {
      taskId = id;
    },
  });

  await assert.rejects(
    () => foreman.do("rework the kiln table", { project, brain, files: [join(docs, "pots.md"), missing] }),
    (err: unknown) => {
      assert.ok(err instanceof ForemanError);
      assert.equal(err.code, "attached-unavailable");
      assert.ok(err.message.includes(missing), `did not name the path: ${err.message}`);
      return true;
    }
  );

  assert.equal(briefs.length, 0, "no worker ever ran");
  assert.equal(brain.askCalls.length, 0, "it refused before the clarifying step spent anything");
  const names = readEventsForTask(recordHome, taskId!).map((event) => event.name);
  assert.ok(!names.includes("line-cut"), `a line was cut anyway: ${names.join(", ")}`);
  assert.ok(names.includes("task-failed"), "the record must say the task failed");
});

test("a file moved between rounds fails the fix round before the line is reopened", async () => {
  const project = makeFixtureRepo("exit 0");
  const recordHome = freshHome();
  const docs = makeDocuments({ "pots.md": POTS });
  const { brain, briefs } = recordingBrain({
    onWork: (_brief, workdir) => writeFileSync(join(workdir, "work.txt"), "a change\n"),
  });
  const foreman = createForeman({ recordHome, inspector: fixtureInspector() });

  const task = await foreman.do("rework the kiln table", { project, brain, files: [join(docs, "pots.md")] });
  assert.equal(briefs.length, 1, "the first round ran");

  rmSync(join(docs, "pots.md"));

  await assert.rejects(
    () => foreman.verdict(task.id, "fix", "also round the temperatures"),
    (err: unknown) => {
      assert.ok(err instanceof ForemanError);
      assert.equal(err.code, "attached-unavailable");
      assert.ok(err.message.includes(join(docs, "pots.md")), `did not name the file: ${err.message}`);
      return true;
    }
  );
  assert.equal(briefs.length, 1, "the fix round's worker ran without its files");
});

test("a document corrected between rounds is read again, not frozen at registration", async () => {
  const project = makeFixtureRepo("exit 0");
  const recordHome = freshHome();
  const docs = makeDocuments({ "pots.md": "The first wording.\n" });
  const { brain, seen } = recordingBrain({
    onWork: (_brief, workdir) => writeFileSync(join(workdir, "work.txt"), `v${seen.length}\n`),
  });
  const foreman = createForeman({ recordHome, inspector: fixtureInspector() });

  const task = await foreman.do("rework the kiln table", { project, brain, files: [join(docs, "pots.md")] });
  writeFileSync(join(docs, "pots.md"), "The corrected wording.\n");
  await foreman.verdict(task.id, "fix", "one more pass");

  assert.equal(seen[0]["pots.md"], "The first wording.\n");
  assert.equal(seen[1]["pots.md"], "The corrected wording.\n", "the fix round was handed a stale copy");
});
