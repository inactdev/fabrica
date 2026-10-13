// Turns a worker's write-up (BrainWorkResult.writeup, structured data the
// brain returns - never parsed from its prose) into the commit message
// Fabrica writes onto the branch, and the pull request title/body
// Inspector is asked to open - the human write-up a reviewer reads, never
// the raw task text ("pull requests must read like a human wrote them").
// A missing or invalid write-up still gets a commit - the attempt loop
// commits every attempt and makes this one red (attempts.ts) - so this
// always returns something to commit, falling back to a label naming
// what is wrong rather than ever reaching for the task's own words.

import { WRITEUP_FIELDS, WRITEUP_TITLE_MAX_LENGTH } from "../brain/index.ts";
import type { WorkerWriteup } from "../brain/index.ts";

export interface FinalMessageForCommit {
  title: string;
  body: string;
  /** false when the write-up was missing or invalid - title/body are then
   * Fabrica's own fallback wording, naming what was wrong. */
  ok: boolean;
  /** Set when ok is false: what was wrong with the write-up. */
  reason?: string;
}

const SECTION_NAMES = { what: "What", why: "Why", how: "How", deviations: "Deviations" } as const;

/** Everything wrong with a write-up, as one clause - or undefined when it
 * is valid. */
export function writeupProblem(writeup: WorkerWriteup | undefined): string | undefined {
  if (writeup === undefined) return "the worker returned no write-up";
  const problems: string[] = [];
  for (const field of WRITEUP_FIELDS) {
    if (writeup[field].trim().length === 0) problems.push(`the ${field} field is empty`);
  }
  const title = writeup.title.trim();
  if (title.length > WRITEUP_TITLE_MAX_LENGTH) {
    problems.push(`the title is ${title.length} characters (at most ${WRITEUP_TITLE_MAX_LENGTH})`);
  }
  return problems.length > 0 ? problems.join("; ") : undefined;
}

/** What a red attempt, its receipt, and a failure report say. */
export function describeInvalidWriteup(reason: string): string {
  return `write-up invalid: ${reason}`;
}

export function finalMessageFor(writeup: WorkerWriteup | undefined, fallbackTitle: string): FinalMessageForCommit {
  const reason = writeupProblem(writeup);
  if (reason !== undefined || writeup === undefined) {
    return { title: fallbackTitle, body: `${describeInvalidWriteup(reason!)}.`, ok: false, reason };
  }
  const body = (["what", "why", "how", "deviations"] as const)
    .map((field) => `${SECTION_NAMES[field]}:\n${writeup[field].trim()}`)
    .join("\n\n");
  return { title: writeup.title.trim(), body, ok: true };
}

export function renderCommitMessage(message: FinalMessageForCommit): string {
  return `${message.title}\n\n${message.body}`;
}
