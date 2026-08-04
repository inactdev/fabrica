// Task ids: `YYYYMMDD-<slug>-<2 random chars>` (SPEC.md "The record").
//
// Generating a candidate is cheap and can collide; claiming one cannot —
// registerTask (tasks.ts) turns a candidate into a guarantee by using the
// candidate as an exclusive directory name and retrying on collision, so
// two tasks registered in the same second never share an id no matter how
// unlucky the random suffix is.

import { randomInt } from "node:crypto";
import { RecordError } from "./errors.ts";

/** Matches the documented id shape, for callers that want to assert it. */
export const TASK_ID_PATTERN = /^\d{8}-[a-z0-9]+(?:-[a-z0-9]+)*-[a-z0-9]{2}$/;

const SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const MAX_ATTEMPTS = 100;

/** One `YYYYMMDD-<slug>-<2 random chars>` guess. May collide; see above. */
export function generateCandidateId(taskText: string, now: Date): string {
  return `${formatDate(now)}-${slugify(taskText)}-${randomSuffix()}`;
}

/**
 * Calls `claim(candidateId)` with fresh candidates until one succeeds
 * (returns true) or attempts are exhausted. `claim` is expected to be an
 * atomic exclusive operation (e.g. mkdir without `recursive`) so this is
 * safe under concurrent callers, not just concurrent calls in-process.
 */
export function claimTaskId(taskText: string, now: Date, claim: (id: string) => boolean): string {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const id = generateCandidateId(taskText, now);
    if (claim(id)) return id;
  }
  throw new RecordError(
    "id-exhausted",
    `Could not find a free task id after ${MAX_ATTEMPTS} attempts for "${taskText}". This should be ` +
      `effectively impossible; if it happens, something is claiming ids without going through claimTaskId.`
  );
}

function formatDate(now: Date): string {
  return now.toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * Lowercase, non-alphanumeric runs collapsed to a single `-`, trimmed,
 * capped at 40 characters. Falls back to "task" so the id shape always
 * holds even for a blank or entirely punctuation task text.
 */
function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "task";
}

function randomSuffix(): string {
  let suffix = "";
  for (let i = 0; i < 2; i++) {
    suffix += SUFFIX_ALPHABET[randomInt(0, SUFFIX_ALPHABET.length)];
  }
  return suffix;
}
