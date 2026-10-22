// A project's knowledge base: notes it names in projects.toml
// (`[projects.<name>.knowledge]`), read off the local disk and carried
// into every brief a Worker on that project receives, in full.
//
// Four decisions this file is built around, all from the Client's own
// clarification on the task that asked for it:
//
//   1. **Nothing is fetched.** The notes are files on this machine, read
//      as they are on disk at the moment a brief is built. There is no
//      network call here, and no copy kept in the record - a note
//      corrected between rounds is a note the next round reads
//      corrected.
//   2. **Bare names, flat.** `notes = ["worker-boxes"]` means
//      `<path>/notes/worker-boxes.md`. No subpaths; the name's shape is
//      refused by the config loader, not guessed at here.
//   3. **The heading is the note's own front-matter title**, rendered as
//      a second-level heading. A note with no title fails the task by
//      name, exactly the way a missing note does - a brief whose
//      sections are headed by file names would be a different document
//      than the one the Client asked for.
//   4. **Never trimmed.** A brief that would be too big with the notes
//      in is refused, naming the notes and the overage, rather than
//      handed over with half a note in it (the same ruling
//      `src/github`'s `MAX_ISSUE_BYTES` follows for an issue).

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { KnowledgeError } from "./errors.ts";

/** What this module reads the knowledge base through - structurally the
 * config's own `KnowledgeConfig` (src/config/types.ts), declared here as
 * what is actually needed so this module never depends on the registry
 * it happens to be configured from. `path` is absolute (the loader
 * resolves it against projects.toml's own directory). */
export interface KnowledgeSource {
  path: string;
  notes: string[];
}

/** One note, as a brief carries it. */
export interface KnowledgeNote {
  /** The bare name projects.toml named it by. */
  name: string;
  /** Its front-matter `title`, which becomes the section's heading. */
  title: string;
  /** Everything after the front matter, trimmed. Never shortened. */
  body: string;
}

/** The folder inside a knowledge base that notes are read from. The
 * knowledge base's own convention (`notes/README.md` in this repository
 * describes the same one), so it is not configurable: the setting names
 * the repository, and this is where notes live in it. */
export const NOTES_FOLDER = "notes";

/** The marker line a brief's knowledge section opens with. Also what
 * `withKnowledgeNotes` keys on, so a brief that already carries the
 * notes is never given them twice. */
export const KNOWLEDGE_BRIEF_HEADER =
  "Notes from this project's knowledge base, named in the project's own settings - their own words, in full:";

/**
 * The ceiling on a brief that carries knowledge notes: 256 KB of text,
 * four times `src/github`'s per-issue ceiling, since a brief holds the
 * task's own words, the issue it names and these notes together.
 *
 * It exists because of what the Client ruled about trimming: a note is
 * carried in full or not at all, so something has to say "this does not
 * fit" out loud instead of a Worker being handed a truncated brief and
 * nobody downstream knowing. Checked only where notes are added, which
 * is the only place that can name what to remove.
 */
export const MAX_BRIEF_BYTES = 256 * 1024;

/**
 * Every note this source names, in the order it names them.
 *
 * Throws `KnowledgeError` on the first thing that is wrong, naming it:
 * a knowledge base that isn't there or has no `notes/` folder
 * (`"no-knowledge-base"`), a note with no file or one nothing can read
 * (`"missing-note"`), a note with no front-matter title
 * (`"missing-note-title"`). Callers run this before any ProductionLine
 * is cut, so those refusals cost nothing but the reading.
 */
export function readKnowledgeNotes(source: KnowledgeSource): KnowledgeNote[] {
  if (source.notes.length === 0) return [];

  const folder = join(source.path, NOTES_FOLDER);
  if (!isDirectory(source.path)) {
    throw new KnowledgeError(
      "no-knowledge-base",
      `The knowledge base at ${source.path} is not there. Point [projects.<name>.knowledge].path at the ` +
        `knowledge base's own folder, or drop the notes it names.`
    );
  }
  if (!isDirectory(folder)) {
    throw new KnowledgeError(
      "no-knowledge-base",
      `The knowledge base at ${source.path} has no ${NOTES_FOLDER}/ folder, which is where its notes are read ` +
        `from.`
    );
  }

  return source.notes.map((name) => readNote(folder, name));
}

function readNote(folder: string, name: string): KnowledgeNote {
  const file = join(folder, `${name}.md`);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    throw new KnowledgeError(
      "missing-note",
      `The knowledge base has no readable note "${name}": ${file} ` +
        `(${(err as NodeJS.ErrnoException).code ?? "unreadable"}).`
    );
  }

  const title = frontMatterTitle(text);
  if (title === null) {
    throw new KnowledgeError(
      "missing-note-title",
      `The knowledge base note "${name}" (${file}) has no front-matter title, so there is no heading to put ` +
        `it under in a brief. Give it one: a "---" block at the top of the file with a title: line in it.`
    );
  }

  return { name, title, body: bodyAfterFrontMatter(text) };
}

/**
 * A note's front-matter `title`, or null when it has none.
 *
 * Deliberately a narrow reading rather than a YAML parse: only a `---`
 * block at the very top of the file, and only a `title:` key at its own
 * top level (no leading whitespace), so a `title` nested under some
 * other key is not mistaken for the note's own. One pair of surrounding
 * quotes is stripped, which is the one thing a title written in YAML's
 * quoted form needs.
 */
export function frontMatterTitle(text: string): string | null {
  const lines = frontMatterLines(text);
  if (lines === null) return null;
  for (const line of lines) {
    const match = /^title:[ \t]*(.*)$/.exec(line);
    if (match === null) continue;
    const value = unquote(match[1].trim());
    return value.length > 0 ? value : null;
  }
  return null;
}

/** Everything after the front matter, trimmed - the note's own words.
 * The front matter itself is left out: it is the note's metadata, and
 * its one load-bearing field is already the heading the body sits
 * under. A note with no front matter at all never gets this far. */
export function bodyAfterFrontMatter(text: string): string {
  const lines = text.split("\n");
  if (!isFenceLine(lines[0])) return text.trim();
  const end = lines.findIndex((line, index) => index > 0 && isFenceLine(line));
  if (end === -1) return text.trim();
  return lines.slice(end + 1).join("\n").trim();
}

/** The lines inside a leading `---` block, or null when the text does
 * not open with one (or opens with one that is never closed). */
function frontMatterLines(text: string): string[] | null {
  const lines = text.split("\n");
  if (!isFenceLine(lines[0])) return null;
  const end = lines.findIndex((line, index) => index > 0 && isFenceLine(line));
  if (end === -1) return null;
  return lines.slice(1, end);
}

function isFenceLine(line: string | undefined): boolean {
  return line !== undefined && line.trimEnd() === "---";
}

function unquote(value: string): string {
  const quoted = /^"(.*)"$|^'(.*)'$/.exec(value);
  return quoted === null ? value : (quoted[1] ?? quoted[2]);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The section a brief carries these notes as: the marker line, then
 * each note's title as a second-level heading with its own words under
 * it. Empty string for no notes. */
export function renderKnowledgeSection(notes: KnowledgeNote[]): string {
  if (notes.length === 0) return "";
  const sections = notes.map((note) => `## ${note.title}\n\n${note.body}`);
  return `${KNOWLEDGE_BRIEF_HEADER}\n\n${sections.join("\n\n")}\n`;
}

/**
 * `briefText` with these notes appended as their own section - after the
 * task's own words, and before the standing prefix that every brief is
 * handed to a Worker behind (src/foreman/standing-question.ts applies
 * that last, so the notes are inside what it prefixes).
 *
 * Idempotent, like `withIssueText`: a brief that already carries the
 * section comes back untouched, so a nested builder can never double it.
 *
 * Throws `KnowledgeError("brief-too-large")` rather than trim anything,
 * naming every note's size and how far over the ceiling the result
 * would be - the one message that can tell the Client what to take out.
 */
export function withKnowledgeNotes(briefText: string, notes: KnowledgeNote[]): string {
  if (notes.length === 0) return briefText;
  if (briefText.includes(KNOWLEDGE_BRIEF_HEADER)) return briefText;

  const full = `${briefText}\n\n---\n\n${renderKnowledgeSection(notes)}`;
  const bytes = Buffer.byteLength(full);
  if (bytes > MAX_BRIEF_BYTES) {
    const sizes = notes
      .map((note) => `"${note.name}" (${Buffer.byteLength(note.body)} bytes)`)
      .join(", ");
    throw new KnowledgeError(
      "brief-too-large",
      `The brief would be ${bytes} bytes with this project's knowledge notes in it, ` +
        `${bytes - MAX_BRIEF_BYTES} bytes past the ${MAX_BRIEF_BYTES}-byte ceiling for a brief. ` +
        `A note is carried in full or not at all, so nothing was shortened. The notes are ${sizes}; ` +
        `drop one from [projects.<name>.knowledge].notes, or shorten it where it lives.`
    );
  }
  return full;
}
