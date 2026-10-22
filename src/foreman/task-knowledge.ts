// The knowledge-base notes a project names in projects.toml, carried
// into every brief on that project - the Foreman's half of
// src/knowledge/.
//
// Two jobs, deliberately apart:
//
//   - `knowledgeNotesFor` reads the notes. Every caller runs it BEFORE
//     its ProductionLine is cut or reopened, which is what makes the
//     Client's ruling true: a missing knowledge base or a missing note
//     fails the task before any line exists, naming which.
//   - `withKnowledge` puts them in the brief, once the round's own words
//     are assembled. It is also where the brief's size ceiling is
//     enforced, since notes are never trimmed.
//
// Read fresh every round, and never written to the record. The issue a
// task names is the opposite - fetched once and frozen (task-issue.ts) -
// because it is the request itself, which must not change under a task.
// A knowledge note is not the request: it is what the project knows
// today, and a note corrected between rounds is a note the next round
// should read corrected. "The files are read from that path as they are
// on disk" is the Client's own wording for it.

import { KnowledgeError, readKnowledgeNotes, withKnowledgeNotes } from "../knowledge/index.ts";
import type { KnowledgeNote } from "../knowledge/index.ts";
import { registeredProject } from "./registered-project.ts";
import { ForemanError } from "./errors.ts";

/**
 * The knowledge notes every Worker on this project is handed, read off
 * the disk now. Empty for a project that is not registered, names no
 * knowledge base, or names one with no notes.
 *
 * Throws `ForemanError("knowledge-unavailable")` when the project does
 * name notes and they cannot be read - the knowledge base is not there,
 * has no `notes/` folder, a note has no file, or a note has no
 * front-matter title. The message is src/knowledge's own, which already
 * names the note and the file; callers run inside `recordingFailure`,
 * so it lands on the task's record as `task-failed` with that cause.
 */
export function knowledgeNotesFor(recordHome: string, projectPath: string): KnowledgeNote[] {
  const knowledge = registeredProject(recordHome, projectPath)?.knowledge;
  if (knowledge === undefined) return [];
  try {
    return readKnowledgeNotes(knowledge);
  } catch (err) {
    throw asForemanError(err);
  }
}

/**
 * `briefText` with those notes appended as their own section, after the
 * task's own words. Idempotent, and a no-op for no notes.
 *
 * Throws `ForemanError("knowledge-unavailable")` when the brief would be
 * past the ceiling with the notes in it (src/knowledge's
 * `MAX_BRIEF_BYTES`): nothing is ever shortened, so the message names
 * the notes and the overage instead.
 */
export function withKnowledge(briefText: string, notes: KnowledgeNote[]): string {
  try {
    return withKnowledgeNotes(briefText, notes);
  } catch (err) {
    throw asForemanError(err);
  }
}

/** src/knowledge's messages are already complete, actionable sentences
 * naming the note or the folder - carried verbatim, never restated or
 * softened, exactly as task-issue.ts carries src/github's. */
function asForemanError(err: unknown): unknown {
  if (!(err instanceof KnowledgeError)) return err;
  return new ForemanError("knowledge-unavailable", err.message);
}
