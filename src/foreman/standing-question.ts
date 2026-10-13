// CONTRACT rule 11 (Client ruling 2026-10-10): every brief Fabrica hands a
// worker begins with this question, put there by Fabrica's own code -
// never left to a file the model might or might not read.

export const STANDING_QUESTION =
  "Before you change anything: if your planned solution works, is it the best one, all things considered - " +
  "safest first, then most accurate, then fastest? Name one alternative you rejected and why. Write this down " +
  "before you start. You cannot and need not commit - leave your changes in the working tree; Fabrica commits " +
  "them. When your change calls an outside tool or service, read its current documentation before writing the " +
  "call; never guess a command or API shape. If you cannot reach the documentation from here, stop and ask " +
  "instead of guessing.";

/** Pull requests must read like a human wrote them: a worker returns its
 * write-up as a structured answer (BrainWorkResult.writeup) - title, what,
 * why, how, deviations - which Fabrica uses as the commit message and,
 * when Inspector is configured, the pull request title and body. It is
 * never parsed out of the worker's prose and never falls back to the
 * task's own words. A missing or invalid write-up makes the attempt red,
 * named back to the worker on the next attempt (see attempts.ts), so this
 * is stated as a requirement, not a suggestion. */
export const FINAL_MESSAGE_FORMAT_NOTICE =
  "When you finish, give your write-up as the structured answer you are asked for - five fields, which Fabrica " +
  "uses verbatim as the commit message and (when a pull request is opened) its title and body: title (your own " +
  "words, at most 60 characters, summarizing the change - never the task text itself), what, why, how, and " +
  'deviations (what you deviated from the request and why, or "None." if nothing). Every field is required and ' +
  "must not be empty. Do not type the write-up out as text; an attempt without a valid structured write-up is " +
  "not accepted as done.";

const STANDING_PREFIX = `${STANDING_QUESTION}\n\n${FINAL_MESSAGE_FORMAT_NOTICE}`;

/** `brief`, beginning with the standing question and the write-up
 * notice exactly once - applied by every brief builder and again
 * where the brief is handed over, so a builder nested inside another
 * never doubles it. */
export function withStandingQuestion(brief: string): string {
  return brief.startsWith(STANDING_PREFIX) ? brief : `${STANDING_PREFIX}\n\n${brief}`;
}
