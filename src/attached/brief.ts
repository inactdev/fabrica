// How a brief names a task's files (issue #325: "the brief names
// them").
//
// Names and sizes only - never a file's contents. A document handed to a
// task is handed over as a file precisely so it does not have to be
// pasted into the task text, and reading it is the machine's own job
// once it is in the workstation.
//
// Two renderings, one header. The work's brief says the files are
// already there; the clarifying step's says they will be, because that
// step runs before any ProductionLine exists and has no workstation to
// read them from (src/foreman/ask.ts). The step still hears about them,
// for the same reason it hears the issue's words and the project's
// knowledge notes: it is deciding whether the task is clear, and "there
// is a data file for this" is part of the answer.

import { ATTACHED_FOLDER } from "./place.ts";
import type { AttachedFile } from "./types.ts";

/** The marker line the files section opens with. Also what
 * `withAttachedFiles` keys on, so a brief that already carries the
 * section is never given it twice. */
export const ATTACHED_BRIEF_HEADER = "Files this task was handed, by name and size:";

/** What the brief says about the fixed subfolder once the files are
 * actually in it - including the one thing the Client ruled a machine
 * must be told: a file that is meant to end up in the repository has to
 * be copied to its real path, because nothing in this folder is ever
 * committed. */
const PLACED_NOTICE =
  `They are in your working folder already, at exactly those paths. That folder is excluded from git for ` +
  `this run and is removed before your work is committed, so nothing inside it is ever part of the change ` +
  `you deliver. If this task asks for one of these files to land in the repository, copy it to the real ` +
  `path it belongs at and leave that copy there - it is committed like any other change you make.`;

/** And what it says before any workstation exists. */
const UNPLACED_NOTICE =
  `They will be in your working folder at exactly those paths once the work starts. You cannot read them ` +
  `yet, so answer only from what the task itself says.`;

/** The section a brief carries these files as: the marker line, then one
 * line per file giving its path inside the workstation and its size.
 * Empty string for no files. */
export function renderAttachedSection(files: AttachedFile[], opts: { placed: boolean }): string {
  if (files.length === 0) return "";
  const lines = files.map((file) => `- \`${ATTACHED_FOLDER}/${file.name}\` (${file.bytes} bytes)`);
  return `${ATTACHED_BRIEF_HEADER}\n\n${lines.join("\n")}\n\n${opts.placed ? PLACED_NOTICE : UNPLACED_NOTICE}\n`;
}

/**
 * `briefText` with those files appended as their own section, after the
 * task's own words.
 *
 * Idempotent, like `withIssueText` and `withKnowledgeNotes`: a brief
 * that already carries the section comes back untouched, so a nested
 * builder can never double it. A no-op for a task with no files.
 */
export function withAttachedFiles(briefText: string, files: AttachedFile[], opts: { placed: boolean }): string {
  if (files.length === 0) return briefText;
  if (briefText.includes(ATTACHED_BRIEF_HEADER)) return briefText;
  return `${briefText}\n\n---\n\n${renderAttachedSection(files, opts)}`;
}
