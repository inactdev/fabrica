// The knowledge base a project names, read off disk: which notes land
// in a brief, under which heading, and every refusal naming the note or
// the folder it is about. The round-level half - that this actually
// reaches the brief a Worker is handed, on every round, and refuses
// before any ProductionLine is cut - is src/foreman/task-knowledge.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KNOWLEDGE_BRIEF_HEADER,
  MAX_BRIEF_BYTES,
  readKnowledgeNotes,
  renderKnowledgeSection,
  withKnowledgeNotes,
} from "./notes.ts";
import { KnowledgeError } from "./errors.ts";

/** A throwaway knowledge base holding the given notes, by file name. */
function makeKnowledgeBase(notes: Record<string, string> = {}, opts: { notesFolder?: boolean } = {}): string {
  const base = mkdtempSync(join(tmpdir(), "fabrica-knowledge-"));
  if (opts.notesFolder !== false) mkdirSync(join(base, "notes"));
  for (const [file, text] of Object.entries(notes)) writeFileSync(join(base, "notes", file), text);
  return base;
}

function note(title: string, body: string): string {
  return `---\nname: whatever\ntitle: ${title}\n---\n\n${body}\n`;
}

test("readKnowledgeNotes: each named note, in the order it was named, titled from its front matter", () => {
  const path = makeKnowledgeBase({
    "worker-boxes.md": note("Worker boxes", "Every check runs in its own container."),
    "the-record.md": note("The record", "events.jsonl is append-only."),
  });

  const notes = readKnowledgeNotes({ path, notes: ["the-record", "worker-boxes"] });

  assert.deepEqual(notes, [
    { name: "the-record", title: "The record", body: "events.jsonl is append-only." },
    { name: "worker-boxes", title: "Worker boxes", body: "Every check runs in its own container." },
  ]);
});

test("readKnowledgeNotes: a project naming no notes reads nothing at all", () => {
  // The path is deliberately nonsense: naming no notes must not even
  // look, so a knowledge base that is merely unmounted today cannot fail
  // a task that was never going to read from it.
  assert.deepEqual(readKnowledgeNotes({ path: "/no/such/knowledge/base", notes: [] }), []);
});

test("readKnowledgeNotes: a knowledge base that is not there refuses, naming the path", () => {
  const path = join(tmpdir(), "fabrica-knowledge-does-not-exist");

  assert.throws(
    () => readKnowledgeNotes({ path, notes: ["worker-boxes"] }),
    (err: unknown) => {
      assert.ok(err instanceof KnowledgeError);
      assert.equal(err.code, "no-knowledge-base");
      assert.ok(err.message.includes(path), `message did not name the path: ${err.message}`);
      return true;
    }
  );
});

test("readKnowledgeNotes: a knowledge base with no notes/ folder refuses, naming it", () => {
  const path = makeKnowledgeBase({}, { notesFolder: false });

  assert.throws(
    () => readKnowledgeNotes({ path, notes: ["worker-boxes"] }),
    (err: unknown) => {
      assert.ok(err instanceof KnowledgeError);
      assert.equal(err.code, "no-knowledge-base");
      assert.ok(err.message.includes("notes/"), `message did not name the folder: ${err.message}`);
      return true;
    }
  );
});

test("readKnowledgeNotes: a note with no file refuses, naming which note", () => {
  const path = makeKnowledgeBase({ "worker-boxes.md": note("Worker boxes", "...") });

  assert.throws(
    () => readKnowledgeNotes({ path, notes: ["worker-boxes", "the-record"] }),
    (err: unknown) => {
      assert.ok(err instanceof KnowledgeError);
      assert.equal(err.code, "missing-note");
      assert.ok(err.message.includes('"the-record"'), `message did not name the note: ${err.message}`);
      assert.ok(err.message.includes(join(path, "notes", "the-record.md")), "message did not name the file");
      return true;
    }
  );
});

test("readKnowledgeNotes: a note with no front-matter title refuses, naming which note", () => {
  const path = makeKnowledgeBase({
    "no-front-matter.md": "Just prose, no front matter at all.\n",
    "no-title.md": "---\nname: no-title\n---\n\nProse.\n",
    "empty-title.md": "---\ntitle:\n---\n\nProse.\n",
    // A `title` nested under another key is not this note's own title -
    // the reading is deliberately narrow about that.
    "nested-title.md": "---\nmetadata:\n  title: Not the note's own\n---\n\nProse.\n",
    // Front matter that is opened and never closed is not front matter.
    "unclosed.md": "---\ntitle: Never closed\n\nProse.\n",
  });

  for (const name of ["no-front-matter", "no-title", "empty-title", "nested-title", "unclosed"]) {
    assert.throws(
      () => readKnowledgeNotes({ path, notes: [name] }),
      (err: unknown) => {
        assert.ok(err instanceof KnowledgeError, name);
        assert.equal(err.code, "missing-note-title", name);
        assert.ok(err.message.includes(`"${name}"`), `message did not name ${name}: ${err.message}`);
        return true;
      }
    );
  }
});

test("readKnowledgeNotes: a quoted title is read without its quotes", () => {
  const path = makeKnowledgeBase({
    "quoted.md": `---\ntitle: "Worker boxes: the short version"\n---\n\nProse.\n`,
    "single.md": `---\ntitle: 'Also fine'\n---\n\nProse.\n`,
  });

  assert.deepEqual(
    readKnowledgeNotes({ path, notes: ["quoted", "single"] }).map((n) => n.title),
    ["Worker boxes: the short version", "Also fine"]
  );
});

test("renderKnowledgeSection: the marker line, then each note under its own second-level heading", () => {
  const section = renderKnowledgeSection([
    { name: "a", title: "Worker boxes", body: "Body A." },
    { name: "b", title: "The record", body: "Body B." },
  ]);

  assert.equal(
    section,
    `${KNOWLEDGE_BRIEF_HEADER}\n\n## Worker boxes\n\nBody A.\n\n## The record\n\nBody B.\n`
  );
  assert.equal(renderKnowledgeSection([]), "");
});

test("withKnowledgeNotes: appended after the task's own words, exactly once", () => {
  const notes = [{ name: "a", title: "Worker boxes", body: "Body A." }];

  const brief = withKnowledgeNotes("do the thing", notes);
  assert.ok(brief.startsWith("do the thing"), "the task's own words must come first");
  assert.ok(brief.includes("## Worker boxes\n\nBody A."));

  // Idempotent, the way withIssueText is: an outer builder that already
  // added the section must not get a second copy from a nested one.
  assert.equal(withKnowledgeNotes(brief, notes), brief);
  assert.equal(brief.split(KNOWLEDGE_BRIEF_HEADER).length - 1, 1);

  // No notes, nothing added.
  assert.equal(withKnowledgeNotes("do the thing", []), "do the thing");
});

test("withKnowledgeNotes: a brief past the ceiling refuses, naming the notes and the overage", () => {
  const big = { name: "huge", title: "Huge", body: "x".repeat(MAX_BRIEF_BYTES) };
  const small = { name: "small", title: "Small", body: "y" };

  assert.throws(
    () => withKnowledgeNotes("do the thing", [small, big]),
    (err: unknown) => {
      assert.ok(err instanceof KnowledgeError);
      assert.equal(err.code, "brief-too-large");
      assert.ok(err.message.includes('"huge"'), `message did not name the big note: ${err.message}`);
      assert.ok(err.message.includes('"small"'), "message did not name every note");
      assert.ok(err.message.includes(String(MAX_BRIEF_BYTES)), "message did not name the ceiling");
      assert.match(err.message, /\d+ bytes past/, "message did not say by how much");
      return true;
    }
  );
});

test("withKnowledgeNotes: a brief that fits is handed over whole", () => {
  const body = "x".repeat(MAX_BRIEF_BYTES - 1024);
  const brief = withKnowledgeNotes("do the thing", [{ name: "big", title: "Big", body }]);
  assert.ok(brief.includes(body), "the note was shortened, which must never happen");
});
