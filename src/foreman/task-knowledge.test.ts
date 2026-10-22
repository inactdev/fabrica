// A project naming knowledge-base notes in projects.toml: the notes'
// own words reach every brief on that project, under their own titles,
// and a knowledge base or note that cannot be read fails the task before
// any ProductionLine exists.
//
// Two layers, the same way touched-tests.test.ts has two: the resolution
// itself (which projects.toml entry yields which notes), and real rounds
// proving the text actually reaches the brief a worker is handed - on the
// clarifying step, a first round, an answered round and a fix round,
// since those are the four places words are put in front of a brain.
// src/knowledge/notes.test.ts owns the reading and the refusals
// themselves.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForeman } from "./foreman.ts";
import { ForemanError } from "./errors.ts";
import { STANDING_QUESTION } from "./standing-question.ts";
import { knowledgeNotesFor, withKnowledge } from "./task-knowledge.ts";
import { KNOWLEDGE_BRIEF_HEADER, MAX_BRIEF_BYTES } from "../knowledge/index.ts";
import { readEventsForTask } from "../record/index.ts";
import { fakeBrain } from "../brain/helpers/fake-brain.ts";
import { makeFixtureRepo } from "../../contract/helpers/fixture.ts";
import { fixtureInspector } from "../../contract/helpers/fake-inspector.ts";

const BOXES = "Every check runs in the project's own container, never on the host.";
const RECORD = "events.jsonl is append-only: a mistake is corrected by a later event.";

/** A throwaway knowledge base with two real notes in it. */
function makeKnowledgeBase(notes: Record<string, string> = { "worker-boxes": BOXES, "the-record": RECORD }): string {
  const base = mkdtempSync(join(tmpdir(), "fabrica-knowledge-base-"));
  mkdirSync(join(base, "notes"));
  const titles: Record<string, string> = { "worker-boxes": "Worker boxes", "the-record": "The record" };
  for (const [name, body] of Object.entries(notes)) {
    writeFileSync(
      join(base, "notes", `${name}.md`),
      `---\nname: ${name}\ntitle: ${titles[name] ?? name}\nmetadata:\n  type: project\n---\n\n${body}\n`
    );
  }
  return base;
}

function freshHome(projectsToml?: string): string {
  const recordHome = mkdtempSync(join(tmpdir(), "fabrica-knowledge-home-"));
  if (projectsToml !== undefined) writeFileSync(join(recordHome, "projects.toml"), projectsToml);
  return recordHome;
}

/** A record home whose single project names these notes from `base`. */
function homeNaming(project: string, base: string, notes: string[]): string {
  return freshHome(
    `[projects.demo]\npath = "${project}"\ncheck = "./check.sh"\n\n` +
      `[projects.demo.knowledge]\npath = "${base}"\nnotes = ${JSON.stringify(notes)}\n`
  );
}

/** Collects every brief a round's worker is actually handed. */
function recordingBrain(opts: Parameters<typeof fakeBrain>[0] = {}) {
  const briefs: string[] = [];
  const brain = fakeBrain({ ...opts, onWork: (brief) => briefs.push(brief) });
  return { brain, briefs };
}

function branchExists(project: string, branch: string): boolean {
  const out = execFileSync("git", ["branch", "--list", branch], { cwd: project, encoding: "utf8" });
  return out.trim().length > 0;
}

test("knowledgeNotesFor: nothing for a project that names no knowledge base, or is not registered", () => {
  const project = makeFixtureRepo("exit 0");

  assert.deepEqual(knowledgeNotesFor(freshHome(), project), [], "no projects.toml at all");
  assert.deepEqual(
    knowledgeNotesFor(freshHome(`[projects.demo]\npath = "${project}"\ncheck = "./check.sh"\n`), project),
    [],
    "a registered project that named no knowledge base"
  );
});

test("knowledgeNotesFor: the named notes, in order, with their own titles", () => {
  const project = makeFixtureRepo("exit 0");
  const base = makeKnowledgeBase();

  assert.deepEqual(knowledgeNotesFor(homeNaming(project, base, ["the-record", "worker-boxes"]), project), [
    { name: "the-record", title: "The record", body: RECORD },
    { name: "worker-boxes", title: "Worker boxes", body: BOXES },
  ]);
});

test("knowledgeNotesFor: a note that cannot be read is a ForemanError naming it", () => {
  const project = makeFixtureRepo("exit 0");
  const base = makeKnowledgeBase();

  assert.throws(
    () => knowledgeNotesFor(homeNaming(project, base, ["worker-boxes", "no-such-note"]), project),
    (err: unknown) => {
      assert.ok(err instanceof ForemanError);
      assert.equal(err.code, "knowledge-unavailable");
      assert.ok(err.message.includes('"no-such-note"'), `did not name the note: ${err.message}`);
      return true;
    }
  );

  assert.throws(
    () => knowledgeNotesFor(homeNaming(project, join(tmpdir(), "fabrica-no-knowledge-base"), ["worker-boxes"]), project),
    (err: unknown) => err instanceof ForemanError && err.code === "knowledge-unavailable"
  );
});

test("withKnowledge: a brief past the ceiling is a ForemanError, not a trimmed note", () => {
  assert.throws(
    () => withKnowledge("do the thing", [{ name: "huge", title: "Huge", body: "x".repeat(MAX_BRIEF_BYTES) }]),
    (err: unknown) => {
      assert.ok(err instanceof ForemanError);
      assert.equal(err.code, "knowledge-unavailable");
      assert.match(err.message, /bytes past/);
      return true;
    }
  );
});

// ------------------------------------------------------------ end to end

test("the named notes reach the clarifying step and every round's brief, in full and once", async () => {
  const project = makeFixtureRepo("exit 0");
  const base = makeKnowledgeBase();
  const recordHome = homeNaming(project, base, ["worker-boxes", "the-record"]);
  const { brain, briefs } = recordingBrain({ askQuestions: ["Which parser?"] });
  const foreman = createForeman({ recordHome, inspector: fixtureInspector() });

  const asked = await foreman.do("rework the parser", { project, brain });
  assert.equal(asked.state, "asking");
  await foreman.answer(asked.id, "The JSON one.");
  await foreman.verdict(asked.id, "fix", "also handle the empty case");

  assert.equal(brain.askCalls.length, 1, "the clarifying step ran once");
  assert.equal(briefs.length, 2, "one answered round, one fix round");
  for (const [which, text] of [
    ["clarifying step", brain.askCalls[0]],
    ["answered round", briefs[0]],
    ["fix round", briefs[1]],
  ] as const) {
    assert.ok(text.includes(KNOWLEDGE_BRIEF_HEADER), `the ${which} carried no knowledge section`);
    assert.equal(text.split(KNOWLEDGE_BRIEF_HEADER).length - 1, 1, `the ${which} doubled the section`);
    assert.ok(text.includes(`## Worker boxes\n\n${BOXES}`), `the ${which} lost the first note's words`);
    assert.ok(text.includes(`## The record\n\n${RECORD}`), `the ${which} lost the second note's words`);
    // The note's own front matter is metadata, not words for a worker:
    // its title is already the heading above the body.
    assert.ok(!text.includes("type: project"), `the ${which} carried the note's front matter`);
  }
});

test("a note's words sit after the task's own and inside the standing prefix", async () => {
  const project = makeFixtureRepo("exit 0");
  const recordHome = homeNaming(project, makeKnowledgeBase(), ["worker-boxes"]);
  const { brain, briefs } = recordingBrain();

  await createForeman({ recordHome, inspector: fixtureInspector() }).do("rework the parser", { project, brain });

  const brief = briefs[0];
  assert.ok(brief.startsWith(STANDING_QUESTION), "rule 11: every brief still opens with the standing question");
  assert.ok(
    brief.indexOf("rework the parser") < brief.indexOf(KNOWLEDGE_BRIEF_HEADER),
    "the notes must come after the task's own words"
  );
});

test("a project whose named note is gone fails the task before any ProductionLine is cut", async () => {
  const project = makeFixtureRepo("exit 0");
  const recordHome = homeNaming(project, makeKnowledgeBase(), ["worker-boxes", "no-such-note"]);
  const { brain, briefs } = recordingBrain();
  let taskId: string | undefined;

  // The registered id is taken from createForeman's own hook, which is
  // where this Foreman reads it from (foreman.ts), so the record can be
  // read back for a task that never got far enough to be returned.
  const foreman = createForeman({
    recordHome,
    inspector: fixtureInspector(),
    onTaskRegistered: (id) => {
      taskId = id;
    },
  });

  await assert.rejects(
    () => foreman.do("rework the parser", { project, brain }),
    (err: unknown) => {
      assert.ok(err instanceof ForemanError);
      assert.equal(err.code, "knowledge-unavailable");
      assert.ok(err.message.includes('"no-such-note"'));
      return true;
    }
  );

  assert.equal(briefs.length, 0, "no worker ever ran");
  assert.equal(brain.askCalls.length, 0, "it refused before the clarifying step spent anything");
  const events = readEventsForTask(recordHome, taskId!);
  const names = events.map((e) => e.name);
  assert.ok(!names.includes("line-cut"), `a line was cut anyway: ${names.join(", ")}`);
  assert.ok(names.includes("task-failed"), "the record must say the task failed");
  assert.ok(!branchExists(project, `fabrica/${taskId}`), "a branch was left behind");
});

test("a note corrected between rounds is read again, not frozen at registration", async () => {
  const project = makeFixtureRepo("exit 0");
  const base = makeKnowledgeBase({ "worker-boxes": "The first wording." });
  const recordHome = homeNaming(project, base, ["worker-boxes"]);
  const briefs: string[] = [];
  let version = 0;
  const brain = fakeBrain({
    onWork: (brief, workdir) => {
      briefs.push(brief);
      writeFileSync(join(workdir, "work.txt"), `v${++version}\n`);
    },
  });
  const foreman = createForeman({ recordHome, inspector: fixtureInspector() });

  const task = await foreman.do("rework the parser", { project, brain });
  writeFileSync(
    join(base, "notes", "worker-boxes.md"),
    "---\ntitle: Worker boxes\n---\n\nThe corrected wording.\n"
  );
  await foreman.verdict(task.id, "fix", "one more pass");

  assert.ok(briefs[0].includes("The first wording."));
  assert.ok(briefs[1].includes("The corrected wording."), "the fix round read a stale copy");
  assert.ok(!briefs[1].includes("The first wording."), "the fix round carried both wordings");
});
