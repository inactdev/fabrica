// How a brief names a task's files: by name and size, never by
// contents, and once however many builders wrap it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ATTACHED_BRIEF_HEADER, renderAttachedSection, withAttachedFiles } from "./brief.ts";
import { ATTACHED_FOLDER } from "./place.ts";
import type { AttachedFile } from "./types.ts";

const POTS: AttachedFile = { path: "/home/ari/notes/pots.md", name: "pots.md", bytes: 1842 };
const DATA: AttachedFile = { path: "/tmp/kiln/data.csv", name: "data.csv", bytes: 90112 };

test("renderAttachedSection: empty for no files", () => {
  assert.equal(renderAttachedSection([], { placed: true }), "");
});

test("renderAttachedSection: one line per file, with its workstation path and size", () => {
  const section = renderAttachedSection([POTS, DATA], { placed: true });

  assert.ok(section.startsWith(ATTACHED_BRIEF_HEADER), "the section does not open with its marker");
  assert.ok(section.includes(`- \`${ATTACHED_FOLDER}/pots.md\` (1842 bytes)`), section);
  assert.ok(section.includes(`- \`${ATTACHED_FOLDER}/data.csv\` (90112 bytes)`), section);
  assert.ok(
    section.indexOf("pots.md") < section.indexOf("data.csv"),
    "the files must be named in the order they were handed over"
  );
});

test("renderAttachedSection: the host path is never named - only the name inside the box", () => {
  const section = renderAttachedSection([POTS], { placed: true });
  assert.ok(!section.includes("/home/ari/notes"), `it leaked the host path: ${section}`);
});

test("renderAttachedSection: a placed round says the files are there; the clarifying step says they are not yet", () => {
  const placed = renderAttachedSection([POTS], { placed: true });
  const unplaced = renderAttachedSection([POTS], { placed: false });

  assert.ok(placed.includes("in your working folder already"), placed);
  // The one thing the Client ruled a machine must be told, so it is
  // asserted rather than left to read well.
  assert.ok(placed.includes("copy it to the real path"), `a placed brief must say how a file lands in the repo: ${placed}`);
  assert.ok(unplaced.includes("cannot read them yet"), unplaced);
  assert.ok(!unplaced.includes("in your working folder already"), unplaced);
});

test("withAttachedFiles: untouched for no files", () => {
  assert.equal(withAttachedFiles("do the thing", [], { placed: true }), "do the thing");
});

test("withAttachedFiles: the section comes after the task's own words", () => {
  const brief = withAttachedFiles("do the thing", [POTS], { placed: true });
  assert.ok(brief.indexOf("do the thing") < brief.indexOf(ATTACHED_BRIEF_HEADER));
});

test("withAttachedFiles: idempotent - a brief already carrying the section is untouched", () => {
  const once = withAttachedFiles("do the thing", [POTS], { placed: true });
  const twice = withAttachedFiles(once, [POTS], { placed: true });

  assert.equal(twice, once);
  assert.equal(twice.split(ATTACHED_BRIEF_HEADER).length - 1, 1, "it doubled the section");
});
